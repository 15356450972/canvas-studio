import { create } from "zustand";
import dayjs from "dayjs";

import { fileExtension } from "@/lib/canvas/canvas-export";
import { clearVideoFolder, isDesktop, pickVideoFolder, readVideoFolder, writeVideoFile } from "@/services/desktop";

type VideoFolderState = {
    path: string;
    lastSavedAt: string;
    error: string;
    load: () => Promise<void>;
    pick: () => Promise<void>;
    disable: () => Promise<void>;
};

export const useVideoFolderStore = create<VideoFolderState>()((set) => ({
    path: "",
    lastSavedAt: "",
    error: "",
    load: async () => {
        if (isDesktop) set({ path: await readVideoFolder() });
    },
    pick: async () => set({ path: await pickVideoFolder(), error: "" }),
    disable: async () => set({ path: await clearVideoFolder(), lastSavedAt: "", error: "" }),
}));

export async function saveGeneratedVideoToFolder(blob: Blob) {
    if (!isDesktop) return;
    try {
        const path = await readVideoFolder();
        useVideoFolderStore.setState({ path });
        if (!path) return;
        const name = `${dayjs().format("YYYYMMDD-HHmmss")}.${fileExtension(blob.type, "video:")}`;
        await writeVideoFile(name, blob);
        useVideoFolderStore.setState({ lastSavedAt: new Date().toISOString(), error: "" });
    } catch (error) {
        useVideoFolderStore.setState({ error: error instanceof Error ? error.message : String(error) });
    }
}