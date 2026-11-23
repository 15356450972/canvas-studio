export type IndexedDbStoreUsage = { name: string; records: number; bytes: number };
export type IndexedDbDatabaseUsage = { name: string; version: number; bytes: number; stores: IndexedDbStoreUsage[] };
export type LocalStorageUsage = { usage: number; quota: number; contentBytes: number; databases: IndexedDbDatabaseUsage[] };

export async function listExistingStorageDatabases() {
    if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") throw new Error("浏览器不支持枚举现有 IndexedDB 数据库；为避免创建新库，未打开任何数据库。");
    return (await indexedDB.databases()).filter((database): database is IDBDatabaseInfo & { name: string } => Boolean(database.name && /infinite-canvas|localforage/i.test(database.name)));
}

export function openExistingStorageDatabase(name: string) {
    return new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        let blocked = false;
        request.onupgradeneeded = () => {
            request.transaction?.abort();
            reject(new Error("数据库已不存在，已中止打开以避免创建空库。"));
        };
        request.onerror = () => reject(request.error || new Error("数据库打开失败"));
        request.onblocked = () => {
            blocked = true;
            reject(new Error("数据库被其他页面占用，未修改数据。"));
        };
        request.onsuccess = () => {
            if (blocked) {
                request.result.close();
                return;
            }
            request.result.onversionchange = () => request.result.close();
            resolve(request.result);
        };
    });
}

export async function readLocalStorageUsage(): Promise<LocalStorageUsage> {
    const [estimate, names] = await Promise.all([navigator.storage?.estimate?.(), listExistingStorageDatabases()]);
    const databases = await Promise.all(names.map(({ name }) => readDatabaseUsage(name)));
    return { usage: estimate?.usage ?? 0, quota: estimate?.quota ?? 0, contentBytes: databases.reduce((total, database) => total + database.bytes, 0), databases };
}

async function readDatabaseUsage(name: string): Promise<IndexedDbDatabaseUsage> {
    const database = await openExistingStorageDatabase(name);
    try {
        const names = Array.from(database.objectStoreNames);
        if (!names.length) return { name, version: database.version, bytes: 0, stores: [] };
        const transaction = database.transaction(names, "readonly");
        const stores = await Promise.all(names.map((storeName) => readStoreUsage(transaction.objectStore(storeName))));
        return { name, version: database.version, bytes: stores.reduce((total, store) => total + store.bytes, 0), stores: stores.sort((a, b) => b.bytes - a.bytes) };
    } finally {
        database.close();
    }
}

function readStoreUsage(store: IDBObjectStore) {
    return new Promise<IndexedDbStoreUsage>((resolve, reject) => {
        let records = 0;
        let bytes = 0;
        const request = store.openCursor();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
                resolve({ name: store.name, records, bytes });
                return;
            }
            try {
                records += 1;
                bytes += storageValueBytes(cursor.value);
                cursor.continue();
            } catch (error) {
                reject(error);
            }
        };
    });
}

export function storageValueBytes(value: unknown): number {
    if (value instanceof Blob) return value.size;
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (ArrayBuffer.isView(value)) return value.byteLength;
    if (Array.isArray(value)) return value.reduce((total, item) => total + storageValueBytes(item), 0);
    if (value && typeof value === "object") return Object.entries(value).reduce((total, [key, item]) => total + storageValueBytes(key) + storageValueBytes(item), 0);
    return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value) ?? "").byteLength;
}
