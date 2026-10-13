"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";
import { Cloud, CloudCheck, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { DriveApi } from "./api";
import { connectDrive, getDriveToken } from "./auth";
import { syncProjectsWithDrive } from "./sync";

type SyncStatus = "idle" | "syncing" | "synced" | "conflict" | "error";

export function DriveSyncButton({
	compact = false,
	autoSync = false,
	protectedProjectId,
	onBeforeSync,
	onSynced,
}: {
	compact?: boolean;
	autoSync?: boolean;
	protectedProjectId?: string;
	onBeforeSync?: (quiet: boolean) => Promise<void> | void;
	onSynced?: () => Promise<void> | void;
}) {
	const clientId = process.env.NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID;
	const [scriptReady, setScriptReady] = useState(false);
	const [status, setStatus] = useState<SyncStatus>("idle");
	const busyRef = useRef(false);

	const sync = useCallback(async (quiet = false) => {
		if (busyRef.current) return;
		if (!clientId) {
			if (!quiet) toast.error("Configure o ID de cliente OAuth web para conectar o Google Drive.");
			return;
		}
		if (!scriptReady) {
			if (!quiet) toast.error("O login do Google ainda está carregando.");
			return;
		}
		let token = getDriveToken();
		if (!token && quiet) {
			setStatus("idle");
			return;
		}
		busyRef.current = true;
		setStatus("syncing");
		try {
			// A chamada do Google deve partir do clique para o navegador permitir o popup.
			if (!token) token = await connectDrive(clientId);
			await onBeforeSync?.(quiet);
			const result = await syncProjectsWithDrive(new DriveApi(token), { protectedProjectId });
			await onSynced?.();
			if (result.conflicts.length) {
				setStatus("conflict");
				toast.error("Há projetos com alterações nos dois aparelhos.", {
					description: result.conflicts.join(", "),
				});
			} else {
				setStatus("synced");
				if (!quiet) toast.success(`Drive atualizado: ${result.uploaded} enviado(s), ${result.downloaded} baixado(s).`);
			}
		} catch (error) {
			setStatus("error");
			toast.error("Não foi possível sincronizar com o Drive.", {
				description: error instanceof Error ? error.message : "Tente novamente.",
			});
		} finally {
			busyRef.current = false;
		}
	}, [clientId, onBeforeSync, onSynced, protectedProjectId, scriptReady]);

	useEffect(() => {
		if (!autoSync) return;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const onLocalChange = () => {
			if (!getDriveToken()) return;
			clearTimeout(timeout);
			timeout = setTimeout(() => void sync(true), 5000);
		};
		window.addEventListener("opencut:local-change", onLocalChange);
		return () => {
			window.removeEventListener("opencut:local-change", onLocalChange);
			clearTimeout(timeout);
		};
	}, [autoSync, sync]);

	const loadingLogin = Boolean(clientId && !scriptReady);
	const Icon = status === "syncing" || loadingLogin ? LoaderCircle : status === "synced" ? CloudCheck : Cloud;
	const label = loadingLogin ? "Carregando Drive" : status === "syncing" ? "Sincronizando" :
		status === "synced" ? "Sincronizado" :
		status === "conflict" ? "Conflito" :
		status === "error" ? "Erro no Drive" : "Sincronizar";

	return (
		<>
			{clientId && <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" onReady={() => setScriptReady(true)} />}
			<button
				type="button"
				className="flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
				onClick={() => void sync(false)}
				aria-label={label === "Sincronizado" ? "Sincronizar novamente com o Google Drive" : `${label} com o Google Drive`}
				title={clientId ? label : "Configuração do Google Drive pendente"}
				disabled={status === "syncing" || loadingLogin}
			>
				<Icon className={`size-4 ${status === "syncing" || loadingLogin ? "animate-spin" : ""}`} aria-hidden="true" />
				<span className={compact ? "hidden sm:inline" : "max-w-24 truncate"}>{label}</span>
			</button>
		</>
	);
}
