import { Alert, App, Button } from "antd";
import { useState } from "react";
import { useConfigStore } from "@/stores/use-config-store";
import { useStorageStatusStore } from "@/stores/use-storage-status-store";
import { BUSINESS_STORAGE_LABELS, type BusinessStorageKey } from "@/services/storage-diagnostics";

export function StorageStatusAlert() {
    const { modal, message } = App.useApp();
    const [retrying, setRetrying] = useState("");
    const issues = useStorageStatusStore((state) => state.issues);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const entries = Object.entries(issues);
    const retryRead = (key: BusinessStorageKey) => modal.confirm({
        title: `重新读取${BUSINESS_STORAGE_LABELS[key]}`,
        content: "请先通过「配置 → 本地存储」导出原始业务备份。确认后仅尝试重新读取持久化记录，不自动恢复、合并或删除副本。读取失败期间请勿操作相关业务数据。",
        okText: "已备份，重新读取",
        cancelText: "取消",
        onOk: async () => {
            if (Object.values(useStorageStatusStore.getState().issues).some((issue) => issue.key === key && issue.operation === "write")) {
                message.warning("该数据还有未保存的写入错误，已阻止重新读取以保留内存改动。");
                return;
            }
            setRetrying(key);
            try {
                // Import only on this explicit click: these stores depend on each other during initialization.
                const store = key === "infinite-canvas:canvas_store" ? (await import("@/stores/canvas/use-canvas-store")).useCanvasStore
                    : key === "infinite-canvas:asset_store" ? (await import("@/stores/use-asset-store")).useAssetStore
                    : (await import("@/stores/canvas/use-canvas-batch-store")).useCanvasBatchStore;
                await store.persist.rehydrate();
                const issuesAfterRead = Object.values(useStorageStatusStore.getState().issues).filter((issue) => issue.key === key);
                const failed = issuesAfterRead.some((issue) => issue.operation === "read" && issue.severity === "error");
                if (!store.getState().hydrated || failed) message.error("重新读取仍失败，请保留浏览器数据并查看存储诊断。");
                else message.success("持久化记录已重新读取；如仍提示额外副本，请在诊断中核对。");
            } catch {
                message.error("重新读取失败，未清除任何存储记录。");
            } finally {
                setRetrying("");
            }
        },
    });
    if (!entries.length) return null;
    const readFailed = entries.some(([, issue]) => issue.operation === "read" && issue.severity === "error");
    const writeFailed = entries.some(([, issue]) => issue.operation === "write");
    const hasCopyWarning = entries.some(([, issue]) => issue.severity === "warning");
    return (
        <div className="fixed inset-x-3 top-3 z-[999] mx-auto max-w-3xl" role="alert" aria-live="assertive">
            <Alert type={readFailed || writeFailed ? "error" : "warning"} showIcon title={readFailed || writeFailed ? "本地存储异常：读取/写入失败不代表数据为空" : "发现额外的本地数据副本"} description={
                <div className="space-y-2">
                    {readFailed ? <p>读取失败：当前列表可能不完整，相关数据操作已受保护。请停止新增、编辑、删除和同步，先到「配置 → 本地存储」诊断并导出备份。</p> : null}
                    {writeFailed ? <p>写入失败：当前改动可能只保留在内存中，刷新或关闭页面会丢失未保存的改动。请保留当前页面并先导出备份；磁盘副本可能不含最新改动。</p> : null}
                    {hasCopyWarning ? <p>检测到 localStorage 中存在不同的历史副本；当前继续使用 IndexedDB 数据，没有自动合并或删除。请在存储诊断中核对并备份这份副本。</p> : null}
                    <div className="max-h-32 space-y-1 overflow-y-auto text-xs">
                        {entries.map(([id, issue]) => {
                            const key = issue.key as BusinessStorageKey;
                            const known = Object.prototype.hasOwnProperty.call(BUSINESS_STORAGE_LABELS, key);
                            const hasWriteFailure = entries.some(([, item]) => item.key === key && item.operation === "write");
                            return <div key={id} className="flex flex-wrap items-center gap-2">
                                <span>{known ? BUSINESS_STORAGE_LABELS[key] : "本地业务数据"}：{issue.severity === "warning" ? "存在额外副本" : issue.operation === "read" ? "读取失败" : "写入失败"}</span>
                                {known && issue.operation === "read" && issue.severity === "error" ? <Button size="small" loading={retrying === key} disabled={hasWriteFailure || Boolean(retrying)} onClick={() => retryRead(key)}>手动重新读取</Button> : null}
                            </div>;
                        })}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Button size="small" onClick={() => openConfigDialog(false, "local-storage")}>打开存储诊断</Button>
                        <span className="text-xs">不会自动重试或清空浏览器数据。</span>
                    </div>
                </div>
            } />
        </div>
    );
}
