import { create } from "zustand";
import { persist } from "zustand/middleware";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { parseBatchShots, resolveBatchPrompt } from "@/lib/canvas/canvas-batch-prompt";
import type { CanvasAgentOp, CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { MEDIA_NODE_DISPLAY_EDGE, nodeSizeFromRatio } from "@/lib/canvas/canvas-node-size";
import { VIDEO_SECONDS_MAX, VIDEO_SECONDS_MIN } from "@/lib/media-size";
import { useAgentStore } from "@/stores/use-agent-store";
import { createProtectedStorage } from "@/lib/localforage-storage";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useStorageStatusStore } from "@/stores/use-storage-status-store";
import type { AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeMetadata } from "@/types/canvas";

export type BatchTaskStatus = "pending" | "running" | "success" | "error";
export type BatchTask = { id: string; index: number; line: string; title: string; sequence: string; seconds?: string; prompt: string; refIds: string[]; nodeId?: string; status: BatchTaskStatus; error?: string; interrupted?: boolean };
/** `shot` follows each 分镜's own `镜头N/12s` annotation; `uniform` overrides every shot with one duration. */
export type BatchSecondsSource = "shot" | "uniform";
export type BatchVideoSettings = Partial<Pick<AiConfig, "model" | "size" | "vquality" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark" | "videoMode">> & { secondsSource?: BatchSecondsSource };

type BatchRun = { projectId: string; metadata: CanvasNodeMetadata; bindings: Record<string, string>; selectedNodeIds: string[] };

export type CanvasBatchState = {
    text: string;
    settings: BatchVideoSettings;
    concurrency: number;
    bindings: Record<string, string>;
    /** Per-shot duration overrides keyed by shot number, so a pasted annotation can be changed before import. */
    shotSeconds: Record<string, string>;
    tasks: BatchTask[];
    running: boolean;
    run: BatchRun | null;
};

type CanvasBatchStore = {
    projects: Record<string, CanvasBatchState>;
    hydrated: boolean;
    setBatchState: (projectId: string, patch: Partial<Pick<CanvasBatchState, "text" | "settings" | "concurrency" | "bindings" | "shotSeconds">>) => void;
    prepare: (projectId: string, config: AiConfig, bindings?: Record<string, string>) => "ok" | "no-canvas" | "busy" | "empty" | "unresolved" | "stale-pending";
    start: (projectId: string, config: AiConfig) => void;
    stop: (projectId: string) => void;
    clear: (projectId: string) => boolean;
    retry: (projectId: string, taskId: string, config: AiConfig) => void;
    retryFailed: (projectId: string, config: AiConfig) => void;
    applySettings: (projectId: string, config: AiConfig) => void;
    reconcile: (projectId: string) => void;
};

export const emptyCanvasBatchState: CanvasBatchState = { text: "", settings: {}, concurrency: 3, bindings: {}, shotSeconds: {}, tasks: [], running: false, run: null };

const GRID_COLUMNS = 4;
const GRID_GAP = 48;
const tr = (key: string, options?: Record<string, unknown>) => i18n.t(`agent.batch.${key}`, options);
const runMetadata = (config: AiConfig): CanvasNodeMetadata => ({ model: config.model, size: config.size, seconds: config.videoSeconds, vquality: config.vquality, generateAudio: config.videoGenerateAudio, watermark: config.videoWatermark, videoMode: config.videoMode });
const normalizeSeconds = (value?: string) => {
    const seconds = Math.round(Number(value));
    return value && String(value).trim() && Number.isFinite(seconds) ? String(Math.max(VIDEO_SECONDS_MIN, Math.min(VIDEO_SECONDS_MAX, seconds))) : undefined;
};
const taskMetadata = (task: BatchTask, metadata: CanvasNodeMetadata, settings: BatchVideoSettings): CanvasNodeMetadata => {
    const shot = normalizeSeconds(task.seconds);
    const uniform = normalizeSeconds(settings.videoSeconds);
    // Shot annotations win by default; the unified duration is only a fallback for unannotated shots.
    const seconds = settings.secondsSource === "uniform" ? uniform || shot || metadata.seconds : shot || uniform || metadata.seconds;
    return { ...metadata, seconds, prompt: task.prompt, composerContent: task.prompt, shotSequence: task.sequence, sourcePrompt: task.line };
};
const activeContext = (projectId: string) => {
    const context = useAgentStore.getState().canvasContext;
    return context?.snapshot.projectId === projectId ? context : null;
};

