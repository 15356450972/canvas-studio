const MAX_STEM_LENGTH = 60;

/** 扩展名只保留 ASCII 字母数字，避免把用户的原始后缀原样带给上游。 */
function extensionFromName(name: string) {
    const match = name.match(/\.([a-z0-9]{1,8})$/i);
    return match ? match[1].toLowerCase() : "";
}

/** 文件类型里可能带参数（image/jpeg; charset=binary），只取主类型。 */
function extensionFromType(type: string | undefined) {
    const normalized = (type || "").split(";")[0].trim().toLowerCase();
    if (normalized.includes("png")) return "png";
    if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
    if (normalized.includes("webp")) return "webp";
    if (normalized.includes("gif")) return "gif";
    if (normalized.includes("wav")) return "wav";
    if (normalized.includes("mp3") || normalized.includes("mpeg")) return "mp3";
    if (normalized.includes("mp4")) return "mp4";
    if (normalized.includes("webm")) return "webm";
    return "bin";
}

/**
 * uguu 之类的公开图床对中文等非 ASCII 文件名会直接返回 500 “Server error.”，
 * 上传前统一压成 ASCII 安全名：保留扩展名，其余字符换成短横线。
 */
export function safeUploadFileName(name: string | undefined, type: string | undefined) {
    const raw = (name || "").trim().split(/[/\\]/).pop() || "";
    const extension = extensionFromName(raw) || extensionFromType(type);
    const stem = raw
        .slice(0, extension ? raw.length - extension.length - 1 : raw.length)
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/-{2,}/g, "-")
        .replace(/^[-_.]+|[-_.]+$/g, "")
        .slice(0, MAX_STEM_LENGTH);
    return `${stem || "file"}.${extension}`;
}
