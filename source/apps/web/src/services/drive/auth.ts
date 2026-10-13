export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

interface TokenResponse {
	access_token?: string;
	expires_in?: number;
	error?: string;
}

interface TokenClient {
	requestAccessToken(config?: { prompt?: string }): void;
}

interface GoogleIdentity {
	accounts: {
		oauth2: {
			initTokenClient(config: {
				client_id: string;
				scope: string;
				callback: (response: TokenResponse) => void;
				error_callback?: (error: { type: string }) => void;
			}): TokenClient;
			hasGrantedAllScopes(response: TokenResponse, ...scopes: string[]): boolean;
		};
	};
}

declare global {
	interface Window {
		google?: GoogleIdentity;
	}
}

let accessToken: string | null = null;
let expiresAt = 0;

export function getDriveToken(): string | null {
	return accessToken && Date.now() < expiresAt - 30_000 ? accessToken : null;
}

export function clearDriveToken(): void {
	accessToken = null;
	expiresAt = 0;
}

export function connectDrive(clientId: string): Promise<string> {
	if (!clientId.endsWith(".apps.googleusercontent.com")) {
		throw new Error("Configure o ID de cliente OAuth web do Google Drive.");
	}
	const oauth = window.google?.accounts.oauth2;
	if (!oauth) {
		throw new Error("O login do Google ainda não carregou. Tente novamente.");
	}
	return new Promise((resolve, reject) => {
		const client = oauth.initTokenClient({
			client_id: clientId,
			scope: DRIVE_SCOPE,
			callback: (response) => {
				if (
					!response.access_token ||
					!oauth.hasGrantedAllScopes(response, DRIVE_SCOPE)
				) {
					reject(new Error(response.error || "Acesso ao Google Drive não autorizado."));
					return;
				}
				accessToken = response.access_token;
				expiresAt = Date.now() + (response.expires_in ?? 3600) * 1000;
				resolve(accessToken);
			},
			error_callback: (error) => {
				reject(new Error(error.type === "popup_closed"
					? "O login do Google foi fechado antes da autorização."
					: "Não foi possível abrir o login do Google."));
			},
		});
		client.requestAccessToken({ prompt: "" });
	});
}