const BATCH_STORE_KEY = "infinite-canvas:canvas_batch_projects";
const batchStorage = createProtectedStorage<CanvasBatchStore>(BATCH_STORE_KEY, {
    hydrate: (value) => {
        const projects = value.state.projects;
        if (!projects || typeof projects !== "object" || Array.isArray(projects) || Object.values(projects).some((project) => !project || !Array.isArray(project.tasks))) {
            throw new Error("批量任务本地数据格式错误，已阻止覆盖");
        }
        return value;
    },
});

export const useCanvasBatchStore = create<CanvasBatchStore>()(persist((set, get) => {
    // Only live page-owned generations are watched; persistence never restarts a paid request.
    const executions = new Map<string, Map<string, object>>();
    const patchProject = (projectId: string, patch: Partial<CanvasBatchState>) => set((state) => {
        const project = state.projects[projectId];
        return project ? { projects: { ...state.projects, [projectId]: { ...project, ...patch } } } : state;
    });
    const patchTask = (projectId: string, id: string, patch: Partial<BatchTask>) => {
        const project = get().projects[projectId];
        if (project?.tasks.some((task) => task.id === id)) patchProject(projectId, { tasks: project.tasks.map((task) => task.id === id ? { ...task, ...patch } : task) });
    };

    const pump = (projectId: string) => {
        const project = get().projects[projectId];
        if (!project?.running) return;
        if (!activeContext(projectId)) return patchProject(projectId, { running: false });
        const active = project.tasks.filter((task) => task.status === "running").length;
        const next = project.tasks.filter((task) => task.status === "pending").slice(0, Math.max(0, project.concurrency - active));
        if (!next.length && !active) return patchProject(projectId, { running: false });
        next.forEach((task) => void runTask(projectId, task.id));
    };

    const observeTask = async (projectId: string, taskId: string, nodeId: string, seenLoading: boolean, before?: CanvasAgentSnapshot) => {
        const token = {};
        let projectExecutions = executions.get(projectId);
        if (!projectExecutions) executions.set(projectId, projectExecutions = new Map());
        if (projectExecutions.has(taskId)) return;
        projectExecutions.set(taskId, token);
        const result = await watchVideoNode(nodeId, projectId, seenLoading, before);
        if (projectExecutions.get(taskId) !== token) return;
        projectExecutions.delete(taskId);
        if (!projectExecutions.size) executions.delete(projectId);
        patchTask(projectId, taskId, result);
        pump(projectId);
    };

    const runTask = async (projectId: string, taskId: string) => {
        const project = get().projects[projectId];
        const task = project?.tasks.find((item) => item.id === taskId);
        const context = activeContext(projectId);
        if (!task || task.status !== "pending" || !project?.run || !context) return;
        try {
            const { nodes, connections } = context.snapshot;
            const node = nodes.find((item) => item.id === task.nodeId);
            if (!node) throw new Error(tr("nodeDeleted"));
            // Node buttons may already have submitted this task. Observe, never submit it twice.
            if (node.metadata?.content) {
                patchTask(projectId, taskId, { status: "success", error: undefined, interrupted: undefined });
                pump(projectId);
                return;
            }
            if (node.metadata?.status === "loading") {
                patchTask(projectId, taskId, { status: "running", error: undefined });
                void observeTask(projectId, taskId, node.id, true);
                return;
            }
            const resolved = resolveBatchPrompt(task.line, nodes, project.run.selectedNodeIds, project.bindings);
            if (resolved.missing.length || resolved.ambiguous.length) throw new Error(tr("mentionMissing", { names: [...resolved.missing, ...resolved.ambiguous].map((name) => `@${name}`).join("、") }));
            patchTask(projectId, taskId, { status: "running", error: undefined, interrupted: undefined, prompt: resolved.prompt, refIds: resolved.refIds });
            const metadata = { ...taskMetadata({ ...task, prompt: resolved.prompt }, project.run.metadata, project.settings), status: "loading" as const, errorDetails: undefined, videoTaskId: undefined, videoTaskProvider: undefined };
            const ops: CanvasAgentOp[] = [
                { type: "update_node", id: node.id, metadata },
                { type: "delete_connections", ids: connections.filter((connection) => connection.toNodeId === node.id).map((connection) => connection.id) },
                ...resolved.refIds.map((fromNodeId): CanvasAgentOp => ({ type: "connect_nodes", fromNodeId, toNodeId: node.id })),
                { type: "run_generation", nodeId: node.id, mode: "video", prompt: resolved.prompt },
            ];
            const snapshot = context.applyOps(ops);
            void observeTask(projectId, taskId, node.id, snapshot.nodes.some((item) => item.id === node.id && item.metadata?.status === "loading"), context.snapshot);
        } catch (error) {
            patchTask(projectId, taskId, { status: "error", error: error instanceof Error ? error.message : String(error) });
            pump(projectId);
        }
    };

    return {
        projects: {},
        hydrated: false,
        setBatchState: (projectId, patch) => {
            batchStorage.requireReady();
            set((state) => {
                const project = state.projects[projectId] || emptyCanvasBatchState;
                return { projects: { ...state.projects, [projectId]: { ...project, ...patch, settings: patch.settings ? { ...project.settings, ...patch.settings } : project.settings } } };
            });
        },
        prepare: (projectId, config, bindings) => {
            const context = activeContext(projectId);
            const project = get().projects[projectId] || emptyCanvasBatchState;
            if (!get().hydrated || !context) return "no-canvas";
            if (project.running || project.tasks.some((task) => task.status === "running")) return "busy";
            const { nodes, selectedNodeIds } = context.snapshot;
            const nextBindings = bindings ?? project.bindings;
            const shots = parseBatchShots(project.text);
            if (!shots.length) return "empty";
            const sameBatch = shots.length === project.tasks.length && project.tasks.every((task, index) => task.line === shots[index].line);
            if (project.tasks.some((task) => task.status === "pending") && !sameBatch) return "stale-pending";
            const resolved = shots.map((shot) => resolveBatchPrompt(shot.line, nodes, selectedNodeIds, nextBindings));
            // Import is atomic: unresolved or ambiguous mentions never produce a partial batch.
            if (resolved.some((item) => item.missing.length || item.ambiguous.length)) return "unresolved";
            const tasks = shots.map((shot, index): BatchTask => {
                const previous = sameBatch ? project.tasks[index] : undefined;
                const seconds = (project.shotSeconds || {})[shot.sequence] ?? shot.seconds;
                if (previous?.nodeId && nodes.some((node) => node.id === previous.nodeId)) return { ...previous, seconds, prompt: resolved[index].prompt, refIds: resolved[index].refIds };
                return { ...shot, seconds, title: `${shot.sequence.padStart(3, "0")} · ${shot.title}`, id: nanoid(), nodeId: nanoid(), index, prompt: resolved[index].prompt, refIds: resolved[index].refIds, status: "pending" };
            });
            const origin = nodes.length ? { x: Math.max(...nodes.map((node) => node.position.x + node.width)) + 160, y: Math.min(...nodes.map((node) => node.position.y)) } : { x: 0, y: 0 };
            const metadata = runMetadata(config);
            const size = nodeSizeFromRatio(metadata.size || "", MEDIA_NODE_DISPLAY_EDGE, MEDIA_NODE_DISPLAY_EDGE) || NODE_DEFAULT_SIZE[CanvasNodeType.Video];
            const cell = { width: size.width + GRID_GAP, height: size.height + GRID_GAP };
            const ops: CanvasAgentOp[] = tasks.filter((task) => !nodes.some((node) => node.id === task.nodeId)).flatMap((task): CanvasAgentOp[] => [
                { type: "add_node", id: task.nodeId, nodeType: CanvasNodeType.Video, title: task.title, position: { x: origin.x + (task.index % GRID_COLUMNS) * cell.width, y: origin.y + Math.floor(task.index / GRID_COLUMNS) * cell.height }, ...size, metadata: { ...taskMetadata(task, metadata, project.settings), status: "idle" } },
                ...task.refIds.map((fromNodeId): CanvasAgentOp => ({ type: "connect_nodes", fromNodeId, toNodeId: task.nodeId! })),
            ]);
            if (ops.length) context.applyOps(ops);
            set((state) => ({ projects: { ...state.projects, [projectId]: { ...project, tasks, bindings: { ...nextBindings }, running: false, run: { projectId, metadata, bindings: { ...nextBindings }, selectedNodeIds: [...selectedNodeIds] } } } }));
            return "ok";
        },
        applySettings: (projectId, config) => {
            const context = activeContext(projectId);
            const project = get().projects[projectId];
            if (!get().hydrated || !context || !project?.run) return;
            const metadata = runMetadata(config);
            const ops = project.tasks.flatMap((task): CanvasAgentOp[] => {
                const node = context.snapshot.nodes.find((item) => item.id === task.nodeId);
                if ((task.status !== "pending" && task.status !== "error") || !node || node.metadata?.content || node.metadata?.status === "loading" || node.metadata?.status === "success") return [];
                const next = taskMetadata(task, metadata, project.settings);
                const changed = Object.entries(next).some(([key, value]) => node.metadata?.[key as keyof CanvasNodeMetadata] !== value);
                return [{ type: "update_node", id: node.id, metadata: { ...next, status: "idle", errorDetails: undefined, ...(changed ? { videoTaskId: undefined, videoTaskProvider: undefined } : {}) } }];
            });
            patchProject(projectId, { run: { ...project.run, metadata, bindings: { ...project.bindings } } });
            if (ops.length) context.applyOps(ops);
        },
        start: (projectId, config) => {
            if (!get().hydrated || !activeContext(projectId)) return;
            get().reconcile(projectId);
            const project = get().projects[projectId];
            if (!project?.run || project.running || !project.tasks.some((task) => task.status === "pending")) return;
            get().applySettings(projectId, config);
            patchProject(projectId, { running: true });
            pump(projectId);
        },
        stop: (projectId) => {
            if (!batchStorage.isReady()) return;
            if (get().projects[projectId]?.running) patchProject(projectId, { running: false });
        },
        clear: (projectId) => {
            const context = activeContext(projectId);
            const project = get().projects[projectId];
            if (!get().hydrated || !context || !project || project.running || project.tasks.some((task) => task.status === "running" || context.snapshot.nodes.some((node) => node.id === task.nodeId && node.metadata?.status === "loading")) || executions.get(projectId)?.size) return false;
            patchProject(projectId, { text: "", bindings: {}, shotSeconds: {}, tasks: [], running: false, run: null });
            return true;
        },
        retry: (projectId, taskId, config) => {
            if (!get().hydrated || !activeContext(projectId)) return;
            get().reconcile(projectId);
            const project = get().projects[projectId];
            const task = project?.tasks.find((item) => item.id === taskId);
            if (!project?.run || task?.status !== "error" || project.tasks.filter((item) => item.status === "running").length >= project.concurrency) return;
            get().applySettings(projectId, config);
            patchTask(projectId, taskId, { status: "pending", error: undefined, interrupted: undefined });
            void runTask(projectId, taskId);
        },
        retryFailed: (projectId, config) => {
            if (!get().hydrated || !activeContext(projectId)) return;
            get().reconcile(projectId);
            const project = get().projects[projectId];
            if (!project?.run || !project.tasks.some((task) => task.status === "error")) return;
            get().applySettings(projectId, config);
            patchProject(projectId, { running: true, tasks: project.tasks.map((task) => task.status === "error" ? { ...task, status: "pending", error: undefined, interrupted: undefined } : task) });
            pump(projectId);
        },
        reconcile: (projectId) => {
            let project = get().projects[projectId];
            const context = activeContext(projectId);
            if (!get().hydrated || !context) return;
            // Only recover a canvas that has no batch record yet. An explicitly cleared
            // record must stay empty even when its old video nodes still exist.
            if (!project) {
                const nodes = context.snapshot.nodes.filter((node) => node.type === CanvasNodeType.Video && node.metadata?.shotSequence && node.metadata.sourcePrompt);
                if (!nodes.length) return;
                const tasks = nodes.map((node, index): BatchTask => {
                    const metadata = node.metadata!;
                    const shot = parseBatchShots(metadata.sourcePrompt!)[0];
                    return { id: nanoid(), index, nodeId: node.id, line: metadata.sourcePrompt!, title: node.title, sequence: metadata.shotSequence!, seconds: shot?.seconds, prompt: metadata.prompt || metadata.sourcePrompt!, refIds: context.snapshot.connections.filter((connection) => connection.toNodeId === node.id).map((connection) => connection.fromNodeId), status: metadata.content ? "success" : metadata.status === "error" || metadata.status === "loading" ? "error" : "pending", ...(metadata.status === "loading" ? { interrupted: true, error: tr("canceled") } : metadata.status === "error" ? { error: metadata.errorDetails || tr("canceled") } : {}) };
                });
                const source = nodes[0].metadata!;
                const settings: BatchVideoSettings = Object.fromEntries(Object.entries({ model: source.model, size: source.size, vquality: source.vquality, videoGenerateAudio: source.generateAudio, videoWatermark: source.watermark, videoMode: source.videoMode }).filter(([, value]) => value !== undefined));
                const bindings = {};
                project = { ...emptyCanvasBatchState, text: tasks.map((task) => task.line).join("\n"), settings, tasks, run: { projectId, metadata: { model: source.model, size: source.size, seconds: source.seconds, vquality: source.vquality, generateAudio: source.generateAudio, watermark: source.watermark, videoMode: source.videoMode }, bindings, selectedNodeIds: [...new Set(tasks.flatMap((task) => task.refIds))] } };
                set((state) => ({ projects: { ...state.projects, [projectId]: project! } }));
            }
            const observe: BatchTask[] = [];
            const interruptedOps: CanvasAgentOp[] = [];
            let changed = false;
            const tasks = project.tasks.map((task): BatchTask => {
                // The live watcher owns completion, including the gap before applyOps publishes its snapshot.
                if (executions.get(projectId)?.has(task.id)) return task;
                const node = context.snapshot.nodes.find((item) => item.id === task.nodeId);
                let patch: Partial<BatchTask> | undefined;
                if (!node) patch = { status: "error", error: tr("nodeDeleted"), interrupted: undefined };
                else if (node.metadata?.content && node.metadata.status !== "loading") patch = { status: "success", error: undefined, interrupted: undefined };
                else if (node.metadata?.status === "loading") {
                    if (node.metadata.videoTaskId || !task.interrupted) {
                        patch = { status: "running", error: undefined, interrupted: undefined };
                        observe.push(task);
                    } else {
                        patch = { status: "error", error: tr("canceled"), interrupted: undefined };
                        interruptedOps.push({ type: "update_node", id: node.id, metadata: { status: "error", errorDetails: tr("canceled") } });
                    }
                } else if (node.metadata?.status === "error" || task.status === "running" || task.interrupted) patch = { status: "error", error: node.metadata?.errorDetails || tr("canceled"), interrupted: undefined };
                if (!patch || Object.entries(patch).every(([key, value]) => task[key as keyof BatchTask] === value)) return task;
                changed = true;
                return { ...task, ...patch };
            });
            if (changed) patchProject(projectId, { tasks });
            if (interruptedOps.length) context.applyOps(interruptedOps);
            observe.forEach((task) => { if (task.nodeId) void observeTask(projectId, task.id, task.nodeId, true); });
        },
    };
}, {
    name: BATCH_STORE_KEY,
    storage: batchStorage.storage,
    partialize: (state) => ({ projects: state.projects }),
    merge: (persisted, current) => {
        const saved = (persisted as Pick<CanvasBatchStore, "projects"> | undefined)?.projects || {};
        const projects = Object.fromEntries(Object.entries(saved).map(([id, project]) => [id, { ...project, running: false, tasks: project.tasks.map((task): BatchTask => task.status === "running" ? { ...task, status: "error", error: tr("canceled"), interrupted: true } : task) }]));
        return { ...current, projects: { ...projects, ...current.projects } };
    },
    // The outer callback runs synchronously inside create(), so it must not touch the store
    // variable before initialization; it reads the state argument like the other stores.
    onRehydrateStorage: (state) => {
        batchStorage.beginHydration();
        if (state.hydrated) useCanvasBatchStore.setState({ hydrated: false });
        return (_state, error) => {
            if (error) {
                batchStorage.finishHydration(error);
                return;
            }
            useCanvasBatchStore.setState({ hydrated: true });
            batchStorage.finishHydration();
            pruneDeletedProjects();
        };
    },
}));

