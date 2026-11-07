import { create } from "zustand";

import { canvasFolderPermission, pickCanvasFolder, readCanvasFolder, saveCanvasFolder, supportsCanvasFolder, writeCanvasProject, type CanvasFolder } from "@/lib/canvas/canvas-folder-sync";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

export type CanvasFolderStatus = "unsupported" | "off" | "needs-permission" | "saving" | "saved" | "error";

type CanvasFolderStore = {
    status: CanvasFolderStatus;
    folderName: string;
    lastSavedAt: string;
    error: string;
    load: () => Promise<void>;
    pickFolder: () => Promise<void>;
    saveNow: () => Promise<void>;
    disable: () => Promise<void>;
};

let folder: CanvasFolder | null | undefined;
let pending: CanvasProject[] | null = null;
let running: Promise<void> | null = null;
// 项目 id → 已写入文件夹的 updatedAt，只重写有变化的项目。
const written = new Map<string, string>();

async function currentFolder() {
    if (folder === undefined) folder = await readCanvasFolder();
    return folder;
}

async function currentProjects() {
    const { useCanvasStore } = await import("@/stores/canvas/use-canvas-store");
    return useCanvasStore.getState().projects;
}

async function drain() {
    while (pending) {
        const projects = pending;
        pending = null;
        const target = await currentFolder();
        if (!target) return;
        if ((await canvasFolderPermission(target)) !== "granted") return void useCanvasFolderStore.setState({ status: "needs-permission" });
        const changed = projects.filter((project) => written.get(project.id) !== project.updatedAt);
        if (!changed.length) continue;
        useCanvasFolderStore.setState({ status: "saving", error: "" });
        try {
            for (const project of changed) {
                await writeCanvasProject(target, project);
                written.set(project.id, project.updatedAt);
            }
            await saveCanvasFolder(target);
            useCanvasFolderStore.setState({ status: "saved", lastSavedAt: new Date().toISOString() });
        } catch (error) {
            useCanvasFolderStore.setState({ status: "error", error: error instanceof Error ? error.message : String(error) });
        }
    }
}

/** 画布本地保存完成后调用，把有变化的项目同步写入已授权的文件夹。 */
export function saveCanvasProjectsToFolder(projects: CanvasProject[]) {
    if (!supportsCanvasFolder()) return;
    pending = projects;
    running ||= drain().finally(() => {
        running = null;
        if (pending) saveCanvasProjectsToFolder(pending);
    });
}

export const useCanvasFolderStore = create<CanvasFolderStore>()((set) => ({
    status: supportsCanvasFolder() ? "off" : "unsupported",
    folderName: "",
    lastSavedAt: "",
    error: "",
    load: async () => {
        if (!supportsCanvasFolder()) return;
        const target = await currentFolder();
        if (!target) return set({ status: "off", folderName: "" });
        const permission = await canvasFolderPermission(target);
        set((state) => ({ folderName: target.handle.name, status: permission !== "granted" ? "needs-permission" : state.status === "off" ? "saved" : state.status }));
    },
    pickFolder: async () => {
        try {
            folder = await pickCanvasFolder();
        } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") return;
            throw error;
        }
        written.clear();
        await saveCanvasFolder(folder);
        set({ folderName: folder.handle.name, error: "" });
        saveCanvasProjectsToFolder(await currentProjects());
    },
    saveNow: async () => {
        const target = await currentFolder();
        if (!target) return;
        if ((await canvasFolderPermission(target, true)) !== "granted") return set({ status: "needs-permission" });
        written.clear();
        saveCanvasProjectsToFolder(await currentProjects());
    },
    disable: async () => {
        folder = null;
        pending = null;
        written.clear();
        await saveCanvasFolder(null);
        set({ status: "off", folderName: "", lastSavedAt: "", error: "" });
    },
}));
