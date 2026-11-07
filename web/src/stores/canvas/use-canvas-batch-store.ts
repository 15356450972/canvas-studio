import { create } from "zustand";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { parseBatchPromptLines, resolveBatchPrompt } from "@/lib/canvas/canvas-batch-prompt";
import type { CanvasAgentOp } from "@/lib/canvas/canvas-agent-ops";
import { MEDIA_NODE_DISPLAY_EDGE, nodeSizeFromRatio } from "@/lib/canvas/canvas-node-size";
import { useAgentStore } from "@/stores/use-agent-store";
import type { AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeMetadata } from "@/types/canvas";

export type BatchTaskStatus = "pending" | "running" | "success" | "error";
export type BatchTask = { id: string; index: number; line: string; prompt: string; refIds: string[]; nodeId?: string; status: BatchTaskStatus; error?: string };
export type BatchVideoSettings = Partial<Pick<AiConfig, "model" | "size" | "vquality" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark" | "videoMode">>;

type BatchRun = { projectId: string; metadata: CanvasNodeMetadata; origin: { x: number; y: number } };

type CanvasBatchStore = {
    text: string;
    settings: BatchVideoSettings;
    concurrency: number;
    tasks: BatchTask[];
    running: boolean;
    run: BatchRun | null;
    setBatchState: (patch: Partial<Pick<CanvasBatchStore, "text" | "settings" | "concurrency">>) => void;
    start: (config: AiConfig) => void;
    resume: () => void;
    stop: () => void;
    retry: (taskId: string) => void;
};

const GRID_COLUMNS = 4;
const GRID_GAP = 48;
const tr = (key: string, options?: Record<string, unknown>) => i18n.t(`agent.batch.${key}`, options);