/** Resolve only this project's result, including page teardown; never follow a new canvas. */
function watchVideoNode(nodeId: string, projectId: string, seenLoading: boolean, before?: CanvasAgentSnapshot) {
    return new Promise<Pick<BatchTask, "status" | "error" | "interrupted">>((resolve) => {
        let done = false;
        let queued = false;
        const finish = (result: Pick<BatchTask, "status" | "error" | "interrupted">) => {
            done = true;
            unsubscribe();
            resolve(result);
        };
        const check = () => {
            if (done || queued) return;
            queued = true;
            // The bridge clears its context in effect cleanup even for ordinary snapshot updates.
            queueMicrotask(() => {
                queued = false;
                if (done) return;
                const snapshot = activeContext(projectId)?.snapshot;
                if (!snapshot) return finish({ status: "error", error: tr("canvasMissing"), interrupted: true });
                if (snapshot.nodes === before?.nodes) return;
                const node = snapshot.nodes.find((item) => item.id === nodeId);
                if (!node) return finish({ status: "error", error: tr("nodeDeleted") });
                if (node.metadata?.status === "loading") {
                    seenLoading = true;
                    return;
                }
                if (!seenLoading) return;
                if (node.metadata?.content) finish({ status: "success", error: undefined, interrupted: undefined });
                else finish({ status: "error", error: node.metadata?.errorDetails || tr("canceled"), interrupted: undefined });
            });
        };
        const unsubscribe = useAgentStore.subscribe(check);
        check();
    });
}

