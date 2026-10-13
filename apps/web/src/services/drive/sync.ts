import { storageService } from "@/services/storage/service";
import type { MediaAssetData, SerializedProject } from "@/services/storage/types";
import { DriveApi, type DriveFile } from "./api";

const ROOT_FOLDER_NAME = "OpenCut Pessoal";
const MANIFEST_NAME = "project.json";
const SYNC_STATE_PREFIX = "opencut-personal-drive-sync-v1";
const DELETED_PROJECTS_KEY = "opencut-personal-drive-deleted-v1";

interface SyncedAsset {
	metadata: MediaAssetData;
	fileId: string;
	mimeType: string;
}

interface ProjectManifest {
	version: 1;
	project: SerializedProject;
	assets: SyncedAsset[];
}

interface SyncBaseline {
	projectHash: string;
}

export interface SyncResult {
	uploaded: number;
	downloaded: number;
	conflicts: string[];
}

function validateManifest(raw: unknown, projectId: string): ProjectManifest {
	if (!raw || typeof raw !== "object") throw new Error("Manifesto do projeto inválido no Drive.");
	const manifest = raw as Partial<ProjectManifest>;
	if (
		manifest.version !== 1 ||
		manifest.project?.metadata?.id !== projectId ||
		!Array.isArray(manifest.project.scenes) ||
		!Array.isArray(manifest.assets) ||
		manifest.assets.some((asset) => !asset?.fileId || !asset?.metadata?.id)
	) {
		throw new Error(`Projeto ${projectId} está incompleto no Drive.`);
	}
	return manifest as ProjectManifest;
}

async function hashProject(project: SerializedProject, assets: MediaAssetData[]): Promise<string> {
	const sortedAssets = assets.filter((asset) => !asset.ephemeral)
		.map(normalizeMediaMetadata).sort((a, b) => a.id.localeCompare(b.id));
	const input = new TextEncoder().encode(JSON.stringify({ project, assets: sortedAssets }));
	const digest = await crypto.subtle.digest("SHA-256", input);
	return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function baselineKey(rootId: string, projectId: string): string {
	return `${SYNC_STATE_PREFIX}:${rootId}:${projectId}`;
}

function readBaseline(rootId: string, projectId: string): SyncBaseline | null {
	try {
		const saved = localStorage.getItem(baselineKey(rootId, projectId));
		if (!saved) return null;
		const parsed = JSON.parse(saved) as Partial<SyncBaseline>;
		return typeof parsed.projectHash === "string" ? { projectHash: parsed.projectHash } : null;
	} catch {
		return null;
	}
}

function saveBaseline(rootId: string, projectId: string, projectHash: string): void {
	localStorage.setItem(baselineKey(rootId, projectId), JSON.stringify({ projectHash }));
}

function readDeletedProjectIds(): Set<string> {
	try {
		const saved = JSON.parse(localStorage.getItem(DELETED_PROJECTS_KEY) ?? "[]");
		return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : []);
	} catch {
		return new Set();
	}
}

function normalizeMediaMetadata(asset: MediaAssetData): MediaAssetData {
	if (!asset.thumbnailUrl?.startsWith("blob:")) return asset;
	const { thumbnailUrl: _thumbnailUrl, ...persistent } = asset;
	return persistent;
}

async function readRemoteManifest(
	api: DriveApi,
	projectFolder: DriveFile,
	projectId: string,
): Promise<{ file: DriveFile; manifest: ProjectManifest } | null> {
	const file = (await api.listChildren(projectFolder.id)).find(
		(candidate) => candidate.name === MANIFEST_NAME,
	);
	if (!file) return null;
	const json = await (await api.download(file.id)).text();
	return { file, manifest: validateManifest(JSON.parse(json), projectId) };
}

async function uploadProject(
	api: DriveApi,
	projectFolder: DriveFile,
	project: SerializedProject,
	previous: { file: DriveFile; manifest: ProjectManifest } | null,
): Promise<void> {
	const projectId = project.metadata.id;
	const existingAssets = new Map(previous?.manifest.assets.map((asset) => [asset.metadata.id, asset]));
	const assets = await storageService.loadAllMediaAssets({ projectId });
	const storedMetadata = new Map((await storageService.loadAllMediaAssetsMetadata({ projectId }))
		.map((metadata) => [metadata.id, metadata]));
	const uploadedAssets: SyncedAsset[] = [];
	for (const asset of assets.filter((item) => !item.ephemeral)) {
		const metadata = storedMetadata.get(asset.id);
		if (!metadata) throw new Error(`Metadados ausentes para ${asset.name}.`);
		const existing = existingAssets.get(asset.id);
		const unchanged = existing &&
			existing.metadata.size === metadata.size &&
			existing.metadata.lastModified === metadata.lastModified;
		const file = unchanged
			? { id: existing.fileId }
			: await api.upload({
				name: `asset-${asset.id}`,
				parentId: projectFolder.id,
				content: asset.file,
				fileId: existing?.fileId,
			});
		uploadedAssets.push({
			metadata: normalizeMediaMetadata(metadata),
			fileId: file.id,
			mimeType: metadata.mimeType || asset.file.type || "application/octet-stream",
		});
	}
	const manifest: ProjectManifest = { version: 1, project, assets: uploadedAssets };
	await api.upload({
		name: MANIFEST_NAME,
		parentId: projectFolder.id,
		content: new Blob([JSON.stringify(manifest)], { type: "application/json" }),
		fileId: previous?.file.id,
	});
}

