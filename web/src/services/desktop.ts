/** 桌面应用用 app:// 加载页面，并由主进程提供 /__media、/__desktop 同域路由；浏览器里这些路由不存在。 */
export const isDesktop = typeof window !== "undefined" && window.location.protocol === "app:";

/** 由主进程代为下载，绕开图床不允许网页跨域读取的限制。 */
export function desktopMediaUrl(url: string) {
    return `/__media/${encodeURIComponent(url)}`;
}

async function imageFolder(path: string, init?: RequestInit, kind: "image" | "video" = "image") {
    const response = await fetch(`/__desktop/${kind}-folder${path}`, init);
    const data = (await response.json()) as { path?: string; error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data.path || "";
}

/** 返回当前保存文件夹的路径，未设置时为空字符串。 */
export const readVideoFolder = () => imageFolder("", undefined, "video");
export const pickVideoFolder = () => imageFolder("/pick", { method: "POST" }, "video");
export const clearVideoFolder = () => imageFolder("/clear", { method: "POST" }, "video");
export const writeVideoFile = async (name: string, blob: Blob) => imageFolder(`/files/${encodeURIComponent(name)}`, { method: "POST", body: await blob.arrayBuffer() }, "video");

export const readImageFolder = () => imageFolder("");
export const pickImageFolder = () => imageFolder("/pick", { method: "POST" });
export const clearImageFolder = () => imageFolder("/clear", { method: "POST" });
/** 写入保存文件夹，返回实际落盘路径；同名文件不会被覆盖，会自动加序号。 */
export const writeImageFile = async (name: string, blob: Blob) => imageFolder(`/files/${encodeURIComponent(name)}`, { method: "POST", body: await blob.arrayBuffer() });