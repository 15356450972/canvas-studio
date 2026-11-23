import { fetchableMediaUrl } from "@/lib/media-url";
import { isDesktop } from "@/services/desktop";

type DesktopDragBridge = {
    dragFile: (name: string, buffer: ArrayBuffer) => void;
};

declare global {
    interface Window {
        canvasDesktop?: DesktopDragBridge;
    }
}

/** 桌面壳装好了系统拖拽桥才能拖到外部应用；浏览器里没有这条通道。 */
export function canDragToDesktop() {
    return isDesktop && typeof window !== "undefined" && Boolean(window.canvasDesktop);
}

// 同一地址只读一次：节点被悬停时预热，真正按下拖拽时就不用再等网络。
// 只留最近几份，避免连着浏览多个视频把内存吃满。
const MAX_CACHED = 4;
const buffers = new Map<string, Promise<ArrayBuffer>>();

function loadBuffer(url: string) {
    const pending = buffers.get(url);
    if (pending) return pending;
    const task = fetch(fetchableMediaUrl(url)).then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
    });
    // 失败不留在缓存里，下次还能重试。
    task.catch(() => buffers.delete(url));
    buffers.set(url, task);
    while (buffers.size > MAX_CACHED) {
        const oldest = buffers.keys().next().value;
        if (oldest === undefined) break;
        buffers.delete(oldest);
    }
    return task;
}

/** 提前把媒体读成字节，拖拽时只差一次 IPC，按下就能开始拖。 */
export function prepareDragOut(url?: string) {
    if (!url || !canDragToDesktop()) return;
    void loadBuffer(url).catch(() => undefined);
}

/** 以真实文件的形式拖到剪映、Finder 等外部应用；返回是否真的发起了拖拽。 */
export async function dragMediaOut(url: string, name: string) {
    if (!canDragToDesktop()) return false;
    const buffer = await loadBuffer(url);
    window.canvasDesktop!.dragFile(name, buffer);
    return true;
}