async function downloadProject(api: DriveApi, manifest: ProjectManifest): Promise<void> {
	const projectId = manifest.project.metadata.id;
	for (const asset of manifest.assets) {
		const local = await storageService.loadMediaAsset({ projectId, id: asset.metadata.id });
		if (
			local?.file.size === asset.metadata.size &&
			local.file.lastModified === asset.metadata.lastModified
		) continue;
		const blob = await api.download(asset.fileId);
		if (blob.size !== asset.metadata.size) {
			throw new Error(`Arquivo ${asset.metadata.name} foi baixado incompleto.`);
		}
		const file = new File([blob], asset.metadata.name, {
			type: asset.mimeType,
			lastModified: asset.metadata.lastModified,
		});
		await storageService.saveMediaAsset({
			projectId,
			mediaAsset: { ...asset.metadata, file },
		});
	}
	await storageService.importSerializedProject({ project: manifest.project });
}

export async function syncProjectsWithDrive(
	api: DriveApi,
	{ protectedProjectId }: { protectedProjectId?: string } = {},
): Promise<SyncResult> {
	const root = await api.ensureFolder(ROOT_FOLDER_NAME);
	const remoteFolders = new Map(
		(await api.listChildren(root.id))
			.filter((file) => file.mimeType === "application/vnd.google-apps.folder" && file.name.startsWith("project-"))
			.map((file) => [file.name.slice("project-".length), file]),
	);
	const localProjects = await storageService.loadAllProjectsMetadata();
	const localIds = new Set(localProjects.map((project) => project.id));
	const deletedIds = readDeletedProjectIds();
	const projectIds = new Set([...localIds, ...remoteFolders.keys(), ...deletedIds]);
	const result: SyncResult = { uploaded: 0, downloaded: 0, conflicts: [] };

	for (const projectId of projectIds) {
		if (deletedIds.has(projectId) && !localIds.has(projectId)) {
			const deletedFolder = remoteFolders.get(projectId);
			if (deletedFolder) {
				const remote = await readRemoteManifest(api, deletedFolder, projectId);
				const baseline = readBaseline(root.id, projectId)?.projectHash;
				const remoteHash = remote && await hashProject(
					remote.manifest.project,
					remote.manifest.assets.map((asset) => asset.metadata),
				);
				if (!baseline || (remoteHash && remoteHash !== baseline)) {
					result.conflicts.push(remote?.manifest.project.metadata.name ?? projectId);
					continue;
				}
				await api.moveToTrash(deletedFolder.id);
			}
			deletedIds.delete(projectId);
			localStorage.setItem(DELETED_PROJECTS_KEY, JSON.stringify([...deletedIds]));
			continue;
		}
		const local = localIds.has(projectId)
			? await storageService.exportSerializedProject({ id: projectId })
			: null;
		let folder = remoteFolders.get(projectId);
		if (!folder && local) folder = await api.ensureFolder(`project-${projectId}`, root.id);
		if (!folder) continue;
		const remote = await readRemoteManifest(api, folder, projectId);
		if (local && !remote) {
			await uploadProject(api, folder, local, null);
			saveBaseline(root.id, projectId, await hashProject(local, await storageService.loadAllMediaAssetsMetadata({ projectId })));
			result.uploaded++;
			continue;
		}
		if (!local && remote) {
			await downloadProject(api, remote.manifest);
			saveBaseline(root.id, projectId, await hashProject(remote.manifest.project, remote.manifest.assets.map((asset) => asset.metadata)));
			result.downloaded++;
			continue;
		}
		if (!local || !remote) continue;
		const localHash = await hashProject(local, await storageService.loadAllMediaAssetsMetadata({ projectId }));
		const remoteHash = await hashProject(remote.manifest.project, remote.manifest.assets.map((asset) => asset.metadata));
		if (localHash === remoteHash) {
			saveBaseline(root.id, projectId, localHash);
			continue;
		}
		const baseline = readBaseline(root.id, projectId)?.projectHash;
		if (baseline === remoteHash) {
			await uploadProject(api, folder, local, remote);
			saveBaseline(root.id, projectId, localHash);
			result.uploaded++;
		} else if (baseline === localHash && protectedProjectId !== projectId) {
			await downloadProject(api, remote.manifest);
			saveBaseline(root.id, projectId, remoteHash);
			result.downloaded++;
		} else {
			result.conflicts.push(local.metadata.name);
		}
	}
	return result;
}
