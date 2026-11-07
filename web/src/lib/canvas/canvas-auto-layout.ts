import { CanvasNodeType, type CanvasNodeData, type Position } from "@/types/canvas";
import { getGroupWrapRect, GROUP_WRAP_PADDING, GROUP_WRAP_TOP_PADDING, nodeBounds } from "./canvas-node-geometry";
import { MEDIA_NODE_DISPLAY_EDGE, videoNodeSize } from "./canvas-node-size";

const GAP = 64;

function arrangeGrid(nodes: CanvasNodeData[], origin: Position, aspect: number) {
    if (!nodes.length) return nodes;
    const totalWidth = nodes.reduce((sum, node) => sum + node.width, 0);
    const totalHeight = nodes.reduce((sum, node) => sum + node.height, 0);
    const columns = Math.min(nodes.length, Math.max(1, Math.round(Math.sqrt(nodes.length * aspect * totalHeight / totalWidth))));
    const widths = Array<number>(columns).fill(0);
    const heights = Array<number>(Math.ceil(nodes.length / columns)).fill(0);
    nodes.forEach((node, index) => {
        widths[index % columns] = Math.max(widths[index % columns], node.width);
        const row = Math.floor(index / columns);
        heights[row] = Math.max(heights[row], node.height);
    });
    const xs = [origin.x];
    const ys = [origin.y];
    widths.forEach((width, index) => xs.push(xs[index] + width + GAP));
    heights.forEach((height, index) => ys.push(ys[index] + height + GAP));
    return nodes.map((node, index) => {
        const position = { x: xs[index % columns], y: ys[Math.floor(index / columns)] };
        return position.x === node.position.x && position.y === node.position.y ? node : { ...node, position };
    });
}

function arrangeByType(nodes: CanvasNodeData[], origin: Position, aspect: number) {
    const blocks = new Map<string, CanvasNodeData[]>([CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio, CanvasNodeType.Text, CanvasNodeType.Config, CanvasNodeType.Group].map((type) => [type, []]));
    nodes.forEach((node) => {
        const block = blocks.get(node.type) || [];
        block.push(node);
        blocks.set(node.type, block);
    });
    let x = origin.x;
    return [...blocks.values()].flatMap((block) => {
        if (!block.length) return [];
        const arranged = arrangeGrid(block, { x, y: origin.y }, aspect);
        x = nodeBounds(arranged).right + GAP;
        return arranged;
    });
}

/** Arrange adjacent type blocks, enlarging small videos and preserving existing canvas groups. */
export function arrangeCanvasNodes(nodes: CanvasNodeData[], aspect = 16 / 9) {
    if (!nodes.length) return nodes;
    nodes = nodes.map((node) => {
        if (node.type !== CanvasNodeType.Video) return node;
        const size = videoNodeSize(node.width, node.height, Math.max(MEDIA_NODE_DISPLAY_EDGE, node.width, node.height));
        return node.width === size.width && node.height === size.height ? node : { ...node, ...size };
    });
    const groups = new Map(nodes.filter((node) => node.type === CanvasNodeType.Group).map((node) => [node.id, node]));
    const members = new Map<string, CanvasNodeData[]>();
    nodes.forEach((node) => {
        const groupId = node.metadata?.groupId;
        if (node.type !== CanvasNodeType.Group && groupId && groups.has(groupId)) {
            const list = members.get(groupId) || [];
            list.push(node);
            members.set(groupId, list);
        }
    });
    const updated = new Map(nodes.map((node) => [node.id, node]));
    members.forEach((children, groupId) => {
        const group = groups.get(groupId)!;
        const arranged = arrangeByType(children, { x: group.position.x + GROUP_WRAP_PADDING, y: group.position.y + GROUP_WRAP_TOP_PADDING }, aspect);
        arranged.forEach((node) => updated.set(node.id, node));
        const rect = getGroupWrapRect(arranged);
        if (group.width !== rect.width || group.height !== rect.height) updated.set(groupId, { ...group, width: rect.width, height: rect.height });
    });
    const roots = nodes.filter((node) => node.type === CanvasNodeType.Group || !node.metadata?.groupId || !groups.has(node.metadata.groupId)).map((node) => updated.get(node.id)!);
    const bounds = nodeBounds(roots);
    arrangeByType(roots, { x: bounds.left, y: bounds.top }, aspect).forEach((node) => {
        const previous = updated.get(node.id)!;
        const dx = node.position.x - previous.position.x;
        const dy = node.position.y - previous.position.y;
        updated.set(node.id, node);
        if (dx || dy) members.get(node.id)?.forEach((child) => {
            const current = updated.get(child.id)!;
            updated.set(child.id, { ...current, position: { x: current.position.x + dx, y: current.position.y + dy } });
        });
    });
    return nodes.map((node) => updated.get(node.id)!);
}
