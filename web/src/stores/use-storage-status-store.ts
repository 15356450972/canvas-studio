import { create } from "zustand";

type StorageOperation = "read" | "write";
type StorageSeverity = "warning" | "error";
type StorageIssue = { key: string; operation: StorageOperation; severity: StorageSeverity; message: string };

type StorageStatusStore = {
    issues: Record<string, StorageIssue>;
    reportIssue: (key: string, operation: StorageOperation, error: unknown, severity?: StorageSeverity) => void;
    clearIssue: (key: string) => void;
};

export const useStorageStatusStore = create<StorageStatusStore>()((set) => ({
    issues: {},
    reportIssue: (key, operation, error, severity = "error") => set((state) => ({
        issues: { ...state.issues, [`${operation}:${key}`]: { key, operation, severity, message: error instanceof Error ? error.message : String(error) } },
    })),
    clearIssue: (key) => set((state) => ({
        issues: Object.fromEntries(Object.entries(state.issues).filter(([, issue]) => issue.key !== key)),
    })),
}));

export function reportStorageIssue(key: string, operation: StorageOperation, error: unknown, severity?: StorageSeverity) {
    useStorageStatusStore.getState().reportIssue(key, operation, error, severity);
}

// A successful write must never dismiss an unresolved read/hydration failure.
export function clearStorageIssue(key: string, operation: StorageOperation) {
    useStorageStatusStore.setState((state) => ({
        issues: Object.fromEntries(Object.entries(state.issues).filter(([, issue]) => issue.key !== key || issue.operation !== operation)),
    }));
}
