import axios from "axios";
import dayjs from "dayjs";

import i18n from "@/i18n";
import { fetchableMediaUrl, isEphemeralMediaUrl, isStablePublicUrl } from "@/lib/media-url";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob, uploadImage, type UploadedImage } from "@/services/image-storage";
import { withLocalProxy } from "@/stores/use-config-store";
import { retryPublicUpload } from "@/services/public-upload-retry";
import { safeUploadFileName } from "@/services/public-upload-name";
import { saveGeneratedImageToFolder } from "@/stores/use-image-folder-store";

const UGUU_UPLOAD = "https://uguu.se/upload";
const DEV_UGUU_UPLOAD = "/__uguu/upload";
const MAX_BYTES = 128 * 1024 * 1024;

export type PublicUploadSource = {
    name?: string;
    type?: string;
    url?: string;
    dataUrl?: string;
    publicUrl?: string;
    storageKey?: string;
    taskId?: string;
};

type UguuUploadResponse = {
    success?: boolean;
    description?: string;
    files?: Array<{ url?: string; filename?: string }>;
};

type UploadOptions = { signal?: AbortSignal; force?: boolean };

const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

export { isPublicHttpUrl, isStablePublicUrl } from "@/lib/media-url";

function uguuUploadUrl() {
    const proxied = withLocalProxy(UGUU_UPLOAD);
    if (proxied !== UGUU_UPLOAD) return proxied;
    // Same-origin /__uguu is provided by Vite in dev and by Nginx in production.
    return DEV_UGUU_UPLOAD;
}

/** 文件名会原样进入 multipart，非 ASCII 名会让 uguu 返回 500，统一转成安全名。 */
function fileName(source: PublicUploadSource, blob: Blob) {
    return safeUploadFileName(source.name, source.type || blob.type);
}

async function loadBlob(source: PublicUploadSource, signal?: AbortSignal) {
    if (source.storageKey) {
        const stored = (await getImageBlob(source.storageKey)) || (await getMediaBlob(source.storageKey));
        if (stored) return stored;
    }
    const src = source.dataUrl || source.url;
    if (!src) throw new Error(apiText("publicUploadNoFile"));
    const response = await fetch(src.startsWith("blob:") || src.startsWith("data:") ? src : fetchableMediaUrl(src), { signal });
    if (!response.ok) throw new Error(isEphemeralMediaUrl(src) ? apiText("referenceUrlExpired") : apiText("publicUploadNoFile"));
    const blob = await response.blob();
    if (!blob.size) throw new Error(apiText("publicUploadNoFile"));
    return blob;
}

export async function uploadPublicFile(blob: Blob, name: string, options?: UploadOptions) {
    if (blob.size > MAX_BYTES) throw new Error(apiText("publicUploadTooLarge"));
    const form = new FormData();
    form.append("files[]", blob, name || "file.bin");
    try {
        const { data } = await retryPublicUpload(
            async () => {
                const response = await axios.post<UguuUploadResponse>(uguuUploadUrl(), form, { signal: options?.signal });
                if (!response.data.success || !response.data.files?.[0]?.url) {
                    const failure = new Error(response.data.description || apiText("publicUploadFailed", { message: "" }));
                    if (/\b(server error|bad gateway|service unavailable|gateway timeout)\b/i.test(failure.message)) Object.assign(failure, { code: 503 });
                    throw failure;
                }
                return response;
            },
            { delay: (ms) => new Promise<void>((resolve) => window.setTimeout(resolve, ms)) },
        );
        const url = data.files?.[0]?.url;
        if (!url) throw new Error(data.description || apiText("publicUploadFailed", { message: "" }));
        return url;
    } catch (error) {
        if (axios.isCancel(error) || (error instanceof DOMException && error.name === "AbortError")) throw error;
        if (error instanceof Error && !axios.isAxiosError(error)) throw error;
        const detail = axios.isAxiosError(error) ? (typeof error.response?.data === "object" && error.response.data && "description" in error.response.data ? String(error.response.data.description || "") : error.message) : "";
        throw new Error(apiText("publicUploadFailed", { message: detail ? `：${detail}` : "" }));
    }
}

/** 垫图只在真正发请求时上传，不缓存临时链接（uguu 约 3 小时过期）。 */
export async function resolvePublicHttpUrl(source: PublicUploadSource, options?: UploadOptions) {
    const local = Boolean(source.storageKey || source.dataUrl?.startsWith("data:") || source.dataUrl?.startsWith("blob:"));
    if (!options?.force && !local) {
        const existing = isStablePublicUrl(source.publicUrl) || isStablePublicUrl(source.url) || isStablePublicUrl(source.dataUrl);
        if (existing) return existing;
    }
    const blob = await loadBlob(source, options?.signal);
    return uploadPublicFile(blob, fileName(source, blob), options);
}

export async function resolvePublicHttpUrls(sources: PublicUploadSource[], options?: UploadOptions) {
    return Promise.all(sources.map((source) => resolvePublicHttpUrl(source, options)));
}

/** 生成结果只落本地，不再预先上传公网；桌面应用设置了保存文件夹时再另存一份原文件，name 为文件名（不含扩展名）。 */
export async function persistGeneratedImage(input: string | Blob, options?: UploadOptions & { name?: string }): Promise<UploadedImage> {
    const stored = await uploadImage(input, options);
    const blob = stored.storageKey ? await getImageBlob(stored.storageKey) : null;
    if (blob) void saveGeneratedImageToFolder(blob, options?.name || dayjs().format("YYYYMMDD-HHmmss"));
    return stored;
}
