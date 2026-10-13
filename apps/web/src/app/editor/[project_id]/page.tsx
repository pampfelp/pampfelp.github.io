"use client";

import { useParams } from "next/navigation";
import { EditorContent } from "../editor-content";

export default function Editor() {
	const { project_id } = useParams<{ project_id: string }>();
	return <EditorContent projectId={project_id} />;
}
