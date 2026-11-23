import { Alert, App, Button, Descriptions, Modal, Progress, Spin, Tag, theme } from "antd";
import { saveAs } from "file-saver";
import type { TFunction } from "i18next";
import { Database, Download, FolderOpen, HardDrive, Layers3, RefreshCw, Save, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { readLocalStorageUsage, type LocalStorageUsage } from "@/services/local-storage-usage";
import { BUSINESS_STORAGE_LABELS, readRawBusinessBackup, readStorageDiagnostics, type StorageDiagnostics } from "@/services/storage-diagnostics";
import { isDesktop } from "@/services/desktop";
import { useCanvasFolderStore } from "@/stores/canvas/use-canvas-folder-store";
import { useImageFolderStore } from "@/stores/use-image-folder-store";
import { useVideoFolderStore } from "@/stores/use-video-folder-store";

const storeLabelKeys: Record<string, string> = {
    app_state: "appState",
    image_files: "images",
    media_files: "media",
    image_generation_logs: "imageLogs",
    video_generation_logs: "videoLogs",
    agent_chat_messages: "agentMessages",
    prompt_cache: "promptCache",
};

export function ConfigLocalStorage({ active }: { active: boolean }) {
    const { t } = useTranslation();
    const [usage, setUsage] = useState<LocalStorageUsage | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    const refresh = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            setUsage(await readLocalStorageUsage());
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : t("config.localStorage.readFailed"));
        } finally {
            setLoading(false);
        }
    }, [t]);

    useEffect(() => {
        if (active && !usage) void refresh();
    }, [active, refresh, usage]);

    const indexedDbBytes = usage?.contentBytes ?? 0;
    const percent = usage?.quota ? Math.min(100, (usage.usage / usage.quota) * 100) : 0;

    return (
        <div className="space-y-3">
            <CanvasFolderSection active={active} />
            {isDesktop ? <ImageFolderSection active={active} /> : null}
            <StorageDiagnosticsSection />
            <section className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <div className="flex items-center gap-2 text-sm font-semibold">
                            <Database className="size-4" />
                            {t("config.localStorage.title")}
                        </div>
                        <div className="mt-1 text-xs text-stone-500">{t("config.localStorage.description")}</div>
                    </div>
                    <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void refresh()}>
                        {t("config.localStorage.refresh")}
                    </Button>
                </div>
                {error ? <Alert className="mt-4" type="error" showIcon message={t("config.localStorage.readFailed")} description={error} /> : null}
                {!usage && loading ? (
                    <div className="flex min-h-48 items-center justify-center"><Spin /></div>
                ) : usage ? (
                    <>
                        <div className="mt-4 grid gap-3 sm:grid-cols-3">
                            <StorageMetric icon={<Database className="size-4" />} label={t("config.localStorage.indexedDbUsage")} value={formatStorageBytes(indexedDbBytes)} hint={t("config.localStorage.contentEstimate")} />
                            <StorageMetric icon={<HardDrive className="size-4" />} label={t("config.localStorage.siteUsage")} value={formatStorageBytes(usage.usage)} hint={t("config.localStorage.siteUsageHint")} />
                            <StorageMetric icon={<Layers3 className="size-4" />} label={t("config.localStorage.quota")} value={formatStorageBytes(usage.quota)} hint={t("config.localStorage.quotaHint")} />
                        </div>
                        <div className="mt-4">
                            <div className="mb-1 flex justify-between text-xs text-stone-500">
                                <span>{t("config.localStorage.quotaProgress")}</span>
                                <span className="tabular-nums">{percent.toFixed(2)}%</span>
                            </div>
                            <Progress percent={percent} showInfo={false} />
                        </div>
                    </>
                ) : null}
            </section>
            {usage?.databases.map((database) => (
                <section key={database.name} className="overflow-hidden rounded-lg border border-stone-200 dark:border-stone-800">
                    <div className="flex items-center justify-between gap-3 border-b border-stone-200 px-4 py-3 dark:border-stone-800">
                        <div className="min-w-0">
                            <div className="truncate text-sm font-semibold">{t("config.localStorage.mainDatabase")}</div>
                            <div className="mt-0.5 truncate font-mono text-[11px] text-stone-500">{database.name} · v{database.version}</div>
                        </div>
                        <div className="shrink-0 text-sm font-medium tabular-nums">{formatStorageBytes(database.bytes)}</div>
                    </div>
                    <div className="divide-y divide-stone-200 dark:divide-stone-800">
                        {database.stores.map((store) => (
                            <div key={store.name} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-4 px-4 py-3 text-sm">
                                <div className="min-w-0">
                                    <div className="truncate font-medium">{storeLabel(store.name, t)}</div>
                                    <div className="mt-0.5 truncate font-mono text-[11px] text-stone-500">{store.name}</div>
                                </div>
                                <div className="text-right text-xs text-stone-500 tabular-nums">{t("config.localStorage.records", { count: store.records })}</div>
                                <div className="w-20 text-right font-medium tabular-nums">{formatStorageBytes(store.bytes)}</div>
                            </div>
                        ))}
                    </div>
                </section>
            ))}
        </div>
    );
}