// One-way subscriptions keep deletion and navigation local to this store, without importing it into the canvas store.
function pruneDeletedProjects() {
    const canvas = useCanvasStore.getState();
    const batch = useCanvasBatchStore.getState();
    if (!canvas.hydrated || !batch.hydrated) return;
    if (Object.values(useStorageStatusStore.getState().issues).some((issue) => issue.key === "infinite-canvas:canvas_store" && issue.operation === "read" && issue.severity === "warning")) return;
    const ids = new Set(canvas.projects.map((project) => project.id));
    const projects = Object.fromEntries(Object.entries(batch.projects).filter(([id]) => ids.has(id)));
    if (Object.keys(projects).length !== Object.keys(batch.projects).length) useCanvasBatchStore.setState({ projects });
}
useCanvasStore.subscribe((state, previous) => {
    if (state.hydrated !== previous.hydrated || state.deletedProjects !== previous.deletedProjects || (state.projects !== previous.projects && state.projects.length !== previous.projects.length)) pruneDeletedProjects();
});
let contextCheckQueued = false;
useAgentStore.subscribe((state, previous) => {
    if (state.canvasContext === previous.canvasContext || contextCheckQueued) return;
    contextCheckQueued = true;
    queueMicrotask(() => {
        contextCheckQueued = false;
        const activeId = useAgentStore.getState().canvasContext?.snapshot.projectId;
        const batch = useCanvasBatchStore.getState();
        Object.entries(batch.projects).forEach(([id, project]) => { if (id !== activeId && project.running) batch.stop(id); });
        if (activeId) batch.reconcile(activeId);
    });
});
