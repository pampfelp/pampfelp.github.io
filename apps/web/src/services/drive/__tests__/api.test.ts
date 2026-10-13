import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DriveApi } from "../api.ts";

test("lista todas as páginas da pasta usando o token OAuth", async () => {
	const calls: URL[] = [];
	const request = async (input: string | URL | Request, init?: RequestInit) => {
		assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer token-de-teste");
		const url = new URL(String(input));
		calls.push(url);
		return Response.json(calls.length === 1
			? { files: [{ id: "a", name: "a", mimeType: "text/plain" }], nextPageToken: "next" }
			: { files: [{ id: "b", name: "b", mimeType: "text/plain" }] });
	};
	const files = await new DriveApi("token-de-teste", request as typeof fetch).listChildren("root");
	assert.deepEqual(files.map((file) => file.id), ["a", "b"]);
	assert.equal(calls[1].searchParams.get("pageToken"), "next");
});

test("envia vídeo em blocos e confirma o último bloco antes de retornar", async () => {
	const ranges: string[] = [];
	const session = "https://www.googleapis.com/upload/drive/v3/files?upload_id=test";
	const request = async (input: string | URL | Request, init?: RequestInit) => {
		if (String(input).includes("uploadType=resumable")) {
			return new Response(null, { status: 200, headers: { Location: session } });
		}
		assert.equal(String(input), session);
		const range = new Headers(init?.headers).get("Content-Range") ?? "";
		ranges.push(range);
		return ranges.length === 1
			? new Response(null, { status: 308, headers: { Range: "bytes=0-8388607" } })
			: Response.json({ id: "video-id", name: "video.mp4", mimeType: "video/mp4" });
	};
	const blob = new Blob([new Uint8Array(8 * 1024 * 1024 + 3)], { type: "video/mp4" });
	const file = await new DriveApi("token-de-teste", request as typeof fetch).upload({
		name: "video.mp4", parentId: "folder-id", content: blob,
	});
	assert.equal(file.id, "video-id");
	assert.deepEqual(ranges, ["bytes 0-8388607/8388611", "bytes 8388608-8388610/8388611"]);
});