const diagnosticStatusLabels = { missing: "不存在", valid: "可解析", "invalid-json": "JSON 损坏", "invalid-state": "业务结构异常", "read-error": "读取失败" };

function StorageDiagnosticsSection() {
    const { message, modal } = App.useApp();
    const { token } = theme.useToken();
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [report, setReport] = useState<StorageDiagnostics | null>(null);
    const [error, setError] = useState("");
    const inspect = async () => {
        setOpen(true);
        setLoading(true);
        setError("");
        setReport(null);
        try {
            setReport(await readStorageDiagnostics());
        } catch {
            setError("诊断读取失败。请保留浏览器数据，这不代表业务记录为空。");
        } finally {
            setLoading(false);
        }
    };
    const download = (data: unknown, filename: string) => saveAs(new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }), filename);
    const exportBackup = () => modal.confirm({
        title: "导出原始业务记录备份",
        content: "备份包含画布提示词、对话、批量任务和私有素材元数据，可能含内嵌素材及私密链接。仅导出固定业务 key 在各候选位置的原始副本，不包含配置或 API Key 记录。文件将下载到本机，请妥善保管；此操作不会恢复、合并或删除任何数据。",
        okText: "确认并下载备份",
        cancelText: "取消",
        onOk: async () => {
            setExporting(true);
            try {
                const backup = await readRawBusinessBackup();
                download(backup, "infinite-canvas-business-backup.json");
                const incomplete = backup.enumeration !== "readable" || backup.databases.some((database) => database.status === "read-error") || backup.businessRecords.some((record) => record.status === "read-error");
                if (incomplete) message.warning("已导出可读取的业务副本；部分位置无法读取，备份可能不完整。");
                else message.success("业务记录备份已下载；外部素材文件需另行保存。");
            } catch {
                message.error("备份读取或下载失败，未修改本地数据。");
            } finally {
                setExporting(false);
            }
        },
    });
    return (
        <>
            <section className="rounded-lg border p-4" style={{ borderColor: token.colorBorderSecondary }}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <div className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="size-4" />只读存储诊断</div>
                        <div className="mt-1 text-xs" style={{ color: token.colorTextSecondary }}>查看当前站点与业务副本状态，不写入、不恢复、不清理存储。</div>
                    </div>
                    <Button icon={<ShieldCheck className="size-4" />} loading={loading} onClick={() => void inspect()}>开始诊断</Button>
                </div>
            </section>
            <Modal title="只读存储诊断" open={open} width={900} onCancel={() => setOpen(false)} footer={<div className="flex flex-wrap justify-end gap-2">
                <Button disabled={!report || loading} icon={<Download className="size-4" />} onClick={() => report && download(report, "infinite-canvas-storage-diagnostics.json")}>下载计数诊断 JSON</Button>
                <Button loading={exporting} disabled={loading} onClick={exportBackup}>导出原始业务备份</Button>
                <Button loading={loading} onClick={() => void inspect()}>重新诊断</Button>
                <Button onClick={() => setOpen(false)}>关闭</Button>
            </div>}>
                <div className="space-y-4">
                    <Alert type="info" showIcon title="诊断仅保留状态、字节与计数" description="不会显示提示词、项目名称、素材内容或 API 配置。浏览器的持久化状态只查询已有授权，不会发起授权请求。记录不存在与读取失败会分别标注；所有计数均为各副本独立统计，不代表已合并。" />
                    {loading ? <div className="flex min-h-40 items-center justify-center"><Spin /></div> : null}
                    {error ? <Alert type="error" showIcon title={error} /> : null}
                    {report ? <>
                        <Descriptions size="small" column={1} bordered items={[
                            { key: "origin", label: "当前 origin", children: <span className="break-all font-mono text-xs">{report.origin}</span> },
                            { key: "persistence", label: "持久化授权", children: ({ granted: "已授权", "not-granted": "未授权（浏览器仍可能回收数据）", unsupported: "浏览器不支持查询", "read-error": "查询失败" })[report.persistence] },
                            { key: "estimate", label: "浏览器存储估算", children: report.estimate.status === "readable" ? `已用 ${report.estimate.usage === null ? "未知" : formatStorageBytes(report.estimate.usage)} / 配额 ${report.estimate.quota === null ? "未知" : formatStorageBytes(report.estimate.quota)}` : report.estimate.status === "unsupported" ? "浏览器不支持查询" : "查询失败" },
                        ]} />
                        {report.enumeration !== "readable" ? <Alert type="warning" showIcon title="无法枚举现有 IndexedDB" description="为避免新建数据库，已跳过 IndexedDB 检查；下方 localStorage 副本仍独立展示。" /> : null}
                        <div>
                            <div className="mb-2 text-sm font-semibold">现有相关数据库 / Store 记录数</div>
                            {!report.databases.length ? <div className="text-xs" style={{ color: token.colorTextSecondary }}>{report.enumeration === "readable" ? "未发现 infinite-canvas / localforage 相关数据库。" : "数据库状态未知。"}</div> : null}
                            {report.databases.map((database) => <div key={database.name} className="mb-2 rounded-lg border p-3" style={{ borderColor: token.colorBorderSecondary }}>
                                <div className="flex flex-wrap items-center gap-2 text-xs"><span className="break-all font-mono">{database.name} · v{database.version} · {database.records === null ? "记录数未知" : `${database.records} 条记录`}</span><Tag color={database.status === "readable" ? "success" : "error"}>{database.status === "readable" ? "可读取" : "读取失败"}</Tag></div>
                                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs" style={{ color: token.colorTextSecondary }}>{database.stores.map((store) => <span key={store.name} className="break-all">{store.name}：{store.records ?? "读取失败"}{store.records === null ? "" : " 条"}</span>)}</div>
                            </div>)}
                        </div>
                        <div>
                            <div className="mb-2 text-sm font-semibold">固定业务 key 副本</div>
                            <div className="max-h-96 space-y-2 overflow-y-auto">
                                {report.businessRecords.map((record) => <div key={`${record.key}:${record.location}`} className="rounded-lg border p-3" style={{ borderColor: token.colorBorderSecondary }}>
                                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="font-medium">{BUSINESS_STORAGE_LABELS[record.key]}</span><div><Tag color={record.status === "valid" ? "success" : record.status === "missing" ? "default" : "error"}>{diagnosticStatusLabels[record.status]}</Tag><span className="tabular-nums">{formatStorageBytes(record.bytes)}</span></div></div>
                                    <div className="mt-1 break-all font-mono text-[11px]" style={{ color: token.colorTextSecondary }}>{record.location} · {record.key}</div>
                                    {record.status === "valid" ? <div className="mt-2 text-xs tabular-nums" style={{ color: token.colorTextSecondary }}>项目 {record.counts.projects} · 节点 {record.counts.nodes} · 素材 {record.counts.assets} · 任务 {record.counts.tasks}</div> : null}
                                </div>)}
                            </div>
                        </div>
                    </> : null}
                </div>
            </Modal>
        </>
    );
}

