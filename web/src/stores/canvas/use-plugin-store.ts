import { create } from "zustand";
import { persist } from "zustand/middleware";

import { createProtectedStorage } from "@/lib/localforage-storage";

export type InstalledPlugin = {
    id: string;
    name: string;
    version: string;
    description?: string;
    url: string; // Installation source used for updates.
    source: string; // Cached plugin source for offline use and pinned versions.
    enabled: boolean;
    local?: boolean; // Local plugin discovered in web/public/plugins; disabled by default and refetched from its URL when enabled.
    official?: boolean; // Installed from the official registry and grouped accordingly in the manager.
    installedAt: string;
};

type PluginStore = {
    plugins: InstalledPlugin[];
    upsert: (plugin: Omit<InstalledPlugin, "installedAt"> & { installedAt?: string }) => void;
    setEnabled: (id: string, enabled: boolean) => void;
    remove: (id: string) => void;
};

const PLUGIN_STORE_KEY = "infinite-canvas:plugin_store";
const pluginStorage = createProtectedStorage<PluginStore>(PLUGIN_STORE_KEY, {
    hydrate: (value) => {
        if (!Array.isArray(value.state.plugins)) throw new Error("插件本地数据格式错误，已阻止覆盖");
        return value;
    },
});

export const usePluginStore = create<PluginStore>()(
    persist(
        (set) => ({
            plugins: [],
            upsert: (plugin) => {
                pluginStorage.requireReady();
                set((state) => {
                    const installedAt = plugin.installedAt || new Date().toISOString();
                    const exists = state.plugins.some((item) => item.id === plugin.id);
                    const next = { ...plugin, installedAt };
                    return { plugins: exists ? state.plugins.map((item) => (item.id === plugin.id ? next : item)) : [next, ...state.plugins] };
                });
            },
            setEnabled: (id, enabled) => {
                pluginStorage.requireReady();
                set((state) => ({ plugins: state.plugins.map((item) => (item.id === id ? { ...item, enabled } : item)) }));
            },
            remove: (id) => {
                pluginStorage.requireReady();
                set((state) => ({ plugins: state.plugins.filter((item) => item.id !== id) }));
            },
        }),
        {
            name: PLUGIN_STORE_KEY,
            storage: pluginStorage.storage,
            onRehydrateStorage: () => {
                pluginStorage.beginHydration();
                return (_state, error) => pluginStorage.finishHydration(error);
            },
        },
    ),
);
