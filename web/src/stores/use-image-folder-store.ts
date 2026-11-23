import { create } from "zustand";

import { fileExtension, safeFileName } from "@/lib/canvas/canvas-export";
import { clearImageFolder, isDesktop, pickImageFolder, readImageFolder, writeImageFile } from "@/services/desktop";

type ImageFolderStore = {
    path: string;
    lastSavedAt: string;
    error: string;
    load: () => Promise<void>;
    pick: () => Promise<void>;
    disable: () => Promise<void>;
};

export const useImageFolderStore = create<ImageFolderStore>()((set) => ({
    path: "",
    lastSavedAt: "",
    error: "",
    load: async () => {
        if (isDesktop) set({ path: await readImageFolder() });
    },
    pick: async () => set({ path: await pickImageFolder(), error: "" }),
    disable: async () => set({ path: await clearImageFolder(), lastSavedAt: "", error: "" }),
}));

/** 生成的图片落本地后调用：未设置文件夹时不做任何事；写入失败只记录到状态里，不影响生成结果。 */
export async function saveGeneratedImageToFolder(blob: Blob, name: string) {
    if (!isDesktop) return;
    try {
        const path = await readImageFolder();
        useImageFolderStore.setState({ path });
        if (!path) return;
        await writeImageFile(`${safeFileName(name)}.${fileExtension(blob.type, "image:")}`, blob);
        useImageFolderStore.setState({ lastSavedAt: new Date().toISOString(), error: "" });
    } catch (error) {
        useImageFolderStore.setState({ error: error instanceof Error ? error.message : String(error) });
    }
}