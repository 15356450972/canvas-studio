export const MEDIA_NODE_DISPLAY_EDGE = 640;

export function videoNodeSize(width: number, height: number, edge = MEDIA_NODE_DISPLAY_EDGE) {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const scale = edge / Math.max(w, h);
    return { width: w * scale, height: h * scale };
}

export function fitNodeSize(width: number, height: number, maxWidth = MEDIA_NODE_DISPLAY_EDGE, maxHeight = MEDIA_NODE_DISPLAY_EDGE) {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const scale = Math.min(1, maxWidth / w, maxHeight / h);
    return { width: w * scale, height: h * scale };
}

export function nodeSizeFromRatio(size: string, baseWidth: number, baseHeight: number) {
    const match = size?.match(/^(\d+)(?:x|:)(\d+)/);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    const ratio = width / Math.max(1, height);
    if (ratio < 0.25 || ratio > 4) return { width: baseWidth, height: baseHeight };
    return ratio >= baseWidth / baseHeight ? { width: baseWidth, height: baseWidth / ratio } : { width: baseHeight * ratio, height: baseHeight };
}
