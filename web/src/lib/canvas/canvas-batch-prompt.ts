import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export type BatchShot = { line: string; sequence: string; title: string; seconds?: string };
export type ResolvedBatchPrompt = { prompt: string; refIds: string[]; missing: string[]; ambiguous: string[]; mentions: string[] };

/** Scene/shot headings delimit shots: `1. [场景] - [镜头1 / 12s]`, `[场景A] + [场景B] - [镜头1/12s]`. Timeline ranges stay body text. */
export function parseBatchShots(text: string): BatchShot[] {
    const headings = [...text.matchAll(/(?:(\d+)[.．、]\s*)?((?:[\[【](?!镜头)[^\]】\r\n]{1,80}[\]】](?:\s*[+＋]\s*)?)+)\s*[-—–]\s*[\[【](镜头[^\]】/\r\n]{0,20})(?:\s*\/\s*(\d+(?:\.\d+)?)\s*[sS秒])?\s*[\]】]/g)].filter(
        // Without a leading number the heading must open its own line, so body text keeps mid-line brackets.
        (heading) => heading[1] || !text.slice(text.lastIndexOf("\n", heading.index! - 1) + 1, heading.index).trim(),
    );
    if (!headings.length) return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => ({ line, sequence: String(index + 1), title: line.slice(0, 32) }));
    const style = text.slice(0, headings[0].index).trim();
    const starts = headings.map((heading, index) => {
        if (!index) return 0;
        const previousEnd = headings[index - 1].index! + headings[index - 1][0].length;
        // Repeated opening style belongs to the next shot, even after “禁止输出BGM” on the same line.
        const repeated = style ? text.lastIndexOf(style, heading.index) : -1;
        if (repeated >= previousEnd && !text.slice(repeated + style.length, heading.index).trim()) return repeated;
        const groupMark = text.slice(previousEnd, heading.index).search(/【组\d+/);
        if (groupMark >= 0) return previousEnd + groupMark;
        const newline = text.lastIndexOf("\n", heading.index! - 1);
        return newline >= previousEnd ? newline + 1 : heading.index!;
    });
    return headings.map((heading, index) => ({
        line: text.slice(starts[index], starts[index + 1] ?? text.length).trim(),
        sequence: /(\d+)/.exec(heading[3])?.[1] || heading[1] || String(index + 1),
        title: `${heading[2].replace(/[\[【]|[\]】]/g, "").replace(/\s*[+＋]\s*/g, " + ").trim()} - ${heading[3].trim()}`,
        ...(heading[4] ? { seconds: heading[4] } : {}),
    }));
}

export function parseBatchPromptLines(text: string) {
    return parseBatchShots(text).map((shot) => shot.line);
}

/** Named mentions require a word boundary; duplicate names need an explicit node binding. */
export function resolveBatchPrompt(line: string, nodes: CanvasNodeData[], selectedNodeIds: string[], bindings: Record<string, string> = {}): ResolvedBatchPrompt {
    const images = nodes.filter((node) => node.type === CanvasNodeType.Image && node.metadata?.content);
    const stripExtension = (name: string) => name.replace(/\.[a-z0-9]+$/i, "");
    const names = new Map<string, string[]>();
    images.forEach((node) => {
        [node.title.trim(), stripExtension(node.title.trim())].filter(Boolean).forEach((name) => names.set(name, [...new Set([...(names.get(name) || []), node.id])]));
    });
    // Keep binding aliases even if the selected image has a different title now.
    Object.keys(bindings).forEach((name) => {
        [name, stripExtension(name)].filter(Boolean).forEach((alias) => {
            if (!names.has(alias)) names.set(alias, []);
        });
    });
    const named = [...names.keys()].sort((a, b) => b.length - a.length);
    const selected = selectedNodeIds.filter((id) => images.some((node) => node.id === id));
    const refIds: string[] = [];
    const missing = new Set<string>();
    const ambiguous = new Set<string>();
    const mentions = new Set<string>();
    const label = (id: string) => {
        if (!refIds.includes(id)) refIds.push(id);
        return imageReferenceLabel(refIds.indexOf(id));
    };
    let prompt = "";
    let rest = line;
    for (let at = rest.indexOf("@"); at >= 0; at = rest.indexOf("@")) {
        prompt += rest.slice(0, at);
        const tail = rest.slice(at + 1);
        const name = named.find((item) => tail.startsWith(item) && !/^[\p{L}\p{N}_（(-]/u.test(tail.slice(item.length)));
        const byIndex = name ? null : /^(?:图片?)?(\d+)(?![\p{L}\p{N}_-])/u.exec(tail);
        const token = name || byIndex?.[0] || /^[^\s@，。！？；：、,!?;:（）()\[\]【】“”"'<>]+(?:（[^）\r\n]*）|\([^\)\r\n]*\))?/.exec(tail)?.[0] || "";
        const mention = stripExtension(token);
        if (mention) mentions.add(mention);
        const boundId = bindings[token] || bindings[mention] || Object.entries(bindings).find(([alias]) => stripExtension(alias) === mention)?.[1];
        const candidates = name ? names.get(name)! : [];
        const id = boundId ? images.find((node) => node.id === boundId)?.id : name ? (candidates.length === 1 ? candidates[0] : undefined) : byIndex ? selected[Number(byIndex[1]) - 1] : undefined;
        if (id) prompt += label(id);
        else {
            if (mention) (name && !boundId && candidates.length > 1 ? ambiguous : missing).add(mention);
            prompt += `@${token}`;
        }
        rest = tail.slice(token.length);
    }
    return { prompt: prompt + rest, refIds, missing: [...missing], ambiguous: [...ambiguous], mentions: [...mentions] };
}