function CanvasFolderSection({ active }: { active: boolean }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const { status, folderName, lastSavedAt, error, load, pickFolder, saveNow, disable } = useCanvasFolderStore();

    useEffect(() => {
        if (active) void load();
    }, [active, load]);

    const run = (action: () => Promise<void>) => void action().catch((reason) => message.error(reason instanceof Error ? reason.message : t("config.canvasFolder.failed")));
    const statusText = status === "needs-permission" ? t("config.canvasFolder.needsPermission") : status === "saving" ? t("config.canvasFolder.saving") : status === "error" ? t("config.canvasFolder.error", { message: error }) : lastSavedAt ? t("config.canvasFolder.savedAt", { time: new Date(lastSavedAt).toLocaleTimeString() }) : t("config.canvasFolder.enabled");

    return (
        <section className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
            <div className="flex items-center gap-2 text-sm font-semibold">
                <FolderOpen className="size-4" />
                {t("config.canvasFolder.title")}
            </div>
            <div className="mt-1 text-xs text-stone-500">{t("config.canvasFolder.description")}</div>
            {status === "unsupported" ? (
                <Alert className="mt-4" type="warning" showIcon message={t("config.canvasFolder.unsupported")} />
            ) : (
                <>
                    {folderName ? (
                        <div className="mt-4 text-sm">
                            <span className="font-medium">{folderName}</span>
                            <span className={`ml-3 text-xs ${status === "error" || status === "needs-permission" ? "text-red-500" : "text-stone-500"}`}>{statusText}</span>
                        </div>
                    ) : null}
                    <div className="mt-4 flex flex-wrap gap-2">
                        <Button type={folderName ? "default" : "primary"} icon={<FolderOpen className="size-4" />} onClick={() => run(pickFolder)}>
                            {t(folderName ? "config.canvasFolder.change" : "config.canvasFolder.pick")}
                        </Button>
                        {folderName ? (
                            <>
                                <Button icon={<Save className="size-4" />} loading={status === "saving"} onClick={() => run(saveNow)}>
                                    {t("config.canvasFolder.saveNow")}
                                </Button>
                                <Button onClick={() => run(disable)}>{t("config.canvasFolder.disable")}</Button>
                            </>
                        ) : null}
                    </div>
                </>
            )}
        </section>
    );
}

