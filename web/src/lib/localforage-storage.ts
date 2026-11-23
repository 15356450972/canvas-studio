import localforage from "localforage";
import type { PersistStorage, StateStorage, StorageValue } from "zustand/middleware";

import { clearStorageIssue, reportStorageIssue, useStorageStatusStore } from "@/stores/use-storage-status-store";
import { listExistingStorageDatabases, openExistingStorageDatabase } from "@/services/local-storage-usage";

export const appStateStorage = localforage.createInstance({
    name: "infinite-canvas",
    storeName: "app_state",
    driver: localforage.INDEXEDDB,
});

const extraCopies = new Map<string, Error>();

async function findLegacySingletonCopy(key: string) {
    if (typeof indexedDB.databases !== "function") return null;
    const existing = await listExistingStorageDatabases();
    for (const { name } of existing) {
        if (name !== "infinite-canvas" && name !== "localforage") continue;
        const database = await openExistingStorageDatabase(name);
        try {
            if (!database.objectStoreNames.contains("keyvaluepairs")) continue;
            const value = await new Promise<unknown>((resolve, reject) => {
                const request = database.transaction("keyvaluepairs", "readonly").objectStore("keyvaluepairs").get(key);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            if (value !== undefined && value !== null) return { location: `${name}/keyvaluepairs`, value };
        } finally {
            database.close();
        }
    }
    return null;
}

export const localForageStorage: StateStorage = {
    getItem: async (name) => {
        try {
            if (typeof window === "undefined") throw new Error("浏览器本地存储不可用");
            const value = await appStateStorage.getItem<string>(name);
            const legacy = window.localStorage.getItem(name);
            const legacyDatabaseCopy = await findLegacySingletonCopy(name);
            if (value === null) {
                if (legacy !== null) throw new Error("发现仅保存在 localStorage 的历史数据；请先从存储诊断导出备份，已阻止空数据覆盖");
                if (legacyDatabaseCopy) throw new Error(`发现旧版 IndexedDB 副本（${legacyDatabaseCopy.location}）；请先从存储诊断导出备份，已阻止空数据覆盖`);
            }
            if (value !== null && typeof value !== "string") throw new Error("本地数据格式错误，已阻止覆盖");
            const copyConflict = legacy !== null && legacy !== value
                ? new Error("localStorage 中存在不同的历史副本；当前使用 IndexedDB 数据，请备份并核对额外副本")
                : legacyDatabaseCopy && legacyDatabaseCopy.value !== value
                    ? new Error(`旧版 IndexedDB ${legacyDatabaseCopy.location} 中存在不同副本；当前使用 app_state 数据，请备份并核对额外副本`)
                    : null;
            if (copyConflict) {
                extraCopies.set(name, copyConflict);
                reportStorageIssue(name, "read", copyConflict, "warning");
            } else {
                extraCopies.delete(name);
            }
            return value;
        } catch (error) {
            reportStorageIssue(name, "read", error);
            throw error;
        }
    },
    setItem: async (name, value) => {
        try {
            await appStateStorage.setItem(name, value);
            clearStorageIssue(name, "write");
        } catch (error) {
            reportStorageIssue(name, "write", error);
            throw error;
        }
    },
    removeItem: async (name) => {
        try {
            await appStateStorage.removeItem(name);
            clearStorageIssue(name, "write");
        } catch (error) {
            reportStorageIssue(name, "write", error);
            throw error;
        }
    },
};

/** Unlock writes only after parsing, asset resolution and Zustand's merge have all succeeded. */
export function createProtectedStorage<S>(
    key: string,
    options: {
        hydrate?: (value: StorageValue<S>) => StorageValue<S> | Promise<StorageValue<S>>;
        write?: (name: string, value: StorageValue<S>) => void | Promise<void>;
    } = {},
) {
    let writable = false;
    let writes = Promise.resolve();
    const enqueue = (write: () => void | Promise<void>) => {
        writes = writes.then(write).catch((error) => reportStorageIssue(key, "write", error));
        return writes;
    };
    const storage: PersistStorage<S> = {
        getItem: async (name) => {
            await writes;
            if (Object.values(useStorageStatusStore.getState().issues).some((issue) => issue.key === key && issue.operation === "write")) throw new Error("仍有未成功保存的改动，已阻止重新读取覆盖内存数据；请先备份");
            const value = await localForageStorage.getItem(name);
            if (value === null) return null;
            const parsed = JSON.parse(value) as StorageValue<S>;
            if (!parsed || typeof parsed.state !== "object" || parsed.state === null || (parsed.version !== undefined && parsed.version !== 0)) throw new Error("本地数据格式或版本不受支持，已阻止覆盖");
            return options.hydrate ? options.hydrate(parsed) : parsed;
        },
        setItem: (name, value) => {
            if (!writable) return;
            return enqueue(async () => {
                if (options.write) await options.write(name, value);
                else await localForageStorage.setItem(name, JSON.stringify(value));
            });
        },
        removeItem: (name) => {
            if (!writable) return;
            return enqueue(async () => { await localForageStorage.removeItem(name); });
        },
    };
    return {
        storage,
        isReady: () => writable,
        flush: () => writes,
        beginHydration: () => { writable = false; },
        finishHydration: (error?: unknown) => {
            writable = error === undefined;
            if (error !== undefined) reportStorageIssue(key, "read", error);
            else if (extraCopies.has(key)) reportStorageIssue(key, "read", extraCopies.get(key));
            else clearStorageIssue(key, "read");
        },
        requireReady: () => {
            if (!writable) throw new Error("本地数据尚未成功恢复，已阻止修改；请备份数据并重试读取");
        },
    };
}
