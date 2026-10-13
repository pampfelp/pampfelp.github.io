"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { EditorContent } from "./editor-content";

function EditorFromQuery() {
	const projectId = useSearchParams().get("project_id");
	if (!projectId) return <p>Projeto não encontrado.</p>;
	return <EditorContent projectId={projectId} />;
}

export default function EditorPage() {
	return (
		<Suspense fallback={<p>Carregando projeto...</p>}>
			<EditorFromQuery />
		</Suspense>
	);
}
