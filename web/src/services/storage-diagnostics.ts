import { listExistingStorageDatabases, openExistingStorageDatabase, storageValueBytes } from "@/services/local-storage-usage";

export const BUSINESS_STORAGE_KEYS = ["infinite-canvas:canvas_store", "infinite-canvas:asset_store", "infinite-canvas:canvas_batch_projects"] as const;
export type BusinessStorageKey = typeof BUSINESS_STORAGE_KEYS[number];
export const BUSINESS_STORAGE_LABELS: Record<BusinessStorageKey, string> = {
    "infinite-canvas:canvas_store": "画布项目",
    "infinite-canvas:asset_store": "我的素材",
    "infinite-canvas:canvas_batch_projects": "批量任务",
};
type Counts = { projects: number; nodes: number; assets: number; tasks: number };
type RecordStatus = "missing" | "valid" | "invalid-json" | "invalid-state" | "read-error";
export type BusinessRecordSummary = { key: BusinessStorageKey; location: string; status: RecordStatus; bytes: number; counts: Counts };
type RawBusinessRecord = { key: BusinessStorageKey; location: string; value: unknown };
type DatabaseSummary = { name: string; version: number; records: number | null; status: "readable" | "read-error"; stores: { name: string; records: number | null }[] };
export type StorageDiagnostics = {
    createdAt: string;
    origin: string;
    persistence: "granted" | "not-granted" | "unsupported" | "read-error";
    estimate: { usage: number | null; quota: number | null; status: "readable" | "unsupported" | "read-error" };
    enumeration: "readable" | "unsupported" | "read-error";
    databases: DatabaseSummary[];
    businessRecords: BusinessRecordSummary[];
};
const localStoragePrefixes = ["", "infinite-canvas/app_state/", "infinite-canvas/", "localforage/app_state/", "localforage/"];
const emptyCounts = (): Counts => ({ projects: 0, nodes: 0, assets: 0, tasks: 0 });
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

function summarize(key: BusinessStorageKey, location: string, value: unknown): BusinessRecordSummary {
    const summary: BusinessRecordSummary = { key, location, status: "missing", bytes: value === null || value === undefined ? 0 : storageValueBytes(value), counts: emptyCounts() };
    if (value === null || value === undefined) return summary;
    let parsed = value;
    try {
        // localforage's localStorage driver wraps a stored JSON string in another JSON string.
        if (typeof parsed === "string") parsed = JSON.parse(parsed);
        if (typeof parsed === "string") parsed = JSON.parse(parsed);
    } catch {
        return { ...summary, status: "invalid-json" };
    }
    const state = object(parsed) && object(parsed.state) ? parsed.state : null;
    if (!state) return { ...summary, status: "invalid-state" };
    if (key === "infinite-canvas:canvas_store" && Array.isArray(state.projects)) {
        summary.counts.projects = state.projects.length;
        summary.counts.nodes = state.projects.reduce((total, project) => total + (object(project) && Array.isArray(project.nodes) ? project.nodes.length : 0), 0);
    } else if (key === "infinite-canvas:asset_store" && Array.isArray(state.assets)) {
        summary.counts.assets = state.assets.length;
    } else if (key === "infinite-canvas:canvas_batch_projects" && object(state.projects)) {
        summary.counts.projects = Object.keys(state.projects).length;
        summary.counts.tasks = Object.values(state.projects).reduce<number>((total, project) => total + (object(project) && Array.isArray(project.tasks) ? project.tasks.length : 0), 0);
    } else return { ...summary, status: "invalid-state" };
    return { ...summary, status: "valid" };
}

