import { saveAs } from "file-saver";

import i18n from "@/i18n";
import { createZip } from "@/lib/zip";
import { fetchableMediaUrl } from "@/lib/media-url";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import type { CanvasExportAsset, CanvasExportFile } from "@/types/canvas-export";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export async function exportCanvasProjects(projects: CanvasProject[], fileName = i18n.t("canvas.export.defaultProjectName")) {
    const zipFiles: { name: string; data: BlobPart }[] = [];
    const exportedProjects = await Promise.all(
        projects.map(async (project) => {
            const files: CanvasExportAsset[] = [];
            await Promise.all(
                collectStorageKeys(project).map(async (storageKey) => {
                    const blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
                    if (!blob) return;
                    const path = `projects/${project.id}/files/${safeFileName(storageKey)}.${fileExtension(blob.type, storageKey)}`;
                    files.push({ storageKey, path, mimeType: blob.type || "application/octet-stream", bytes: blob.size });
                    zipFiles.push({ name: path, data: blob });
                }),
            );
            return { project, files };
        }),
    );

    const data: CanvasExportFile = { app: "infinite-canvas", version: 3, exportedAt: new Date().toISOString(), projects: exportedProjects };
    const zip = await createZip([{ name: "projects.json", data: JSON.stringify(data, null, 2) }, ...zipFiles]);
    saveAs(zip, `${safeFileName(fileName)}.zip`);
}

export async function exportCanvasNodes(nodes: CanvasNodeData[], fileName = i18n.t("canvas.export.defaultNodesName")) {
    const zipFiles: { name: string; data: BlobPart }[] = [];
    const used = new Set<string>();
    const uniqueName = (base: string, ext: string) => {
        const safe = safeFileName(base) || i18n.t("canvas.export.item");
        let name = `${safe}.${ext}`;
        for (let i = 1; used.has(name); i += 1) name = `${safe}-${i}.${ext}`;
        used.add(name);
        return name;
    };

    await Promise.all(
        nodes.map(async (node) => {
            const title = node.title || node.type;
            const storageKey = node.metadata?.storageKey || "";
            if (storageKey) {
                const blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
                if (blob) return void zipFiles.push({ name: uniqueName(title, fileExtension(blob.type, storageKey)), data: blob });
            }
            if (node.type === CanvasNodeType.Text) return void zipFiles.push({ name: uniqueName(title, "txt"), data: node.metadata?.content || node.metadata?.prompt || "" });
            const content = node.metadata?.content;
            if (content && content.startsWith("data:")) {
                const blob = await (await fetch(content)).blob();
                return void zipFiles.push({ name: uniqueName(title, fileExtension(blob.type, storageKey)), data: blob });
            }
            zipFiles.push({ name: uniqueName(title, "json"), data: JSON.stringify(node, null, 2) });
        }),
    );

    const zip = await createZip(zipFiles);
    saveAs(zip, `${safeFileName(fileName)}.zip`);
}

export function isExportableVideoNode(node: CanvasNodeData) {
    return node.type === CanvasNodeType.Video && Boolean(node.metadata?.storageKey || node.metadata?.content);
}

export async function exportCanvasVideos(nodes: CanvasNodeData[], fileName: string) {
    const failed: string[] = [];
    const videos = nodes.filter(isExportableVideoNode);
    const results = await Promise.all(videos.map(async (node, index) => {
        const title = node.title.trim() || i18n.t("canvas.projectPage.canvasVideo");
        try {
            const storageKey = node.metadata?.storageKey || "";
            let blob = storageKey ? await getMediaBlob(storageKey) : null;
            if (!blob) {
                const content = node.metadata?.content;
                if (!content) throw new Error(i18n.t("canvas.export.videoUnavailable"));
                const response = await fetch(fetchableMediaUrl(content));
                if (!response.ok) throw new Error(String(response.status));
                blob = await response.blob();
            }
            if (!blob.size || (blob.type && !blob.type.startsWith("video/") && blob.type !== "application/octet-stream")) throw new Error(i18n.t("canvas.export.videoUnavailable"));
            const mimeType = blob.type.startsWith("video/") ? blob.type : node.metadata?.mimeType || "video/mp4";
            const ext = fileExtension(mimeType, storageKey);
            const name = `${String(index + 1).padStart(3, "0")}-${safeFileName(title.replace(/\.(mp4|webm|mov|mkv|avi|m4v|mpeg|mpg)$/i, ""))}.${ext}`;
            return { name, data: blob };
        } catch {
            failed.push(title);
            return null;
        }
    }));
    const files = results.filter((file): file is { name: string; data: Blob } => file !== null);
    if (files.length) saveAs(await createZip(files), `${safeFileName(fileName)}.zip`);
    return { exported: files.length, failed };
}

export function collectStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return [...keys];
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectStorageKeys(child, keys)) : collectStorageKeys(item, keys)));
    return [...keys];
}

export function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}

export function fileExtension(mimeType: string, storageKey: string) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("quicktime")) return "mov";
    if (mimeType.includes("matroska")) return "mkv";
    if (mimeType.includes("msvideo")) return "avi";
    if (mimeType.includes("m4v")) return "m4v";
    if (mimeType === "video/mpeg") return "mpeg";
    if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
    if (mimeType.includes("wav")) return "wav";
    if (mimeType.includes("ogg")) return "ogg";
    return storageKey.startsWith("image:") ? "png" : "bin";
}