export const useCanvasBatchStore = create<CanvasBatchStore>((set, get) => {
    const patchTask = (id: string, patch: Partial<BatchTask>) => set((state) => ({ tasks: state.tasks.map((task) => (task.id === id ? { ...task, ...patch } : task)) }));

    const pump = () => {
        const { running, tasks, concurrency } = get();
        if (!running) return;
        const active = tasks.filter((task) => task.status === "running").length;
        const next = tasks.filter((task) => task.status === "pending").slice(0, Math.max(0, concurrency - active));
        if (!next.length && !active) return set({ running: false });
        next.forEach((task) => void runTask(task.id));
    };

    const runTask = async (taskId: string) => {
        patchTask(taskId, { status: "running", error: undefined });
        patchTask(taskId, await executeTask(taskId));
        pump();
    };

    const executeTask = async (taskId: string): Promise<Pick<BatchTask, "status" | "error">> => {
        const { run } = get();
        const task = get().tasks.find((item) => item.id === taskId);
        const context = useAgentStore.getState().canvasContext;
        if (!task || !run || !context || context.snapshot.projectId !== run.projectId) return { status: "error", error: tr("canvasMissing") };
        const nodes = context.snapshot.nodes;
        if (task.refIds.some((id) => !nodes.some((node) => node.id === id))) return { status: "error", error: tr("referenceMissing") };
        const metadata: CanvasNodeMetadata = { ...run.metadata, prompt: task.prompt, status: "loading", errorDetails: undefined };
        const reuse = task.nodeId && nodes.some((node) => node.id === task.nodeId && !node.metadata?.content);
        const nodeId = reuse && task.nodeId ? task.nodeId : nanoid();
        const ops: CanvasAgentOp[] = [];
        if (reuse) {
            ops.push({ type: "update_node", id: nodeId, metadata });
        } else {
            const size = nodeSizeFromRatio(run.metadata.size || "", MEDIA_NODE_DISPLAY_EDGE, MEDIA_NODE_DISPLAY_EDGE) || NODE_DEFAULT_SIZE[CanvasNodeType.Video];
            const cell = { width: size.width + GRID_GAP, height: size.height + GRID_GAP };
            const position = { x: run.origin.x + (task.index % GRID_COLUMNS) * cell.width, y: run.origin.y + Math.floor(task.index / GRID_COLUMNS) * cell.height };
            ops.push({ type: "add_node", id: nodeId, nodeType: CanvasNodeType.Video, title: task.line.slice(0, 32), position, ...size, metadata });
            task.refIds.forEach((fromNodeId) => ops.push({ type: "connect_nodes", fromNodeId, toNodeId: nodeId }));
        }
        ops.push({ type: "run_generation", nodeId, mode: "video", prompt: task.prompt });
        patchTask(taskId, { nodeId });
        context.applyOps(ops);
        return watchVideoNode(nodeId, run.projectId);
    };

    return {
        text: "",
        settings: {},
        concurrency: 3,
        tasks: [],
        running: false,
        run: null,
        setBatchState: (patch) => set(patch),
        start: (config) => {
            const context = useAgentStore.getState().canvasContext;
            if (!context) return;
            const { nodes, selectedNodeIds, projectId } = context.snapshot;
            const tasks = parseBatchPromptLines(get().text).map((line, index): BatchTask => {
                const resolved = resolveBatchPrompt(line, nodes, selectedNodeIds);
                const error = resolved.missing.length ? tr("mentionMissing", { names: resolved.missing.map((name) => `@${name}`).join("、") }) : undefined;
                return { id: nanoid(), index, line, prompt: resolved.prompt, refIds: resolved.refIds, status: error ? "error" : "pending", error };
            });
            const origin = nodes.length ? { x: Math.max(...nodes.map((node) => node.position.x + node.width)) + 160, y: Math.min(...nodes.map((node) => node.position.y)) } : { x: 0, y: 0 };
            const metadata: CanvasNodeMetadata = { model: config.model, size: config.size, seconds: config.videoSeconds, vquality: config.vquality, generateAudio: config.videoGenerateAudio, watermark: config.videoWatermark, videoMode: config.videoMode };
            set({ tasks, running: true, run: { projectId, metadata, origin } });
            pump();
        },
        resume: () => {
            set({ running: true });
            pump();
        },
        stop: () => set({ running: false }),
        retry: (taskId) => {
            const task = get().tasks.find((item) => item.id === taskId);
            const context = useAgentStore.getState().canvasContext;
            if (!task || !context || task.status === "running") return;
            if (task.error && !task.nodeId) {
                const resolved = resolveBatchPrompt(task.line, context.snapshot.nodes, context.snapshot.selectedNodeIds);
                if (resolved.missing.length) return patchTask(taskId, { error: tr("mentionMissing", { names: resolved.missing.map((name) => `@${name}`).join("、") }) });
                patchTask(taskId, { prompt: resolved.prompt, refIds: resolved.refIds });
            }
            void runTask(taskId);
        },
    };
});

/** Resolve when the generated video node leaves loading: content means success, anything else is a failure or cancellation. */
function watchVideoNode(nodeId: string, projectId: string) {
    return new Promise<Pick<BatchTask, "status" | "error">>((resolve) => {
        let seenLoading = false;
        let done = false;
        const check = () => {
            const snapshot = useAgentStore.getState().canvasContext?.snapshot;
            if (done || !snapshot || snapshot.projectId !== projectId) return;
            const node = snapshot.nodes.find((item) => item.id === nodeId);
            if (!node) {
                if (seenLoading) finish({ status: "error", error: tr("nodeDeleted") });
                return;
            }
            if (node.metadata?.status === "loading") {
                seenLoading = true;
                return;
            }
            if (!seenLoading) return;
            if (node.metadata?.content) finish({ status: "success", error: undefined });
            else finish({ status: "error", error: node.metadata?.errorDetails || tr("canceled") });
        };
        const finish = (result: Pick<BatchTask, "status" | "error">) => {
            done = true;
            unsubscribe();
            resolve(result);
        };
        const unsubscribe = useAgentStore.subscribe(check);
        check();
    });
}
