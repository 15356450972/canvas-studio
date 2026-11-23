import { create } from "zustand";
import { persist, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { createProtectedStorage } from "@/lib/localforage-storage";
import { reportStorageIssue, useStorageStatusStore } from "@/stores/use-storage-status-store";
import { cleanupUnusedImages, resolveImageUrl } from "@/services/image-storage";
import { cleanupUnusedMedia, resolveMediaUrl } from "@/services/file-storage";

export type AssetKind = "text" | "image" | "video";
export type TextAsset = AssetBase<"text"> & { data: { content: string } };
export type ImageAsset = AssetBase<"image"> & { data: { dataUrl: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type VideoAsset = AssetBase<"video"> & { data: { url: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type Asset = TextAsset | ImageAsset | VideoAsset;

type AssetBase<T extends AssetKind> = {
    id: string;
    kind: T;
    title: string;
    coverUrl: string;
    tags: string[];
    group?: string;
    source?: string;
    note?: string;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, unknown>;
};

type AssetStore = {
    hydrated: boolean;
    assets: Asset[];
    groups: string[];
    addGroup: (name: string) => boolean;
    renameGroup: (name: string, nextName: string) => boolean;
    removeGroup: (name: string) => void;
    moveAssets: (ids: string[], group?: string) => void;
    addAsset: (asset: Omit<Asset, "id" | "createdAt" | "updatedAt">) => string;
    updateAsset: (id: string, patch: Partial<Omit<Asset, "id" | "createdAt">>) => void;
    removeAsset: (id: string) => void;
    replaceAssets: (assets: Asset[]) => void;
    cleanupImages: (extra?: unknown) => void;
};

export function getAssetGroups(groups: string[], assets: Asset[]) {
    return Array.from(new Set([...groups, ...assets.map((asset) => asset.group || "")].map((name) => name.trim()).filter(Boolean)));
}

export function matchesAssetGroup(asset: Asset, group?: string) {
    return group === undefined || (asset.group?.trim() || "") === group;
}

const ASSET_STORE_KEY = "infinite-canvas:asset_store";

const assetStorage = createProtectedStorage<AssetStore>(ASSET_STORE_KEY, {
    hydrate: async (value) => {
        if (!Array.isArray(value.state.assets) || (value.state.groups !== undefined && !Array.isArray(value.state.groups))) throw new Error("素材本地数据格式错误，已阻止覆盖");
        const assets = await Promise.all(
            value.state.assets.map(async (asset) => {
                if (!asset || typeof asset.id !== "string" || !asset.data || typeof asset.coverUrl !== "string" || (asset.kind === "text" ? typeof asset.data.content !== "string" : asset.kind === "image" ? typeof asset.data.dataUrl !== "string" : asset.kind === "video" ? typeof asset.data.url !== "string" : true)) throw new Error("素材记录损坏，已保留原始数据并阻止覆盖");
                if (asset.kind === "video" && asset.data.storageKey) return { ...asset, data: { ...asset.data, url: await resolveMediaUrl(asset.data.storageKey, asset.data.url) } };
                if (asset.kind !== "image" || !asset.data.storageKey) return asset;
                return {
                    ...asset,
                    coverUrl: asset.coverUrl.startsWith("blob:") ? await resolveImageUrl(asset.data.storageKey, asset.coverUrl) : asset.coverUrl,
                    data: { ...asset.data, dataUrl: await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl) },
                };
            }),
        );
        return { ...value, state: { ...value.state, assets } };
    },
});

export const flushAssetStorage = () => assetStorage.flush();

export const useAssetStore = create<AssetStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            assets: [],
            groups: [],
            addGroup: (name) => {
                assetStorage.requireReady();
                const group = name.trim();
                if (!group || getAssetGroups(get().groups, get().assets).includes(group)) return false;
                set((state) => ({ groups: [...state.groups, group] }));
                return true;
            },
            renameGroup: (name, nextName) => {
                assetStorage.requireReady();
                const group = nextName.trim();
                const available = getAssetGroups(get().groups, get().assets);
                if (!group || !available.includes(name) || (name !== group && available.includes(group))) return false;
                if (name === group) return true;
                const now = new Date().toISOString();
                set((state) => ({
                    groups: [...state.groups.filter((item) => item !== name), group],
                    assets: state.assets.map((asset) => matchesAssetGroup(asset, name) ? { ...asset, group, updatedAt: now } : asset),
                }));
                return true;
            },
            removeGroup: (name) => {
                assetStorage.requireReady();
                const now = new Date().toISOString();
                set((state) => ({
                    groups: state.groups.filter((group) => group !== name),
                    assets: state.assets.map((asset) => matchesAssetGroup(asset, name) ? { ...asset, group: undefined, updatedAt: now } : asset),
                }));
            },
            moveAssets: (ids, name) => {
                assetStorage.requireReady();
                const selected = new Set(ids);
                const group = name?.trim() || undefined;
                const now = new Date().toISOString();
                set((state) => ({ assets: state.assets.map((asset) => selected.has(asset.id) ? { ...asset, group, updatedAt: now } : asset) }));
            },
            addAsset: (asset) => {
                assetStorage.requireReady();
                const now = new Date().toISOString();
                const id = nanoid();
                set((state) => ({ assets: [{ ...asset, id, createdAt: now, updatedAt: now } as Asset, ...state.assets] }));
                return id;
            },
            updateAsset: (id, patch) => {
                assetStorage.requireReady();
                set((state) => ({
                    assets: state.assets.map((asset) => (asset.id === id ? ({ ...asset, ...patch, updatedAt: new Date().toISOString() } as Asset) : asset)),
                }));
            },
            removeAsset: (id) => {
                assetStorage.requireReady();
                set((state) => ({ assets: state.assets.filter((asset) => asset.id !== id) }));
                get().cleanupImages();
            },
            replaceAssets: (assets) => {
                assetStorage.requireReady();
                set({ assets });
            },
            cleanupImages: (extra) => {
                assetStorage.requireReady();
                window.setTimeout(() => {
                    void (async () => {
                        const { flushCanvasStorage, useCanvasStore } = await import("@/stores/canvas/use-canvas-store");
                        const ready = () => assetStorage.isReady() && useCanvasStore.getState().hydrated && !Object.values(useStorageStatusStore.getState().issues).some((issue) => (issue.operation === "write" || issue.severity === "warning") && (issue.key === ASSET_STORE_KEY || issue.key === "infinite-canvas:canvas_store"));
                        await Promise.all([assetStorage.flush(), flushCanvasStorage()]);
                        if (!ready()) return;
                        await cleanupUnusedImages({ assets: get().assets, projects: useCanvasStore.getState().projects, extra });
                        if (!ready()) return;
                        await cleanupUnusedMedia({ assets: get().assets, projects: useCanvasStore.getState().projects, extra });
                    })().catch((error) => reportStorageIssue(ASSET_STORE_KEY, "write", error));
                }, 0);
            },
        }),
        {
            name: ASSET_STORE_KEY,
            storage: assetStorage.storage,
            partialize: (state) => ({ assets: state.assets, groups: state.groups }) as StorageValue<AssetStore>["state"],
            onRehydrateStorage: (state) => {
                assetStorage.beginHydration();
                if (state.hydrated) useAssetStore.setState({ hydrated: false });
                return (_state, error) => {
                    if (error) return assetStorage.finishHydration(error);
                    useAssetStore.setState({ hydrated: true });
                    assetStorage.finishHydration();
                };
            },
        },
    ),
);