function requestResult<T>(request: IDBRequest<T>) {
    return new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function inspectBusinessRecords() {
    const businessRecords: BusinessRecordSummary[] = [];
    const rawRecords: RawBusinessRecord[] = [];
    const databases: DatabaseSummary[] = [];
    let enumeration: StorageDiagnostics["enumeration"] = "readable";
    let existing: Awaited<ReturnType<typeof listExistingStorageDatabases>> = [];
    try {
        existing = await listExistingStorageDatabases();
    } catch {
        enumeration = typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function" ? "unsupported" : "read-error";
    }
    await Promise.all(existing.map(async ({ name, version }) => {
        let database: IDBDatabase | undefined;
        const entry: DatabaseSummary = { name, version: version ?? 0, records: 0, status: "readable", stores: [] };
        databases.push(entry);
        try {
            database = await openExistingStorageDatabase(name);
            entry.version = database.version;
            const names = Array.from(database.objectStoreNames);
            if (!names.length) return;
            const transaction = database.transaction(names, "readonly");
            await Promise.all(names.map(async (storeName) => {
                const store = transaction.objectStore(storeName);
                const count = requestResult(store.count()).then((records) => entry.stores.push({ name: storeName, records })).catch(() => {
                    entry.status = "read-error";
                    entry.stores.push({ name: storeName, records: null });
                });
                await Promise.all([count, ...BUSINESS_STORAGE_KEYS.map(async (key) => {
                    const location = `IndexedDB / ${name} / ${storeName}`;
                    try {
                        const value: unknown = await requestResult(store.get(key));
                        businessRecords.push(summarize(key, location, value));
                        if (value !== undefined && value !== null) rawRecords.push({ key, location, value });
                    } catch {
                        entry.status = "read-error";
                        businessRecords.push({ key, location, status: "read-error", bytes: 0, counts: emptyCounts() });
                    }
                })]);
            }));
        } catch {
            entry.status = "read-error";
        } finally {
            entry.records = entry.status === "readable" ? entry.stores.reduce((total, store) => total + (store.records ?? 0), 0) : null;
            database?.close();
        }
    }));
    // Only these explicit business keys are read. Never enumerate localStorage or inspect configuration keys.
    for (const prefix of localStoragePrefixes) {
        for (const key of BUSINESS_STORAGE_KEYS) {
            const location = `localStorage / ${prefix || "直接副本"}`;
            try {
                const value = window.localStorage.getItem(`${prefix}${key}`);
                businessRecords.push(summarize(key, location, value));
                if (value !== null) rawRecords.push({ key, location, value });
            } catch {
                businessRecords.push({ key, location, status: "read-error", bytes: 0, counts: emptyCounts() });
            }
        }
    }
    databases.sort((a, b) => a.name.localeCompare(b.name));
    for (const database of databases) database.stores.sort((a, b) => a.name.localeCompare(b.name));
    businessRecords.sort((a, b) => a.key.localeCompare(b.key) || a.location.localeCompare(b.location));
    return { enumeration, databases, businessRecords, rawRecords };
}

async function readPersistence(): Promise<StorageDiagnostics["persistence"]> {
    if (!navigator.storage?.persisted) return "unsupported";
    try {
        return await navigator.storage.persisted() ? "granted" : "not-granted";
    } catch {
        return "read-error";
    }
}

async function readEstimate(): Promise<StorageDiagnostics["estimate"]> {
    if (!navigator.storage?.estimate) return { usage: null, quota: null, status: "unsupported" };
    try {
        const estimate = await navigator.storage.estimate();
        return { usage: estimate.usage ?? null, quota: estimate.quota ?? null, status: "readable" };
    } catch {
        return { usage: null, quota: null, status: "read-error" };
    }
}

export async function readStorageDiagnostics(): Promise<StorageDiagnostics> {
    const [inspection, persistence, estimate] = await Promise.all([inspectBusinessRecords(), readPersistence(), readEstimate()]);
    return { createdAt: new Date().toISOString(), origin: window.location.origin, persistence, estimate, enumeration: inspection.enumeration, databases: inspection.databases, businessRecords: inspection.businessRecords };
}

export async function readRawBusinessBackup() {
    const { rawRecords, businessRecords, databases, enumeration } = await inspectBusinessRecords();
    return { format: "infinite-canvas-business-records", createdAt: new Date().toISOString(), origin: window.location.origin, enumeration, databases, businessRecords, records: rawRecords };
}
