import { useRef } from "react";
import { App, Button, Input, InputNumber } from "antd";
import { CircleCheck, CircleX, Clock3, FileUp, LoaderCircle, Play, RotateCcw, Square } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CanvasVideoSettingsPopover } from "@/components/canvas/canvas-video-settings-popover";
import { ModelPicker } from "@/components/model-picker";
import { canvasThemes } from "@/lib/canvas-theme";
import { parseBatchPromptLines } from "@/lib/canvas/canvas-batch-prompt";
import { useCanvasBatchStore, type BatchTaskStatus } from "@/stores/canvas/use-canvas-batch-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { defaultConfig, resolveModelForCapability, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";

const STATUS_ICON: Record<BatchTaskStatus, typeof Clock3> = { pending: Clock3, running: LoaderCircle, success: CircleCheck, error: CircleX };
const STATUS_COLOR: Partial<Record<BatchTaskStatus, string>> = { success: "#16a34a", error: "#dc2626" };

export function AgentBatchView() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const globalConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const hasCanvas = useAgentStore((state) => Boolean(state.canvasContext));
    const { text, settings, concurrency, tasks, running, setBatchState, start, resume, stop, retry } = useCanvasBatchStore();
    const fileRef = useRef<HTMLInputElement>(null);
    const config: AiConfig = {
        ...globalConfig,
        ...settings,
        model: resolveModelForCapability(globalConfig, settings.model, "video"),
        size: settings.size || globalConfig.size || defaultConfig.size,
    };
    const lineCount = parseBatchPromptLines(text).length;
    const busy = running || tasks.some((task) => task.status === "running");
    const pendingCount = tasks.filter((task) => task.status === "pending").length;
    const count = (status: BatchTaskStatus) => tasks.filter((task) => task.status === status).length;

    const handleStart = () => {
        if (!isAiConfigReady(config, config.model)) return openConfigDialog(true);
        start(config);
    };

    const importFile = async (file?: File) => {
        if (!file) return;
        const content = await file.text();
        setBatchState({ text: [text.trim(), content.trim()].filter(Boolean).join("\n") });
        message.success(t("agent.batch.imported", { count: parseBatchPromptLines(content).length }));
    };

    return (
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-3" style={{ color: theme.node.text }}>
            <div className="space-y-3">
                <div className="text-xs leading-5" style={{ color: theme.node.muted }}>{t("agent.batch.hint")}</div>
                <Input.TextArea value={text} autoSize={{ minRows: 6, maxRows: 14 }} placeholder={t("agent.batch.placeholder")} disabled={busy} onChange={(event) => setBatchState({ text: event.target.value })} />
                <div className="flex items-center justify-between gap-2 text-xs" style={{ color: theme.node.muted }}>
                    <span>{t("agent.batch.lineCount", { count: lineCount })}</span>
                    <Button size="small" type="text" icon={<FileUp className="size-3.5" />} disabled={busy} onClick={() => fileRef.current?.click()}>
                        {t("agent.batch.import")}
                    </Button>
                    <input ref={fileRef} type="file" accept=".txt,.csv,text/plain" className="hidden" onChange={(event) => { void importFile(event.target.files?.[0]); event.target.value = ""; }} />
                </div>
                <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_148px] items-center gap-2">
                    <ModelPicker className="canvas-compact-control h-10" config={config} value={config.model} capability="video" fullWidth onChange={(model) => setBatchState({ settings: { ...settings, model } })} onMissingConfig={() => openConfigDialog(true)} />
                    <CanvasVideoSettingsPopover config={config} placement="bottomRight" buttonClassName="canvas-compact-control !h-10 !w-full !justify-start !rounded-lg !px-2" onConfigChange={(key, value) => setBatchState({ settings: { ...settings, [key]: value } })} />
                </div>
                <div className="flex items-center justify-between gap-2 text-sm">
                    <span style={{ color: theme.node.muted }}>{t("agent.batch.concurrency")}</span>
                    <InputNumber size="small" min={1} max={10} precision={0} value={concurrency} onChange={(value) => setBatchState({ concurrency: value || 1 })} />
                </div>
                {!hasCanvas ? <div className="text-xs text-amber-600">{t("agent.batch.openCanvas")}</div> : null}
                <div className="flex gap-2">
                    {busy ? (
                        <Button block danger icon={<Square className="size-3.5 fill-current" />} disabled={!running} onClick={stop}>
                            {running ? t("agent.batch.stop") : t("agent.batch.finishing")}
                        </Button>
                    ) : (
                        <>
                            <Button block type="primary" icon={<Play className="size-4" />} disabled={!hasCanvas || !lineCount} onClick={handleStart}>
                                {t("agent.batch.start", { count: lineCount })}
                            </Button>
                            {pendingCount ? (
                                <Button disabled={!hasCanvas} onClick={resume}>
                                    {t("agent.batch.resume", { count: pendingCount })}
                                </Button>
                            ) : null}
                        </>
                    )}
                </div>
                {tasks.length ? (
                    <div className="space-y-1.5">
                        <div className="text-xs" style={{ color: theme.node.muted }}>
                            {t("agent.batch.summary", { total: tasks.length, running: count("running"), pending: count("pending"), success: count("success"), error: count("error") })}
                        </div>
                        {tasks.map((task) => {
                            const Icon = STATUS_ICON[task.status];
                            return (
                                <div key={task.id} className="flex items-start gap-2 rounded-lg border px-2.5 py-2" style={{ borderColor: theme.node.stroke }}>
                                    <Icon className={`mt-0.5 size-3.5 shrink-0 ${task.status === "running" ? "animate-spin" : ""}`} style={{ color: STATUS_COLOR[task.status] || theme.node.muted }} />
                                    <div className="min-w-0 flex-1">
                                        <div className="line-clamp-2 text-xs leading-5" title={task.line}>{task.index + 1}. {task.line}</div>
                                        {task.error ? <div className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-red-600" title={task.error}>{task.error}</div> : null}
                                    </div>
                                    {task.status === "error" ? (
                                        <Button size="small" type="text" className="!h-6 !w-6 !min-w-6 !p-0" title={t("agent.batch.retry")} icon={<RotateCcw className="size-3.5" />} disabled={!hasCanvas} onClick={() => retry(task.id)} />
                                    ) : null}
                                </div>
                            );
                        })}
                    </div>
                ) : null}
            </div>
        </div>
    );
}
