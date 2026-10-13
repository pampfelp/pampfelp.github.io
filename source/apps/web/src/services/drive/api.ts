export interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	modifiedTime?: string;
	size?: string;
}

const FILES_URL = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const CHUNK_SIZE = 8 * 1024 * 1024;
type DriveFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class DriveHttpError extends Error {
	constructor(public readonly status: number, operation: string) {
		super(`Google Drive: ${operation} falhou (HTTP ${status}).`);
	}
}

function quoteQuery(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

export class DriveApi {
	constructor(
		private readonly token: string,
		private readonly request: DriveFetch = (input, init) => fetch(input, init),
	) {}

	private async fetchAuthorized(
		url: string,
		init: RequestInit,
		operation: string,
	): Promise<Response> {
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Bearer ${this.token}`);
		const response = await this.request(url, { ...init, headers });
		if (!response.ok && response.status !== 308) {
			throw new DriveHttpError(response.status, operation);
		}
		return response;
	}

	async listChildren(parentId: string): Promise<DriveFile[]> {
		const files: DriveFile[] = [];
		let pageToken: string | undefined;
		do {
			const url = new URL(FILES_URL);
			url.searchParams.set("q", `'${quoteQuery(parentId)}' in parents and trashed = false`);
			url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,modifiedTime,size)");
			url.searchParams.set("pageSize", "1000");
			if (pageToken) url.searchParams.set("pageToken", pageToken);
			const response = await this.fetchAuthorized(url.toString(), {}, "listar arquivos");
			const body = (await response.json()) as { files?: DriveFile[]; nextPageToken?: string };
			files.push(...(body.files ?? []));
			pageToken = body.nextPageToken;
		} while (pageToken);
		return files;
	}

	async ensureFolder(name: string, parentId = "root"): Promise<DriveFile> {
		const existing = (await this.listChildren(parentId)).find(
			(file) => file.name === name && file.mimeType === FOLDER_MIME,
		);
		if (existing) return existing;
		const response = await this.fetchAuthorized(
			`${FILES_URL}?fields=id,name,mimeType`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
			},
			"criar pasta",
		);
		return (await response.json()) as DriveFile;
	}

	async download(id: string): Promise<Blob> {
		const response = await this.fetchAuthorized(
			`${FILES_URL}/${encodeURIComponent(id)}?alt=media`,
			{},
			"baixar arquivo",
		);
		return response.blob();
	}

	async moveToTrash(id: string): Promise<void> {
		await this.fetchAuthorized(
			`${FILES_URL}/${encodeURIComponent(id)}?fields=id,trashed`,
			{
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ trashed: true }),
			},
			"mover projeto para a lixeira",
		);
	}

	async upload({
		name,
		parentId,
		content,
		fileId,
		onProgress,
	}: {
		name: string;
		parentId: string;
		content: Blob;
		fileId?: string;
		onProgress?: (sentBytes: number, totalBytes: number) => void;
	}): Promise<DriveFile> {
		const mimeType = content.type || "application/octet-stream";
		const endpoint = fileId
			? `${UPLOAD_URL}/${encodeURIComponent(fileId)}?uploadType=resumable&fields=id,name,mimeType,modifiedTime,size`
			: `${UPLOAD_URL}?uploadType=resumable&fields=id,name,mimeType,modifiedTime,size`;
		const response = await this.fetchAuthorized(
			endpoint,
			{
				method: fileId ? "PATCH" : "POST",
				headers: {
					"Content-Type": "application/json; charset=UTF-8",
					"X-Upload-Content-Type": mimeType,
					"X-Upload-Content-Length": String(content.size),
				},
				body: JSON.stringify(fileId ? { name, mimeType } : { name, mimeType, parents: [parentId] }),
			},
			"iniciar envio",
		);
		const sessionUrl = response.headers.get("Location");
		if (!sessionUrl || !sessionUrl.startsWith("https://www.googleapis.com/upload/")) {
			throw new Error("O Google Drive não retornou uma sessão de envio válida.");
		}
		let offset = 0;
		let stalledAttempts = 0;
		while (offset < content.size || (content.size === 0 && offset === 0)) {
			const end = Math.min(offset + CHUNK_SIZE, content.size);
			const chunk = content.slice(offset, end);
			let chunkResponse: Response;
			try {
				chunkResponse = await this.fetchAuthorized(
					sessionUrl,
					{
						method: "PUT",
						headers: {
							"Content-Range": content.size === 0
								? "bytes */0"
								: `bytes ${offset}-${end - 1}/${content.size}`,
						},
						body: chunk,
					},
					"enviar arquivo",
				);
			} catch (error) {
				if (error instanceof DriveHttpError && error.status < 500 && error.status !== 429) throw error;
				const status = await this.fetchAuthorized(
					sessionUrl,
					{ method: "PUT", headers: { "Content-Range": `bytes */${content.size}` } },
					"retomar envio",
				);
				if (status.status !== 308) return (await status.json()) as DriveFile;
				const received = status.headers.get("Range")?.match(/bytes=0-(\d+)/);
				const nextOffset = received ? Number(received[1]) + 1 : 0;
				stalledAttempts = nextOffset > offset ? 0 : stalledAttempts + 1;
				if (stalledAttempts >= 3) throw new Error("O envio ao Google Drive não avançou após três tentativas.");
				offset = nextOffset;
				await new Promise((resolve) => setTimeout(resolve, 500 * stalledAttempts));
				continue;
			}
			if (chunkResponse.status !== 308) {
				onProgress?.(content.size, content.size);
				return (await chunkResponse.json()) as DriveFile;
			}
			const received = chunkResponse.headers.get("Range")?.match(/bytes=0-(\d+)/);
			const nextOffset = received ? Number(received[1]) + 1 : 0;
			stalledAttempts = nextOffset > offset ? 0 : stalledAttempts + 1;
			if (stalledAttempts >= 3) throw new Error("O envio ao Google Drive não avançou após três tentativas.");
			offset = nextOffset;
			onProgress?.(offset, content.size);
		}
		throw new Error("O envio ao Google Drive terminou sem confirmação.");
	}
}
