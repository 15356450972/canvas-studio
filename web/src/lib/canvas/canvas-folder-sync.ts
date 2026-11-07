import localforage from "localforage";

import { collectStorageKeys, fileExtension, safeFileName } from "@/lib/canvas/canvas-export";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasExportAsset, CanvasExportFile } from "@/types/canvas-export";

// File System Access API 的权限方法还没进 TS DOM 类型，这里只补用到的部分。
type PermissionedDirectory = FileSystemDirectoryHandle & {
    queryPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
    requestPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
};

/** 授权的目录句柄和「项目 id → 子文件夹名」，子文件夹名首次保存后固定，改项目名不会多出新文件夹。 */
export type CanvasFolder = { handle: PermissionedDirectory; folders: Record<string, string> };

const folderStore = localforage.createInstance({ name: "infinite-canvas", storeName: "canvas_folder" });
const FOLDER_KEY = "folder";

export function supportsCanvasFolder() {
    return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

export async function pickCanvasFolder(): Promise<CanvasFolder> {
    const handle = await (window as unknown as { showDirectoryPicker(options: { mode: "readwrite"; id: string }): Promise<PermissionedDirectory> }).showDirectoryPicker({ mode: "readwrite", id: "infinite-canvas-projects" });
    return { handle, folders: {} };
}

export async function readCanvasFolder() {
    return (await folderStore.getItem<CanvasFolder>(FOLDER_KEY)) || null;
}

export async function saveCanvasFolder(folder: CanvasFolder | null) {
    if (folder) await folderStore.setItem(FOLDER_KEY, folder);
    else await folderStore.removeItem(FOLDER_KEY);
}

/** 只查询不弹窗；request 必须在用户点击里调用。 */
export async function canvasFolderPermission(folder: CanvasFolder, request = false) {
    const options = { mode: "readwrite" } as const;
    const state = await folder.handle.queryPermission(options);
    return state === "granted" || !request ? state : folder.handle.requestPermission(options);
}

async function writeFile(directory: FileSystemDirectoryHandle, name: string, data: Blob | string) {
    const writable = await (await directory.getFileHandle(name, { create: true })).createWritable();
    try {
        await writable.write(data);
    } finally {
        await writable.close();
    }
}

async function hasFile(directory: FileSystemDirectoryHandle, name: string) {
    try {
        await directory.getFileHandle(name);
        return true;
    } catch {
        return false;
    }
}

/** 每个项目一个子文件夹：projects.json 与导出 zip 同格式，媒体放 files/，已存在的媒体文件不重复写。 */
export async function writeCanvasProject(folder: CanvasFolder, project: CanvasProject) {
    const folderName = (folder.folders[project.id] ||= `${safeFileName(project.title || "canvas").trim() || "canvas"}-${project.id.slice(0, 6)}`);
    const projectDir = await folder.handle.getDirectoryHandle(folderName, { create: true });
    const filesDir = await projectDir.getDirectoryHandle("files", { create: true });
    const files: CanvasExportAsset[] = [];
    for (const storageKey of collectStorageKeys(project)) {
        const blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
        if (!blob) continue;
        const name = `${safeFileName(storageKey)}.${fileExtension(blob.type, storageKey)}`;
        if (!(await hasFile(filesDir, name))) await writeFile(filesDir, name, blob);
        files.push({ storageKey, path: `files/${name}`, mimeType: blob.type || "application/octet-stream", bytes: blob.size });
    }
    const data: CanvasExportFile = { app: "infinite-canvas", version: 3, exportedAt: new Date().toISOString(), projects: [{ project, files }] };
    await writeFile(projectDir, "projects.json", JSON.stringify(data, null, 2));
}