function ImageFolderSection({ active }: { active: boolean }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const image = useImageFolderStore();
    const video = useVideoFolderStore();
    const { path, lastSavedAt, load, pick, disable } = image;
    const error = image.error || video.error;
    const label = (key: string, options?: Record<string, string>) => t(`config.imageFolder.${key}`, options);

    useEffect(() => {
        if (active) void load();
    }, [active, load]);

    const run = (action: () => Promise<void>) => void action().catch((reason) => message.error(reason instanceof Error ? reason.message : label("failed")));
    const statusText = error ? label("error", { message: error }) : lastSavedAt ? label("savedAt", { time: new Date(lastSavedAt).toLocaleTimeString() }) : label("enabled");

    return (
        <section className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
            <div className="flex items-center gap-2 text-sm font-semibold">
                <FolderOpen className="size-4" />
                {label("title")}
            </div>
            <div className="mt-1 text-xs text-stone-500">{label("description")}</div>
            {path ? (
                <div className="mt-4 text-sm">
                    <span className="break-all font-medium">{path}</span>
                    <span className={`ml-3 text-xs ${error ? "text-red-500" : "text-stone-500"}`}>{statusText}</span>
                </div>
            ) : null}
            {error && !path ? <Alert className="mt-3" type="error" showIcon title={statusText} /> : null}
            <div className="mt-4 flex flex-wrap gap-2">
                <Button type={path ? "default" : "primary"} icon={<FolderOpen className="size-4" />} onClick={() => run(pick)}>
                    {label(path ? "change" : "pick")}
                </Button>
                {path ? <Button onClick={() => run(disable)}>{label("disable")}</Button> : null}
            </div>
        </section>
    );
}

function StorageMetric({ icon, label, value, hint }: { icon: ReactNode; label: string; value: string; hint: string }) {
    return (
        <div className="rounded-lg bg-stone-100/70 p-3 dark:bg-stone-900/70">
            <div className="flex items-center gap-2 text-xs text-stone-500">{icon}{label}</div>
            <div className="mt-2 text-xl font-semibold tabular-nums">{value}</div>
            <div className="mt-1 text-[11px] text-stone-500">{hint}</div>
        </div>
    );
}

function storeLabel(name: string, t: TFunction) {
    const key = storeLabelKeys[name];
    return key ? t(`config.localStorage.stores.${key}`) : name;
}

function formatStorageBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
