export type CanvasTool = "select" | "pan";

export function getCanvasToolAfterShortcut(current: CanvasTool): CanvasTool {
    return current === "select" ? "pan" : "select";
}

export function getShouldHandleCanvasToolToggle({
    key,
    metaKey,
    ctrlKey,
    altKey,
    isEditable,
    isShortcutsIgnored,
}: {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    isEditable: boolean;
    isShortcutsIgnored: boolean;
}): boolean {
    return key.toLowerCase() === "a" && !metaKey && !ctrlKey && !altKey && !isEditable && !isShortcutsIgnored;
}
