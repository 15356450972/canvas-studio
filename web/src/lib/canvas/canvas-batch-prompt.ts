import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export type ResolvedBatchPrompt = { prompt: string; refIds: string[]; missing: string[] };

export function parseBatchPromptLines(text: string) {
    return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/** Resolve @name (image node title) first, then @1 / @图1 (Nth selected image), into ordered reference labels. */
export function resolveBatchPrompt(line: string, nodes: CanvasNodeData[], selectedNodeIds: string[]): ResolvedBatchPrompt {
    const images = nodes.filter((node) => node.type === CanvasNodeType.Image && node.metadata?.content);
    const named = images
        .flatMap((node) => [...new Set([node.title.trim(), node.title.trim().replace(/\.[a-z0-9]+$/i, "")])].filter(Boolean).map((name) => ({ name, id: node.id })))
        .sort((a, b) => b.name.length - a.name.length);
    const selected = selectedNodeIds.filter((id) => images.some((node) => node.id === id));
    const refIds: string[] = [];
    const missing: string[] = [];
    const label = (id: string) => {
        if (!refIds.includes(id)) refIds.push(id);
        return imageReferenceLabel(refIds.indexOf(id));
    };
    let prompt = "";
    let rest = line;
    for (let at = rest.indexOf("@"); at >= 0; at = rest.indexOf("@")) {
        prompt += rest.slice(0, at);
        const tail = rest.slice(at + 1);
        const byName = named.find((item) => tail.startsWith(item.name));
        const byIndex = byName ? null : /^(?:图片?)?(\d+)/.exec(tail);
        const indexId = byIndex ? selected[Number(byIndex[1]) - 1] : undefined;
        if (byName) {
            prompt += label(byName.id);
            rest = tail.slice(byName.name.length);
        } else if (byIndex && indexId) {
            prompt += label(indexId);
            rest = tail.slice(byIndex[0].length);
        } else {
            const token = /^\S*/.exec(tail)?.[0] || "";
            if (token) missing.push(token);
            prompt += `@${token}`;
            rest = tail.slice(token.length);
        }
    }
    return { prompt: prompt + rest, refIds, missing };
}
