import axios from "axios";

import i18n from "@/i18n";
import { fetchableMediaUrl, isEphemeralMediaUrl, isStablePublicUrl } from "@/lib/media-url";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob, uploadImage, type UploadedImage } from "@/services/image-storage";
import { withLocalProxy } from "@/stores/use-config-store";

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

function fileName(source: PublicUploadSource, blob: Blob) {
    const raw = (source.name || "").trim().split(/[/\\]/).pop() || "";
    if (raw && /\.[a-z0-9]+$/i.test(raw)) return raw;
    const type = (source.type || blob.type || "").toLowerCase();
    const ext = type.includes("png")
        ? "png"
        : type.includes("jpeg") || type.includes("jpg")
          ? "jpg"
          : type.includes("webp")
            ? "webp"
            : type.includes("gif")
              ? "gif"
              : type.includes("wav")
                ? "wav"
                : type.includes("mp3") || type.includes("mpeg")
                  ? "mp3"
                  : type.includes("mp4")
                    ? "mp4"
                    : type.includes("webm")
                      ? "webm"
                      : "bin";
    return `${raw || "file"}.${ext}`;
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
        const { data } = await axios.post<UguuUploadResponse>(uguuUploadUrl(), form, { signal: options?.signal });
        const url = data.files?.[0]?.url;
        if (!data.success || !url) throw new Error(data.description || apiText("publicUploadFailed", { message: "" }));
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

/** 生成结果只落本地，不再预先上传公网。 */
export async function persistGeneratedImage(input: string | Blob, options?: UploadOptions): Promise<UploadedImage> {
    return uploadImage(input, options);
}
