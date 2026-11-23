import { useEffect, useMemo, useRef } from "react";
import { App, Button, Input, InputNumber, Segmented, Select } from "antd";
import { CircleCheck, CircleX, Clock3, FileUp, LoaderCircle, Play, RotateCcw, Square, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CanvasVideoSettingsPopover } from "@/components/canvas/canvas-video-settings-popover";
import { ModelPicker } from "@/components/model-picker";
import { canvasThemes } from "@/lib/canvas-theme";
import { parseBatchShots, resolveBatchPrompt } from "@/lib/canvas/canvas-batch-prompt";
import { VIDEO_SECONDS_MAX, VIDEO_SECONDS_MIN } from "@/lib/media-size";
import { CanvasNodeType } from "@/types/canvas";
import { emptyCanvasBatchState, useCanvasBatchStore, type BatchTaskStatus, type BatchVideoSettings } from "@/stores/canvas/use-canvas-batch-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { defaultConfig, resolveModelForCapability, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";

const STATUS_ICON: Record<BatchTaskStatus, typeof Clock3> = { pending: Clock3, running: LoaderCircle, success: CircleCheck, error: CircleX };
const STATUS_COLOR: Partial<Record<BatchTaskStatus, string>> = { success: "#16a34a", error: "#dc2626" };

function batchConfig(globalConfig: AiConfig, settings: BatchVideoSettings): AiConfig {
    return { ...globalConfig, ...settings, model: resolveModelForCapability(globalConfig, settings.model, "video"), size: settings.size || globalConfig.size || defaultConfig.size };
}

export function AgentBatchView() {
    const { t } = useTranslation();
    const { message, modal } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const globalConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const snapshot = useAgentStore((state) => state.canvasContext?.snapshot);
    const projectId = snapshot?.projectId || "";
    const hydrated = useCanvasBatchStore((state) => state.hydrated);
    const hasCanvas = Boolean(projectId) && hydrated;
    const { text, settings, concurrency, tasks, running, run, bindings, shotSeconds } = useCanvasBatchStore((state) => state.projects[projectId] || emptyCanvasBatchState);
    const { setBatchState, prepare, start, stop, clear, retry, retryFailed, applySettings, reconcile } = useCanvasBatchStore();
    const fileRef = useRef<HTMLInputElement>(null);
    const config = batchConfig(globalConfig, settings);
    const secondsSource = settings.secondsSource || "shot";
    const preview = useMemo(
        () => parseBatchShots(text).map((shot) => ({ ...shot, seconds: (shotSeconds || {})[shot.sequence] ?? shot.seconds, resolved: resolveBatchPrompt(shot.line, snapshot?.nodes || [], snapshot?.selectedNodeIds || [], bindings) })),
        [text, snapshot?.nodes, snapshot?.selectedNodeIds, bindings, shotSeconds],
    );
    const images = snapshot?.nodes.filter((node) => node.type === CanvasNodeType.Image && node.metadata?.content) || [];
    const unresolved = [...new Set(preview.flatMap((shot) => [...shot.resolved.missing, ...shot.resolved.ambiguous]))];
    const lineCount = preview.length;
    const sameBatch = Boolean(lineCount && run?.projectId === projectId && tasks.length === lineCount && tasks.every((task, index) => task.line === preview[index].line && (task.seconds || "") === (preview[index].seconds || "")));
    const missingNodeCount = tasks.filter((task) => !snapshot?.nodes.some((node) => node.id === task.nodeId)).length;
    const prepared = sameBatch && !missingNodeCount;
    const canImport = hasCanvas && lineCount > 0 && !unresolved.length && !prepared && (!tasks.some((task) => task.status === "pending") || sameBatch);
    const busy = running || tasks.some((task) => task.status === "running");
    const pendingCount = tasks.filter((task) => task.status === "pending").length;
    const failedCount = tasks.filter((task) => task.status === "error").length;
    const count = (status: BatchTaskStatus) => tasks.filter((task) => task.status === status).length;

    useEffect(() => {
        if (projectId && hydrated) reconcile(projectId);
    }, [projectId, snapshot?.nodes, hydrated, reconcile]);

    // The panel emits resolution and dimensions consecutively. Merge against the latest
    // store state rather than this render's settings, or the second update loses the first.
    const changeSettings = (patch: BatchVideoSettings) => {
        if (!projectId || !hydrated) return;
        setBatchState(projectId, { settings: patch.videoSeconds !== undefined ? { ...patch, secondsSource: "uniform" } : patch });
        applySettings(projectId, batchConfig(globalConfig, useCanvasBatchStore.getState().projects[projectId].settings));
    };
    const updateShotSeconds = (sequence: string, value: number | null) => {
        if (!projectId || !hydrated) return;
        const next = { ...shotSeconds };
        if (value) next[sequence] = String(Math.max(VIDEO_SECONDS_MIN, Math.min(VIDEO_SECONDS_MAX, Math.round(value))));
        else delete next[sequence];
        setBatchState(projectId, { shotSeconds: next });
    };
    const confirmGeneration = (mode: "pending" | "failed", taskId?: string) => {
        if (!isAiConfigReady(config, config.model)) return openConfigDialog(true);
        const targetProjectId = projectId;
        const total = taskId ? 1 : mode === "failed" ? failedCount + pendingCount : pendingCount;
        modal.confirm({
            title: `确认${mode === "failed" ? "重试" : "生成"} ${total} 个视频？`,
            content: `使用当前显示的模型和参数，可能消耗渠道额度。${mode === "failed" && !taskId && pendingCount ? "本次同时继续待生成任务和重试失败项。" : ""}已完成和正在生成的任务不会改变；${secondsSource === "uniform" ? `所有镜头统一 ${config.videoSeconds || VIDEO_SECONDS_MIN} 秒。` : "各镜头沿用分镜标注的时长。"}`,
            okText: "确认生成", cancelText: "取消",
            onOk: () => {
                if (useAgentStore.getState().canvasContext?.snapshot.projectId !== targetProjectId) return;
                const currentConfig = batchConfig(globalConfig, useCanvasBatchStore.getState().projects[targetProjectId]?.settings || {});
                if (taskId) retry(targetProjectId, taskId, currentConfig);
                else if (mode === "failed") retryFailed(targetProjectId, currentConfig);
                else start(targetProjectId, currentConfig);
            },
        });
    };
    const clearBatch = () => {
        const targetProjectId = projectId;
        modal.confirm({
            title: "清空当前画布的批量内容？",
            content: "将清空提示词、资产匹配和任务记录，保留当前生成参数及并发设置。不会删除画布上的图片或视频，也不会影响其他画布。此操作不可撤销。",
            okText: "清空批量", okButtonProps: { danger: true }, cancelText: "取消",
            onOk: () => { if (!clear(targetProjectId)) message.warning("请先停止排队，等待进行中的任务结束后再清空"); },
        });
    };
    const importFile = async (file?: File) => {
        if (!file || !projectId) return;
        const targetProjectId = projectId;
        try {
            const content = await file.text();
            const current = useCanvasBatchStore.getState().projects[targetProjectId] || emptyCanvasBatchState;
            if (current.running || current.tasks.some((task) => task.status === "running" || task.status === "pending")) return;
            setBatchState(targetProjectId, { text: [current.text.trim(), content.trim()].filter(Boolean).join("\n") });
            message.success(t("agent.batch.imported", { count: parseBatchShots(content).length }));
        } catch {
            message.error("提示词文件读取失败，请重试");
        }
    };

    return (
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-3" style={{ color: theme.node.text }}>
            <div className="space-y-3">
                <div className="border-b pb-3" style={{ borderColor: theme.node.stroke }}>
                    <div className="flex items-center justify-between gap-2">
                        <div className="truncate text-sm font-medium">当前画布 · {snapshot?.title || "未打开画布"}</div>
                        <Button type="text" size="small" icon={<Trash2 className="size-3.5" />} disabled={!hasCanvas || busy || (!text && !tasks.length && !Object.keys(bindings).length)} onClick={clearBatch}>清空批量</Button>
                    </div>
                    <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>提示词、生成参数和任务仅属于此画布，不与其他画布混用。</div>
                </div>
                <fieldset disabled={!hasCanvas} className="min-w-0 space-y-2 border-0 p-0">
                    <div className="text-xs font-medium">生成参数 · 导入后仍可修改</div>
                    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_148px] items-center gap-2">
                        <ModelPicker className="canvas-compact-control h-10" config={config} value={config.model} capability="video" fullWidth onChange={(model) => changeSettings({ model })} onMissingConfig={() => openConfigDialog(true)} />
                        <CanvasVideoSettingsPopover key={projectId} config={config} placement="bottomRight" secondsLabel={secondsSource === "shot" ? "分镜时长" : undefined} buttonClassName="canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2" onConfigChange={(key, value) => changeSettings({ [key]: value })} />
                    </div>
                    <div className="flex items-center justify-between gap-2 text-sm">
                        <span style={{ color: theme.node.muted }}>分镜时长</span>
                        <div className="flex min-w-0 items-center gap-1.5">
                            <Segmented
                                size="small"
                                value={secondsSource}
                                disabled={!hasCanvas}
                                onChange={(value) => changeSettings(value === "uniform" ? { secondsSource: "uniform", videoSeconds: config.videoSeconds || String(VIDEO_SECONDS_MIN) } : { secondsSource: "shot" })}
                                options={[
                                    { label: "按分镜标注", value: "shot" },
                                    { label: "统一", value: "uniform" },
                                ]}
                            />
                            {secondsSource === "uniform" ? (
                                <>
                                    <InputNumber size="small" className="w-[70px]" min={VIDEO_SECONDS_MIN} max={VIDEO_SECONDS_MAX} precision={0} value={Number(config.videoSeconds) || VIDEO_SECONDS_MIN} onChange={(value) => changeSettings({ videoSeconds: String(Math.max(VIDEO_SECONDS_MIN, Math.min(VIDEO_SECONDS_MAX, Math.round(value || VIDEO_SECONDS_MIN)))) })} />
                                    <span style={{ color: theme.node.muted }}>秒</span>
                                </>
                            ) : null}
                        </div>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-sm">
                        <span style={{ color: theme.node.muted }}>{t("agent.batch.concurrency")}</span>
                        <InputNumber size="small" min={1} max={32} precision={0} value={concurrency} disabled={!hasCanvas} onChange={(value) => setBatchState(projectId, { concurrency: value || 1 })} />
                    </div>
                    <div className="text-xs leading-5" style={{ color: theme.node.muted }}>
                        {secondsSource === "uniform"
                            ? `统一 ${config.videoSeconds || VIDEO_SECONDS_MIN} 秒会覆盖所有分镜标注；切回「按分镜标注」即按提示词里的【镜头N/12s】各自出片。`
                            : "按分镜标注出片：提示词里【镜头N/12s】的秒数就是该镜头时长，没标注的镜头用统一秒数兜底。"}
                        修改后自动用于待生成和失败任务，重试也使用新参数；已完成和生成中的任务保持不变。
                    </div>
                </fieldset>
                <div className="text-xs leading-5" style={{ color: theme.node.muted }}>粘贴完整分镜，按「1. [场景] - [镜头1 / 15.0s]」或「[场景A] + [场景B] - [镜头1/12s]」拆分，斜杠后的秒数即该镜头时长；也支持一行一条提示词。先将参考资产导入画布，再按 @名称 匹配。名称后请用空格或标点隔开正文。</div>
                <Input.TextArea value={text} autoSize={{ minRows: 6, maxRows: 14 }} placeholder="在这里粘贴完整分镜提示词，或导入 txt…" disabled={!hasCanvas || busy || pendingCount > 0} onChange={(event) => setBatchState(projectId, { text: event.target.value })} />
                <div className="flex items-center justify-between gap-2 text-xs" style={{ color: theme.node.muted }}>
                    <span>{t("agent.batch.lineCount", { count: lineCount })}</span>
                    <Button size="small" type="text" icon={<FileUp className="size-3.5" />} disabled={!hasCanvas || busy || pendingCount > 0} onClick={() => fileRef.current?.click()}>{t("agent.batch.import")}</Button>
                    <input ref={fileRef} type="file" accept=".txt,.csv,text/plain" className="hidden" onChange={(event) => { void importFile(event.target.files?.[0]); event.target.value = ""; }} />
                </div>
                <div className="text-xs leading-5" style={{ color: theme.node.muted }}>
                    {prepared || pendingCount
                        ? "镜头已导入画布。下一步点右侧「开始批量生成」才会真正出片。"
                        : unresolved.length
                          ? `还有 ${unresolved.length} 个 @参考未匹配，先在下方指定图片，再导入画布。`
                          : "先点「导入画布」把镜头放到画布上，导入成功后会出现可点的「开始批量生成」。"}
                </div>
                <div className="flex flex-wrap gap-2">
                    {busy ? (
                        <Button block danger icon={<Square className="size-3.5 fill-current" />} disabled={!running} onClick={() => stop(projectId)}>{running ? t("agent.batch.stop") : t("agent.batch.finishing")}</Button>
                    ) : (
                        <>
                            <Button
                                type="text"
                                icon={<FileUp className="size-4" />}
                                disabled={!canImport}
                                onClick={() => {
                                    const result = prepare(projectId, config, bindings);
                                    if (result === "ok") message.success(`已导入 ${lineCount} 条到画布，可点「开始批量生成」`);
                                    else if (result === "unresolved") message.warning("还有未匹配的 @参考，请先在下方指定图片");
                                    else if (result === "empty") message.warning("没有可导入的分镜");
                                    else if (result === "busy") message.warning("请先等待进行中的任务结束");
                                    else if (result === "stale-pending") message.warning("已有待生成任务，请先生成或清空批量后再导入新内容");
                                    else if (result === "no-canvas") message.warning(t("agent.batch.openCanvas"));
                                }}
                            >
                                {prepared ? "已导入画布" : sameBatch && missingNodeCount ? `重新导入缺失镜头（${missingNodeCount} 条）` : `① 导入画布（${lineCount} 条）`}
                            </Button>
                            <Button type="primary" icon={<Play className="size-4" />} disabled={!hasCanvas || !pendingCount || missingNodeCount > 0} onClick={() => confirmGeneration("pending")}>
                                {pendingCount ? `② 开始批量生成（${pendingCount} 条）` : "② 开始批量生成"}
                            </Button>
                            {failedCount ? <Button type="text" icon={<RotateCcw className="size-4" />} disabled={!hasCanvas || missingNodeCount > 0} onClick={() => confirmGeneration("failed")}>{pendingCount ? "继续并重试失败项" : "按当前参数重试失败项"}（{failedCount + pendingCount}）</Button> : null}
                        </>
                    )}
                </div>
                {sameBatch && missingNodeCount ? <div className="text-xs leading-5" style={{ color: theme.node.muted }}>有 {missingNodeCount} 个镜头节点已删除，可重新导入；仅补建缺失节点，不重复添加已有镜头。若参考图也被删除，请先重新导入参考资产。</div> : null}
                {preview.length ? (
                    <div className="space-y-2">
                        <div className="text-xs" style={{ color: theme.node.muted }}>导入预览 · {preview.length} 个镜头 · 仅导入不会生成</div>
                        {preview.map((shot, index) => (
                            <details key={index} className="border-b py-1.5 text-xs" style={{ borderColor: theme.node.stroke }}>
                                <summary className="cursor-pointer leading-5">{shot.sequence.padStart(3, "0")} · {shot.title}{shot.seconds ? ` · ${shot.seconds} 秒` : " · 未标注时长"} · {shot.resolved.refIds.length} 个参考{shot.resolved.missing.length || shot.resolved.ambiguous.length ? " · 待匹配" : ""}</summary>
                                <div className="mt-1 flex items-center gap-2 leading-5" style={{ color: theme.node.muted }}>
                                    <span>时长</span>
                                    <InputNumber size="small" className="w-[76px]" min={VIDEO_SECONDS_MIN} max={VIDEO_SECONDS_MAX} precision={0} value={shot.seconds ? Number(shot.seconds) : null} placeholder={String(config.videoSeconds || VIDEO_SECONDS_MIN)} disabled={secondsSource === "uniform"} onChange={(value) => updateShotSeconds(shot.sequence, value)} />
                                    <span>秒{secondsSource === "uniform" ? "（当前被统一时长覆盖）" : ""}</span>
                                </div>
                                <div className="mt-1 leading-5" style={{ color: theme.node.muted }}>参考：{shot.resolved.refIds.map((id) => images.find((node) => node.id === id)?.title).join("、") || "无"}</div>
                                <div className="mt-2 whitespace-pre-wrap break-words leading-5" style={{ color: theme.node.muted }}>{shot.line}</div>
                            </details>
                        ))}
                        {[...new Set([...unresolved, ...Object.keys(bindings)])].map((name) => (
                            <div key={name} className="space-y-1">
                                <div className="break-words text-xs" style={{ color: theme.node.muted }}>@{name} · {unresolved.includes(name) ? "未找到或存在同名，请指定参考图" : "已手动匹配"}</div>
                                <Select className="w-full" size="small" showSearch optionFilterProp="label" allowClear placeholder="选择已导入画布的图片" value={bindings[name]} disabled={busy || (pendingCount > 0 && !missingNodeCount)} options={images.map((node) => ({ value: node.id, label: `${node.title} · ${node.id.slice(0, 6)}` }))} onChange={(id) => { const next = { ...bindings }; if (id) next[name] = id; else delete next[name]; setBatchState(projectId, { bindings: next }); }} />
                            </div>
                        ))}
                    </div>
                ) : null}
                {!hasCanvas ? <div className="text-xs" style={{ color: theme.node.muted }}>{!hydrated ? "正在读取当前画布的批量记录…" : t("agent.batch.openCanvas")}</div> : null}
                {tasks.length ? (
                    <div className="space-y-1.5">
                        <div className="text-xs" style={{ color: theme.node.muted }}>{t("agent.batch.summary", { total: tasks.length, running: count("running"), pending: count("pending"), success: count("success"), error: count("error") })}</div>
                        {tasks.map((task) => {
                            const Icon = STATUS_ICON[task.status];
                            return (
                                <div key={task.id} className="flex items-start gap-2 rounded-lg border px-2.5 py-2" style={{ borderColor: theme.node.stroke }}>
                                    <Icon className={`mt-0.5 size-3.5 shrink-0 ${task.status === "running" ? "animate-spin" : ""}`} style={{ color: STATUS_COLOR[task.status] || theme.node.muted }} />
                                    <div className="min-w-0 flex-1">
                                        <div className="line-clamp-2 text-xs leading-5" title={task.line}>{task.title}</div>
                                        {task.error ? <div className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-red-600" title={task.error}>{task.error}</div> : null}
                                    </div>
                                    {task.status === "error" ? <Button size="small" type="text" className="!h-6 !w-6 !min-w-6 !p-0" title="按当前参数重试" icon={<RotateCcw className="size-3.5" />} disabled={!hasCanvas || busy || !snapshot?.nodes.some((node) => node.id === task.nodeId)} onClick={() => confirmGeneration("failed", task.id)} /> : null}
                                </div>
                            );
                        })}
                    </div>
                ) : null}
            </div>
        </div>
    );
}
