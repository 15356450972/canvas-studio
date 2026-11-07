import axios from "axios";

import i18n from "@/i18n";
import { buildApiUrl, guessCapability, isBuiltInChannel, isOiioiiBaseUrl, isWankeChannel, OIIOII_CHANNEL_ID, resolveModelRequestConfig, resolveModelScript, withLocalProxy, type AiConfig, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";
import { normalizePluginImages, runModelPlugin } from "./model-plugin";
import { nanoid } from "nanoid";
import { dataUrlToFile } from "@/lib/image-utils";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { imageToDataUrl } from "@/services/image-storage";
import { fetchableMediaUrl, isEphemeralMediaUrl } from "@/lib/media-url";
import { persistGeneratedImage, resolvePublicHttpUrl, resolvePublicHttpUrls } from "@/services/public-upload";
import { imageSizePresets, inferMediaScale } from "@/lib/media-size";
import type { ReferenceImage } from "@/types/image";

const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

export type AiTextMessage = {
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

type ResponseToolCall = {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
    thoughtSignature?: string;
};

type ResponseInputMessage =
    | AiTextMessage
    | { type: "function_call"; call_id: string; name: string; arguments: string; thoughtSignature?: string }
    | { role: "tool"; tool_call_id: string; content: string };

type ResponseFunctionTool = {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters: Record<string, unknown>;
        strict?: boolean;
    };
};

type ToolResponseResult = {
    content: string;
    toolCalls: ResponseToolCall[];
};

type ToolChoice = "auto" | "required" | { type: "function"; name: string };
type ResponseMessageContent = AiTextMessage["content"] | string;
type ResponseInputContent = { type: "input_text"; text: string } | { type: "input_image"; image_url: string };
type ResponseInputItem =
    | { role: "system" | "user" | "assistant"; content: string | ResponseInputContent[] }
    | { type: "function_call"; call_id: string; name: string; arguments: string }
    | { type: "function_call_output"; call_id: string; output: string };
type ResponseApiToolDefinition = {
    type: "function";
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
};
type ResponseApiOutputItem =
    | { type?: "message"; content?: Array<{ type?: string; text?: string }> }
    | { type?: "function_call"; id?: string; call_id?: string; name?: string; arguments?: string };
type ResponseApiPayload = {
    id?: string;
    output?: ResponseApiOutputItem[];
    output_text?: string;
    error?: { message?: string };
    code?: number;
    msg?: string;
};
type ResponseStreamState = { buffer: string; text: string; payload?: ResponseApiPayload; error?: string };

type ImageApiResponse = {
    data?: Array<Record<string, unknown>>;
    error?: { message?: string };
    code?: number;
    msg?: string;
};
type GeminiPart = {
    text?: string;
    inlineData?: { mimeType?: string; data?: string };
    inline_data?: { mime_type?: string; mimeType?: string; data?: string };
    fileData?: { mimeType?: string; fileUri?: string };
    functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
    functionResponse?: { id?: string; name?: string; response?: Record<string, unknown> };
    thoughtSignature?: string;
    thought_signature?: string;
};
type GeminiContent = { role?: "user" | "model"; parts: GeminiPart[] };
type GeminiPayload = {
    candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
    models?: Array<{ name?: string }>;
    error?: { message?: string };
    promptFeedback?: { blockReason?: string };
};
type GeminiStreamState = { buffer: string; text: string; toolCalls: ResponseToolCall[]; error?: string };
type RequestOptions = { signal?: AbortSignal; onTaskCreated?: (taskId: string) => void; forcePublicUpload?: boolean };
type RequestedImage = { id: string; dataUrl: string; taskId?: string };

const QUALITY_BASE: Record<string, number> = {
    low: 1024,
    medium: 2048,
    high: 2880,
    standard: 1024,
    hd: 2048,
};
const QUALITY_ALIASES: Record<string, string> = {
    "1k": "low",
    "2k": "medium",
    "4k": "high",
};
const DEFAULT_IMAGE_SHORT_SIDE = 1024;
const IMAGE_SIZE_STEP = 16;
const IMAGE_MIN_PIXELS = 655360;
const IMAGE_MAX_PIXELS = 8294400;
const IMAGE_MAX_EDGE = 3840;
const IMAGE_MAX_RATIO = 3;
const IMAGE_OUTPUT_FORMAT = "png";

const GEMINI_SUPPORTED_RATIOS = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"];
const GEMINI_IMAGE_SIZE_BY_QUALITY: Record<string, string> = { low: "1K", medium: "2K", high: "4K", standard: "1K", hd: "2K" };

function normalizeQuality(quality: string) {
    const value = quality.trim().toLowerCase();
    const normalized = QUALITY_ALIASES[value] || value;
    return QUALITY_BASE[normalized] ? normalized : undefined;
}

/** Only "transparent" is forwarded; any other value (incl. empty) means keep the default opaque background. */
function normalizeBackground(background: string | undefined) {
    return background?.trim().toLowerCase() === "transparent" ? "transparent" : undefined;
}

/** Map "quality + ratio" to an explicit pixel dimension like "3840x2160". */
function resolveSize(quality: string | undefined, ratio: string): string {
    const parsedRatio = parseImageRatio(ratio);
    const scale = quality === "high" ? "4k" : quality === "medium" || quality === "hd" ? "2k" : "1k";
    const preset = imageSizePresets[scale][ratio];
    if (preset) return preset;
    const basePixels = quality ? QUALITY_BASE[quality] : undefined;
    const isLandscape = parsedRatio.width >= parsedRatio.height;
    const longRatio = isLandscape ? parsedRatio.width / parsedRatio.height : parsedRatio.height / parsedRatio.width;
    let longSide: number;
    let shortSide: number;

    if (basePixels) {
        const targetPixels = basePixels * basePixels;
        const longSideRaw = Math.sqrt(targetPixels * longRatio);
        longSide = Math.floor(longSideRaw / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
        shortSide = Math.round(longSide / longRatio / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    } else {
        shortSide = DEFAULT_IMAGE_SHORT_SIDE;
        longSide = Math.round((shortSide * longRatio) / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    }

    const width = isLandscape ? longSide : shortSide;
    const height = isLandscape ? shortSide : longSide;
    validateImageSize(width, height);
    return `${width}x${height}`;
}

function parseRatioValue(value: string) {
    const parts = value.split(":");
    if (parts.length !== 2) throw new Error(apiText("invalidImageSizeFormat"));
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new Error(apiText("positiveImageRatio"));
    return { width: w, height: h };
}

function parseImageRatio(value: string) {
    const ratio = parseRatioValue(value);
    if (Math.max(ratio.width, ratio.height) / Math.min(ratio.width, ratio.height) > IMAGE_MAX_RATIO) throw new Error(apiText("imageRatioLimit"));
    return ratio;
}

function parseImageDimensions(value: string) {
    const match = value.match(/^(\d+)x(\d+)$/i);
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
}

function validateImageSize(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error(apiText("positiveImageDimensions"));
    if (width % IMAGE_SIZE_STEP !== 0 || height % IMAGE_SIZE_STEP !== 0) throw new Error(apiText("imageDimensionStep"));
    if (Math.max(width, height) > IMAGE_MAX_EDGE) throw new Error(apiText("imageEdgeLimit"));
    if (Math.max(width, height) / Math.min(width, height) > IMAGE_MAX_RATIO) throw new Error(apiText("imageRatioLimit"));
    const pixels = width * height;
    if (pixels < IMAGE_MIN_PIXELS || pixels > IMAGE_MAX_PIXELS) throw new Error(apiText("imagePixelLimit"));
}

function resolveRequestSize(quality: string | undefined, size: string) {
    const value = size.trim();
    if (!value || value.toLowerCase() === "auto") return undefined;
    const dimensions = parseImageDimensions(value);
    if (dimensions) {
        validateImageSize(dimensions.width, dimensions.height);
        return `${dimensions.width}x${dimensions.height}`;
    }
    if (value.includes(":")) return resolveSize(quality, value);
    throw new Error(apiText("invalidImageSizeFormat"));
}

function resolveGeminiImageConfig(config: AiConfig) {
    const value = config.size.trim();
    const dimensions = parseImageDimensions(value);
    const ratio = dimensions ? `${dimensions.width}:${dimensions.height}` : value;
    const aspectRatio = value && value.toLowerCase() !== "auto" ? closestGeminiAspectRatio(ratio) : undefined;
    const imageSize = supportsGeminiImageSize(config.model) ? resolveGeminiImageSize(config.quality, dimensions) : undefined;
    const image = { ...(aspectRatio ? { aspectRatio } : {}), ...(imageSize ? { imageSize } : {}) };
    return Object.keys(image).length ? { imageConfig: image } : {};
}

function closestGeminiAspectRatio(value: string) {
    const ratio = parseImageRatio(value);
    const target = ratio.width / ratio.height;
    return GEMINI_SUPPORTED_RATIOS.reduce((best, item) => {
        const current = parseRatioValue(item);
        const bestRatio = parseRatioValue(best);
        return Math.abs(current.width / current.height - target) < Math.abs(bestRatio.width / bestRatio.height - target) ? item : best;
    });
}

function resolveGeminiImageSize(quality: string, dimensions: { width: number; height: number } | null) {
    const normalizedQuality = normalizeQuality(quality);
    if (normalizedQuality) return GEMINI_IMAGE_SIZE_BY_QUALITY[normalizedQuality];
    if (!dimensions) return undefined;
    const size = `${dimensions.width}x${dimensions.height}`;
    const scale = inferMediaScale(size);
    if (Object.values(imageSizePresets[scale]).includes(size)) return scale.toUpperCase();
    const edge = Math.max(dimensions.width, dimensions.height);
    if (edge <= 768) return "512";
    if (edge <= 1536) return "1K";
    if (edge <= 3072) return "2K";
    return "4K";
}

function supportsGeminiImageSize(model: string) {
    const value = model.toLowerCase();
    return value.includes("gemini-3") || value.includes("3.1") || value.includes("3-pro");
}

function resolveImageSource(item: Record<string, unknown>) {
    if (typeof item.b64_json === "string" && item.b64_json) {
        return `data:image/png;base64,${item.b64_json}`;
    }
    if (typeof item.url === "string" && item.url) {
        return item.url;
    }
    return null;
}

function imagePayloadSources(payload: ImageApiResponse) {
    if (typeof payload.code === "number" && payload.code !== 0) return [];
    const imageList = payload.data
        || (payload as Record<string, unknown>).images as Array<Record<string, unknown>> | undefined
        || (payload as Record<string, unknown>).results as Array<Record<string, unknown>> | undefined
        || [];
    return imageList
        .map(resolveImageSource)
        .filter((value): value is string => Boolean(value))
        .map((dataUrl) => ({ id: nanoid(), dataUrl }));
}

function parseImagePayload(payload: ImageApiResponse) {
    const images = imagePayloadSources(payload);
    if (images.length === 0) {
        const rawKeys = Object.keys(payload).filter((k) => k !== "code" && k !== "msg" && k !== "error");
        throw new Error(rawKeys.length > 0
            ? apiText("unknownImageResponse", { fields: rawKeys.join(", ") })
            : apiText("noImageReturned"));
    }
    return images;
}

function readImageTaskIds(payload: Record<string, unknown>) {
    const ids: string[] = [];
    if (Array.isArray(payload.task_ids)) {
        for (const id of payload.task_ids) {
            if (typeof id === "string" && id.trim()) ids.push(id.trim());
        }
    }
    if (typeof payload.id === "string" && payload.id.trim() && (ids.length || isImageTaskStatus(payload.status))) {
        const id = payload.id.trim();
        if (!ids.includes(id)) ids.unshift(id);
    }
    return ids;
}

function isImageTaskStatus(status: unknown) {
    return /^(queued|pending|running|processing|in_progress)$/i.test(String(status || ""));
}

function isAsyncImageTaskPayload(payload: unknown): payload is Record<string, unknown> {
    return isRecord(payload) && !imagePayloadSources(payload as ImageApiResponse).length && readImageTaskIds(payload).length > 0;
}

async function waitForImageTasks(config: AiConfig, taskIds: string[], options?: RequestOptions) {
    const images = await Promise.all(taskIds.map((taskId) => waitForImageTask(config, taskId, options)));
    return images.flat();
}

async function waitForImageTask(config: AiConfig, taskId: string, options?: RequestOptions) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        try {
            const payload = (await axios.get<ImageApiResponse>(aiApiUrl(config, `/tasks/${encodeURIComponent(taskId)}`), { headers: aiHeaders(config), signal: options?.signal })).data;
            const status = String((payload as Record<string, unknown>).status || "").toLowerCase();
            if (["failed", "failure", "error", "cancelled", "canceled"].includes(status)) {
                throw new Error(readApiErrorMessage(payload) || apiText("imageGenerationFailed"));
            }
            const images = imagePayloadSources(payload);
            if (images.length) return images.map((image) => ({ ...image, taskId }));
            if (status === "completed" || status === "success" || status === "succeeded") throw new Error(apiText("noImageReturned"));
        } catch (error) {
            if (axios.isCancel(error) || options?.signal?.aborted) throw error;
            if (axios.isAxiosError(error) && error.response) throw new Error(readAxiosError(error, apiText("imageTaskQueryFailed")));
            if (error instanceof Error && !axios.isAxiosError(error)) throw error;
            if (attempt === 119) throw new Error(readAxiosError(error, apiText("imageTaskQueryFailed")));
        }
        if (attempt === 119) throw new Error(apiText("imageTimeout"));
        await delay(2500, options?.signal);
    }
    throw new Error(apiText("imageTimeout"));
}

async function resolveImageTaskResponse(config: AiConfig, payload: unknown, options?: RequestOptions) {
    if (!isAsyncImageTaskPayload(payload)) return parseImagePayload(payload as ImageApiResponse);
    const taskIds = readImageTaskIds(payload);
    if (taskIds[0]) options?.onTaskCreated?.(taskIds[0]);
    return waitForImageTasks(config, taskIds, options);
}

function usesOiioiiImageTasks(config: Pick<AiConfig, "baseUrl" | "channels">) {
    if (isOiioiiBaseUrl(config.baseUrl)) return true;
    const baseUrl = config.baseUrl.trim().replace(/\/+$/, "");
    return (config.channels || []).some((channel) => channel.id === OIIOII_CHANNEL_ID && channel.baseUrl.trim().replace(/\/+$/, "") === baseUrl);
}

function readApiErrorMessage(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") {
        // The value may be serialized JSON, such as error.message, or a plain-text error.
        try {
            const parsed = JSON.parse(value);
            const inner = readApiErrorMessage(parsed) || value;
            // Treat an empty parsed object such as "{}" as having no useful message.
            if (inner === value && typeof parsed === "object" && Object.keys(parsed).length === 0) return "";
            return inner;
        } catch {
            // Detect HTML error pages.
            if (/<[a-z][\s\S]*>/i.test(value)) return apiText("htmlError", { preview: `${value.slice(0, 80)}...` });
            return value;
        }
    }
    if (typeof value !== "object") return "";
    const payload = value as { msg?: unknown; message?: unknown; error?: unknown; detail?: unknown };
    // error may be a string or an object containing a message.
    const errorMsg =
        typeof payload.error === "string"
            ? payload.error
            : (payload.error as { message?: unknown })?.message;
    return (
        readApiErrorMessage(payload.msg) ||
        readApiErrorMessage(payload.message) ||
        readApiErrorMessage(errorMsg) ||
        readApiErrorMessage(payload.detail) ||
        ""
    );
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return apiText("requestCanceled");
    if (axios.isAxiosError(error)) {
        if (!error.response && error.code === "ERR_NETWORK") return apiText("requestFailed");
        const responseData = error.response?.data;
        // Prefer the API error from the response body.
        const apiMsg = readApiErrorMessage(responseData);
        if (apiMsg) return apiMsg;
        // Infer the error from the HTTP status when the response body has no usable message.
        const statusMsg = readStatusError(error.response?.status, fallback);
        if (statusMsg) return statusMsg;
        // Fall back to Axios's own error message.
        return error.message || fallback;
    }
    if (error instanceof DOMException && error.name === "AbortError") return apiText("requestCanceled");
    return error instanceof Error ? readApiErrorMessage(error.message) || error.message : fallback;
}

function readStatusError(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return apiText("authenticationFailed");
    if (status === 429) return apiText("rateLimited");
    if (status === 404) return apiText("notFound");
    if (status === 502) return apiText("badGateway");
    if (status === 503) return apiText("serviceBusy");
    return status ? apiText("httpFailed", { status }) : fallback;
}

function withSystemPrompt(config: AiConfig, prompt: string) {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

function geminiBaseUrl(config: Pick<AiConfig, "baseUrl">) {
    const normalizedBaseUrl = config.baseUrl.trim().replace(/\/+$/, "");
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    return lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/v1beta") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1beta`;
}

function geminiModelName(model: string) {
    return model.trim().replace(/^models\//, "");
}

function geminiApiUrl(config: Pick<AiConfig, "baseUrl" | "model">, action?: "generateContent" | "streamGenerateContent") {
    const baseUrl = geminiBaseUrl(config);
    if (!action) return withLocalProxy(`${baseUrl}/models`);
    return withLocalProxy(`${baseUrl}/models/${encodeURIComponent(geminiModelName(config.model))}:${action}`);
}

function geminiHeaders(config: Pick<AiConfig, "apiKey">) {
    return {
        "x-goog-api-key": config.apiKey,
        "Content-Type": "application/json",
    };
}

function withSystemMessage<T extends ResponseInputMessage>(config: AiConfig, messages: T[]): ResponseInputMessage[] {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? [{ role: "system" as const, content: systemPrompt }, ...messages] : messages;
}

function toResponseInput(messages: ResponseInputMessage[]): ResponseInputItem[] {
    return messages.flatMap((message): ResponseInputItem[] => {
        if ("type" in message) return [message];
        if (message.role === "tool") return [{ type: "function_call_output", call_id: message.tool_call_id, output: message.content }];
        return [{ role: message.role, content: toResponseContent(message.content || "") }];
    });
}

function toResponseContent(content: ResponseMessageContent): string | ResponseInputContent[] {
    if (!Array.isArray(content)) return String(content || "");
    return content.map((item) => (item.type === "text" ? { type: "input_text" as const, text: item.text } : { type: "input_image" as const, image_url: item.image_url.url }));
}

function toResponseTool(tool: ResponseFunctionTool): ResponseApiToolDefinition {
    return {
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
        strict: tool.function.strict,
    };
}

function parseToolResponse(payload: ResponseApiPayload): ToolResponseResult {
    const output = payload.output || [];
    const content =
        payload.output_text ||
        output
            .flatMap((item) => (item.type === "message" ? item.content || [] : []))
            .map((item) => item.text || "")
            .join("");
    const toolCalls = output
        .filter((item): item is Extract<ResponseApiOutputItem, { type?: "function_call" }> => item.type === "function_call")
        .map((item) => ({
            id: item.call_id || item.id || "",
            type: "function" as const,
            function: { name: item.name || "", arguments: item.arguments || "{}" },
        }))
        .filter((item) => item.id && item.function.name);
    return { content, toolCalls };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function responseErrorMessage(value: unknown) {
    if (!isRecord(value)) return "";
    const error = isRecord(value.error) ? value.error : undefined;
    const response = isRecord(value.response) ? value.response : undefined;
    const responseError = response && isRecord(response.error) ? response.error : undefined;
    return stringValue(value.msg) || stringValue(error?.message) || stringValue(responseError?.message);
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value : "";
}

function validateResponsePayload(payload: ResponseApiPayload) {
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || apiText("requestFailed"));
    if (payload.error?.message) throw new Error(payload.error.message);
}

function validateGeminiPayload(payload: GeminiPayload) {
    if (payload.error?.message) throw new Error(payload.error.message);
    if (payload.promptFeedback?.blockReason) throw new Error(apiText("geminiRejected", { reason: payload.promptFeedback.blockReason }));
}

async function readFetchError(response: Response, fallback: string) {
    const text = await response.text();
    if (!text) return readStatusError(response.status, fallback);
    try {
        return responseErrorMessage(JSON.parse(text)) || readStatusError(response.status, fallback);
    } catch {
        return text.slice(0, 300) || readStatusError(response.status, fallback);
    }
}

function consumeResponseStreamBlock(block: string, state: ResponseStreamState, onDelta?: (text: string) => void) {
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data) as Record<string, unknown>;
    const type = stringValue(event.type);
    const errorMessage = responseErrorMessage(event);
    if (errorMessage) state.error = errorMessage;
    if (type === "response.output_text.delta" && typeof event.delta === "string") {
        state.text += event.delta;
        onDelta?.(state.text);
    }
    if (type === "response.output_text.done" && !state.text && typeof event.text === "string") {
        state.text = event.text;
        onDelta?.(state.text);
    }
    if (type === "response.completed" && isRecord(event.response)) {
        state.payload = event.response as ResponseApiPayload;
    } else if (Array.isArray(event.output)) {
        state.payload = event as ResponseApiPayload;
    }
}

function consumeResponseStreamText(state: ResponseStreamState, text: string, onDelta?: (text: string) => void, flush = false) {
    state.buffer += text;
    for (;;) {
        const match = state.buffer.match(/\r?\n\r?\n/);
        if (!match) break;
        const index = match.index ?? 0;
        consumeResponseStreamBlock(state.buffer.slice(0, index), state, onDelta);
        state.buffer = state.buffer.slice(index + match[0].length);
    }
    if (flush && state.buffer.trim()) {
        consumeResponseStreamBlock(state.buffer, state, onDelta);
        state.buffer = "";
    }
}

async function requestStreamingResponse(config: AiConfig, body: Record<string, unknown>, onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    const response = await fetch(aiApiUrl(config, "/responses"), {
        method: "POST",
        headers: { ...aiHeaders(config, "application/json"), Accept: "text/event-stream" },
        body: JSON.stringify({ ...body, stream: true }),
        signal: options?.signal,
    });
    if (!response.ok) throw new Error(await readFetchError(response, apiText("requestFailed")));
    if (!response.body) {
        const payload = (await response.json()) as ResponseApiPayload;
        validateResponsePayload(payload);
        return parseToolResponse(payload);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state: ResponseStreamState = { buffer: "", text: "" };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        consumeResponseStreamText(state, decoder.decode(value, { stream: true }), onDelta);
        if (state.error) throw new Error(state.error);
    }
    consumeResponseStreamText(state, decoder.decode(), onDelta, true);
    if (state.error) throw new Error(state.error);
    if (!state.payload) return { content: state.text, toolCalls: [] };
    validateResponsePayload(state.payload);
    const result = parseToolResponse(state.payload);
    return { ...result, content: state.text || result.content };
}

function toGeminiBody(config: AiConfig, messages: ResponseInputMessage[], extra?: Record<string, unknown>) {
    const systemText = [
        config.systemPrompt.trim(),
        ...messages.flatMap((message) => (!("type" in message) && message.role === "system" ? [geminiTextContent(message.content)] : [])),
    ]
        .filter(Boolean)
        .join("\n\n");
    const contents = toGeminiContents(messages.filter((message) => ("type" in message ? true : message.role !== "system")));
    return {
        contents,
        ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
        ...extra,
    };
}

function toGeminiContents(messages: ResponseInputMessage[]): GeminiContent[] {
    const callNameById = new Map<string, string>();
    return messages.flatMap((message): GeminiContent[] => {
        if ("type" in message) {
            callNameById.set(message.call_id, message.name);
            return [{ role: "model", parts: [{ functionCall: { id: message.call_id, name: message.name, args: jsonObject(message.arguments) }, ...(message.thoughtSignature ? { thoughtSignature: message.thoughtSignature } : {}) }] }];
        }
        if (message.role === "tool") {
            const name = callNameById.get(message.tool_call_id) || "tool_result";
            return [{ role: "user", parts: [{ functionResponse: { id: message.tool_call_id, name, response: { result: jsonValue(message.content) } } }] }];
        }
        return [{ role: message.role === "assistant" ? "model" : "user", parts: toGeminiParts(message.content) }];
    });
}

function toGeminiParts(content: ResponseMessageContent): GeminiPart[] {
    if (!Array.isArray(content)) return [{ text: String(content || "") }];
    return content.map((item) => (item.type === "text" ? { text: item.text } : toGeminiImagePart(item.image_url.url)));
}

function toGeminiImagePart(url: string): GeminiPart {
    const match = url.match(/^data:([^;,]+);base64,(.+)$/);
    if (match) return { inlineData: { mimeType: match[1], data: match[2] } };
    return { fileData: { fileUri: url, mimeType: "image/png" } };
}

function geminiTextContent(content: ResponseMessageContent) {
    if (!Array.isArray(content)) return String(content || "");
    return content.map((item) => (item.type === "text" ? item.text : item.image_url.url)).join("\n");
}

function jsonObject(value: string): Record<string, unknown> {
    const parsed = jsonValue(value);
    return isRecord(parsed) ? parsed : {};
}

function jsonValue(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function toGeminiToolOptions(tools: ResponseFunctionTool[], toolChoice: ToolChoice) {
    if (!tools.length) return {};
    const functionDeclarations = tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
    }));
    const functionCallingConfig =
        typeof toolChoice === "object"
            ? { mode: "ANY", allowedFunctionNames: [toolChoice.name] }
            : { mode: toolChoice === "required" ? "ANY" : "AUTO" };
    return {
        tools: [{ functionDeclarations }],
        toolConfig: { functionCallingConfig },
    };
}

async function requestGeminiStreamingResponse(config: AiConfig, body: Record<string, unknown>, onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    const response = await fetch(`${geminiApiUrl(config, "streamGenerateContent")}?alt=sse`, {
        method: "POST",
        headers: geminiHeaders(config),
        body: JSON.stringify(body),
        signal: options?.signal,
    });
    if (!response.ok) throw new Error(await readFetchError(response, apiText("requestFailed")));
    if (!response.body) {
        const payload = (await response.json()) as GeminiPayload;
        return parseGeminiToolResponse(payload);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state: GeminiStreamState = { buffer: "", text: "", toolCalls: [] };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        consumeGeminiStreamText(state, decoder.decode(value, { stream: true }), onDelta);
        if (state.error) throw new Error(state.error);
    }
    consumeGeminiStreamText(state, decoder.decode(), onDelta, true);
    if (state.error) throw new Error(state.error);
    return { content: state.text, toolCalls: state.toolCalls };
}

function consumeGeminiStreamText(state: GeminiStreamState, text: string, onDelta?: (text: string) => void, flush = false) {
    state.buffer += text;
    for (;;) {
        const match = state.buffer.match(/\r?\n\r?\n/);
        if (!match) break;
        const index = match.index ?? 0;
        consumeGeminiStreamBlock(state.buffer.slice(0, index), state, onDelta);
        state.buffer = state.buffer.slice(index + match[0].length);
    }
    if (flush && state.buffer.trim()) {
        consumeGeminiStreamBlock(state.buffer, state, onDelta);
        state.buffer = "";
    }
}

function consumeGeminiStreamBlock(block: string, state: GeminiStreamState, onDelta?: (text: string) => void) {
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
    if (!data || data === "[DONE]") return;
    const result = parseGeminiToolResponse(JSON.parse(data) as GeminiPayload);
    if (result.content) {
        state.text += result.content;
        onDelta?.(state.text);
    }
    state.toolCalls.push(...result.toolCalls);
}

function parseGeminiToolResponse(payload: GeminiPayload): ToolResponseResult {
    validateGeminiPayload(payload);
    const parts = payload.candidates?.flatMap((candidate) => candidate.content?.parts || []) || [];
    const content = parts.map((part) => part.text || "").join("");
    const toolCalls = parts
        .map((part) => part.functionCall)
        .filter((call): call is NonNullable<GeminiPart["functionCall"]> => Boolean(call?.name))
        .map((call) => {
            const part = parts.find((item) => item.functionCall === call);
            const thoughtSignature = part?.thoughtSignature || part?.thought_signature;
            return {
                id: call.id || nanoid(),
                type: "function" as const,
                function: { name: call.name || "", arguments: JSON.stringify(call.args || {}) },
                ...(thoughtSignature ? { thoughtSignature } : {}),
            };
        });
    return { content, toolCalls };
}

async function requestGeminiImages(config: AiConfig, prompt: string, references: ReferenceImage[], count: number, options?: RequestOptions) {
    const requests = Array.from({ length: count }, () => requestGeminiImagesOnce(config, prompt, references, options));
    return (await Promise.all(requests)).flat();
}

async function requestGeminiImagesOnce(config: AiConfig, prompt: string, references: ReferenceImage[], options?: RequestOptions) {
    const parts: GeminiPart[] = [{ text: prompt }];
    for (const image of references) {
        parts.push(toGeminiImagePart(await imageToDataUrl(image)));
    }
    const response = await axios.post<GeminiPayload>(
        geminiApiUrl(config, "generateContent"),
        {
            ...toGeminiBody(config, [{ role: "user", content: prompt }], { generationConfig: { responseModalities: ["TEXT", "IMAGE"], ...resolveGeminiImageConfig(config) } }),
            contents: [{ role: "user", parts }],
        },
        { headers: geminiHeaders(config), signal: options?.signal },
    );
    return parseGeminiImagePayload(response.data);
}

function parseGeminiImagePayload(payload: GeminiPayload) {
    validateGeminiPayload(payload);
    const images =
        payload.candidates
            ?.flatMap((candidate) => candidate.content?.parts || [])
            .map((part) => {
                const inlineData = part.inlineData || (part.inline_data ? { mimeType: part.inline_data.mimeType || part.inline_data.mime_type, data: part.inline_data.data } : undefined);
                if (inlineData?.data) return `data:${inlineData.mimeType || "image/png"};base64,${inlineData.data}`;
                return part.fileData?.fileUri || null;
            })
            .filter((value): value is string => Boolean(value))
            .map((dataUrl) => ({ id: nanoid(), dataUrl })) || [];
    if (!images.length) throw new Error(apiText("geminiNoImage"));
    return images;
}

type MiaowuImageTask = {
    id?: string;
    status?: string;
    url?: string;
    result_url?: string;
    error?: { message?: string; code?: string } | string;
};
type MiaowuImageEnvelope = MiaowuImageTask | { code?: number | string; data?: MiaowuImageTask | null; msg?: string; message?: string; error?: { message?: string } };

const MIAOWU_IMAGE_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "21:9"];

function isMiaowuImageEndpoint(config: Pick<AiConfig, "baseUrl">) {
    return isBuiltInChannel({ id: "", builtIn: false, baseUrl: config.baseUrl });
}

function miaowuImageRatio(size: string) {
    const value = size.trim();
    if (!value || value.toLowerCase() === "auto") return "1:1";
    if (MIAOWU_IMAGE_RATIOS.includes(value)) return value;
    const dimensions = parseImageDimensions(value);
    if (dimensions) return closestMiaowuImageRatio(dimensions.width / dimensions.height);
    if (value.includes(":")) {
        const parsed = parseRatioValue(value);
        return closestMiaowuImageRatio(parsed.width / parsed.height);
    }
    return "1:1";
}

function closestMiaowuImageRatio(target: number) {
    return MIAOWU_IMAGE_RATIOS.reduce((best, item) => {
        const [width, height] = item.split(":").map(Number);
        const [bestWidth, bestHeight] = best.split(":").map(Number);
        return Math.abs(width / height - target) < Math.abs(bestWidth / bestHeight - target) ? item : best;
    });
}

function miaowuImageResolution(quality: string, size: string) {
    const normalized = normalizeQuality(quality);
    if (normalized === "high") return "4K";
    if (normalized === "medium" || normalized === "hd") return "2K";
    if (normalized === "low" || normalized === "standard") return "1080p";
    const dimensions = parseImageDimensions(size.trim());
    if (dimensions) {
        const edge = Math.max(dimensions.width, dimensions.height);
        if (edge >= 3000) return "4K";
        if (edge >= 1800) return "2K";
    }
    return "1080p";
}

function unwrapMiaowuImageTask(payload: MiaowuImageEnvelope): MiaowuImageTask {
    if (!payload) throw new Error(apiText("noImageTaskId"));
    if (typeof payload === "object" && "code" in payload && payload.code !== undefined) {
        if (payload.code !== 0 && payload.code !== "0") throw new Error(readApiErrorMessage(payload) || apiText("imageTaskCreateFailed"));
        if (!payload.data) throw new Error(apiText("noImageTaskId"));
        return payload.data;
    }
    if (typeof payload === "object" && "data" in payload && payload.data && typeof payload.data === "object") return payload.data;
    return payload as MiaowuImageTask;
}

function miaowuImageError(task: MiaowuImageTask) {
    return readApiErrorMessage(task.error) || apiText("imageGenerationFailed");
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

async function blobToDataUrl(blob: Blob) {
    return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(apiText("noImageReturned")));
        reader.readAsDataURL(blob);
    });
}

async function miaowuImageFromUrl(config: AiConfig, taskId: string, url: string | undefined, options?: RequestOptions) {
    if (url) {
        try {
            const response = await axios.get<Blob>(fetchableMediaUrl(url), { responseType: "blob", signal: options?.signal });
            return { id: nanoid(), dataUrl: await blobToDataUrl(response.data), taskId };
        } catch (error) {
            if (axios.isCancel(error) || options?.signal?.aborted) throw error;
            try {
                return { id: nanoid(), dataUrl: await blobToDataUrl(await fetchMiaowuTaskBlob(config, taskId, options?.signal)), taskId };
            } catch {
                return { id: nanoid(), dataUrl: url, taskId };
            }
        }
    }
    return { id: nanoid(), dataUrl: await blobToDataUrl(await fetchMiaowuTaskBlob(config, taskId, options?.signal)), taskId };
}

type DreamParamSchema = { type?: string; enum?: string[]; minItems?: number; maxItems?: number };
type DreamRequestSchema = { properties?: { params?: { properties?: Record<string, DreamParamSchema>; required?: string[] } } };
type DreamModelSchema = { type?: string; request_schema?: DreamRequestSchema };
type DreamTask = MiaowuImageTask & { process?: string; result?: string[]; executionMode?: string };

const dreamSchemaCache = new Map<string, DreamRequestSchema>();

function dreamSchemaKey(config: Pick<AiConfig, "baseUrl" | "model">) {
    return `${config.baseUrl.trim()}::${config.model}`;
}

function pickDreamEnum(value: string, enums?: string[]) {
    if (!enums?.length) return value;
    if (enums.includes(value)) return value;
    return enums[0];
}

function miaowuDreamSize(quality: string, size: string, enums?: string[]) {
    const wanted = miaowuImageResolution(quality, size);
    if (!enums?.length || enums.includes(wanted)) return pickDreamEnum(wanted, enums);
    const order = ["4K", "2K", "1080p", "720p"];
    const start = Math.max(0, order.indexOf(wanted));
    return order.slice(start).concat(order.slice(0, start)).find((item) => enums.includes(item)) || enums[0];
}

function miaowuDreamMode(schema: DreamRequestSchema | undefined, hasRefs: boolean) {
    const params = schema?.properties?.params;
    const enums = params?.properties?.mode?.enum || [];
    const required = params?.required || [];
    if (!enums.length && !required.includes("mode")) return undefined;
    if (hasRefs && enums.includes("image-to-image")) return "image-to-image";
    if (!hasRefs && enums.includes("text-to-image")) return "text-to-image";
    if (enums.length === 1) return enums[0];
    return hasRefs ? enums.find((item) => item.includes("image")) || enums[0] : enums.find((item) => item.includes("text")) || enums[0];
}

function unwrapDreamTask(payload: MiaowuImageEnvelope | { data?: DreamTask | null }): DreamTask {
    const task = unwrapMiaowuImageTask(payload as MiaowuImageEnvelope) as DreamTask;
    if (!task?.id) throw new Error(apiText("noImageTaskId"));
    return task;
}

async function fetchMiaowuImageSchema(config: AiConfig, options?: RequestOptions) {
    const cacheKey = dreamSchemaKey(config);
    const cached = dreamSchemaCache.get(cacheKey);
    if (cached) return cached;
    const response = await axios.get<{ data?: DreamModelSchema; request_schema?: DreamRequestSchema }>(buildApiUrl(config.baseUrl, `/dream/model_schema?model=${encodeURIComponent(config.model)}`), {
        headers: aiHeaders(config),
        signal: options?.signal,
    });
    const schema = response.data?.data?.request_schema || response.data?.request_schema || {};
    dreamSchemaCache.set(cacheKey, schema);
    return schema;
}

function buildMiaowuDreamParams(schema: DreamRequestSchema, config: AiConfig, prompt: string, imageUrls: string[]) {
    const properties = schema.properties?.params?.properties || {};
    const params: Record<string, unknown> = {};
    if (properties.prompt || !Object.keys(properties).length) params.prompt = withSystemPrompt(config, prompt);
    if (properties.size) params.size = miaowuDreamSize(config.quality, config.size, properties.size.enum);
    if (properties.ratio) params.ratio = pickDreamEnum(miaowuImageRatio(config.size), properties.ratio.enum);
    const mode = miaowuDreamMode(schema, imageUrls.length > 0);
    if (mode && properties.mode) params.mode = mode;
    if (imageUrls.length && properties.image_urls) params.image_urls = imageUrls;
    if (!params.prompt) params.prompt = withSystemPrompt(config, prompt);
    return params;
}

function resolveMiaowuResultRef(config: AiConfig, ref: string) {
    if (/^https?:\/\//i.test(ref)) return ref;
    const origin = config.baseUrl.trim().replace(/\/+$/, "");
    return withLocalProxy(`${origin}${ref.startsWith("/") ? ref : `/${ref}`}`);
}

async function miaowuImageFromRef(config: AiConfig, taskId: string, ref: string | undefined, options?: RequestOptions) {
    if (!ref) return miaowuImageFromUrl(config, taskId, undefined, options);
        const url = fetchableMediaUrl(resolveMiaowuResultRef(config, ref));
    const headers = url.startsWith("/") || /^https?:\/\//i.test(ref) ? undefined : aiHeaders(config);
        try {
            const response = await axios.get<Blob>(url, { headers, responseType: "blob", signal: options?.signal });
            return { id: nanoid(), dataUrl: await blobToDataUrl(response.data), taskId };
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        try {
            return { id: nanoid(), dataUrl: await blobToDataUrl(await fetchMiaowuTaskBlob(config, taskId, options?.signal)), taskId };
        } catch {
            if (/^https?:\/\//i.test(ref)) return { id: nanoid(), dataUrl: ref, taskId };
            throw error;
        }
    }
}

export function miaowuTaskContentUrl(taskId: string) {
    return `/__miaowu/v1/dream/tasks/${encodeURIComponent(taskId)}/content`;
}

export async function fetchMiaowuTaskBlob(config: Pick<AiConfig, "apiKey">, taskId: string, signal?: AbortSignal) {
    const response = await axios.get<Blob>(miaowuTaskContentUrl(taskId), {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        responseType: "blob",
        signal,
    });
    const type = response.data.type || "";
    if (!response.data.size || type.includes("json") || type.includes("text/html")) throw new Error(apiText("referenceUrlExpired"));
    return response.data;
}

function isReferenceReadError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error || "");
    return /参考素材读取失败|referenceUrlExpired|临时链接已失效/.test(message);
}

async function resolveMiaowuReferenceUrl(config: AiConfig, reference: ReferenceImage, options?: RequestOptions) {
    const local = Boolean(reference.storageKey || reference.dataUrl?.startsWith("data:") || reference.dataUrl?.startsWith("blob:"));
    if (local) {
        return resolvePublicHttpUrl(reference, { signal: options?.signal, force: options?.forcePublicUpload || Boolean(reference.storageKey) });
    }
    if (reference.taskId) {
        try {
            const uploaded = await persistGeneratedImage(await fetchMiaowuTaskBlob(config, reference.taskId, options?.signal), { signal: options?.signal });
            if (uploaded.publicUrl) return uploaded.publicUrl;
            if (uploaded.storageKey) return resolvePublicHttpUrl({ storageKey: uploaded.storageKey, dataUrl: uploaded.url, name: reference.name, type: reference.type }, { signal: options?.signal });
        } catch {
            /* TOS result links expire; the content endpoint often only redirects to the same dead file. */
        }
    }
    const remote = reference.dataUrl || reference.url || "";
    if (isEphemeralMediaUrl(remote)) throw new Error(apiText("referenceUrlExpired"));
    return resolvePublicHttpUrl({ ...reference, publicUrl: isEphemeralMediaUrl(reference.publicUrl) ? undefined : reference.publicUrl }, { signal: options?.signal, force: options?.forcePublicUpload });
}

async function createMiaowuImageTask(config: AiConfig, prompt: string, references: ReferenceImage[], options?: RequestOptions) {
    const imageUrls = references.length ? await Promise.all(references.map((reference) => resolveMiaowuReferenceUrl(config, reference, options))) : [];
    const schema = await fetchMiaowuImageSchema(config, options);
    const created = unwrapDreamTask(
        (
            await axios.post<MiaowuImageEnvelope>(
                aiApiUrl(config, "/dream/generate"),
                { model: config.model, params: buildMiaowuDreamParams(schema, config, prompt, imageUrls) },
                { headers: aiHeaders(config, "application/json"), signal: options?.signal },
            )
        ).data,
    );
    return created.id as string;
}

async function waitForMiaowuImageTask(config: AiConfig, taskId: string, options?: RequestOptions) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const task = unwrapDreamTask((await axios.post<MiaowuImageEnvelope>(aiApiUrl(config, "/dream/query"), { id: taskId }, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data);
        const status = (task.status || "").toUpperCase();
        const refs = [task.result, task.url, task.result_url]
            .flatMap((value) => (Array.isArray(value) ? value : value ? [value] : []))
            .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
        if (refs.length) return [await miaowuImageFromRef(config, taskId, refs[0], options)];
        if (status === "SUCCESS" || status === "COMPLETED") return [await miaowuImageFromRef(config, taskId, undefined, options)];
        if (status === "FAILURE" || status === "FAILED" || status === "CANCELLED") throw new Error(miaowuImageError(task));
        if (attempt === 119) throw new Error(apiText("imageTimeout"));
        await delay(2500, options?.signal);
    }
    throw new Error(apiText("imageTimeout"));
}

async function requestMiaowuImages(config: AiConfig, prompt: string, references: ReferenceImage[], count: number, options?: RequestOptions) {
    const tasks = Array.from({ length: count }, async () => {
        let taskId = "";
        try {
            taskId = await createMiaowuImageTask(config, prompt, references, options);
            options?.onTaskCreated?.(taskId);
            try {
                const images = await waitForMiaowuImageTask(config, taskId, options);
                return images.map((image) => ({ ...image, taskId }));
            } catch (error) {
                if (!references.length || options?.forcePublicUpload || !isReferenceReadError(error)) throw error;
                taskId = await createMiaowuImageTask(config, prompt, references, { ...options, forcePublicUpload: true });
                options?.onTaskCreated?.(taskId);
                const images = await waitForMiaowuImageTask(config, taskId, options);
                return images.map((image) => ({ ...image, taskId }));
            }
        } catch (error) {
            throw new Error(readAxiosError(error, taskId ? apiText("imageGenerationFailed") : apiText("imageTaskCreateFailed")));
        }
    });
    return (await Promise.all(tasks)).flat();
}

/** 页面刷新后按已保存的任务 id 继续等结果，只适用于异步任务渠道（喵呜、OiiOii 等返回 task id 的接口）。 */
export async function resumeImageTask(config: AiConfig, taskId: string, options?: RequestOptions): Promise<RequestedImage> {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.imageModel);
    try {
        const images = isMiaowuImageEndpoint(requestConfig) ? await waitForMiaowuImageTask(requestConfig, taskId, options) : await waitForImageTask(requestConfig, taskId, options);
        if (!images[0]) throw new Error(apiText("noImageReturned"));
        return { ...images[0], taskId };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("imageTaskQueryFailed")));
    }
}

export async function requestGeneration(config: AiConfig, prompt: string, options?: RequestOptions): Promise<RequestedImage[]> {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.imageModel);
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const script = resolveModelScript(config, config.model || config.imageModel);
    if (script) {
        const quality = normalizeQuality(config.quality);
        const requestSize = resolveRequestSize(quality, config.size);
        const background = normalizeBackground(config.background);
        try {
            const result = await runModelPlugin({
                capability: "image",
                script,
                config: requestConfig,
                prompt: withSystemPrompt(requestConfig, prompt),
                images: [],
                params: { size: requestSize, quality, count: n, ...(background ? { background } : {}) },
                signal: options?.signal,
            });
            return normalizePluginImages(result).map((dataUrl) => ({ id: nanoid(), dataUrl }));
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("requestFailed")));
        }
    }
    if (requestConfig.apiFormat === "gemini") {
        try {
            return await requestGeminiImages(requestConfig, prompt, [], n, options);
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("requestFailed")));
        }
    }
    if (isMiaowuImageEndpoint(requestConfig)) {
        return requestMiaowuImages(requestConfig, prompt, [], n, options);
    }
    const quality = normalizeQuality(config.quality);
    const requestSize = resolveRequestSize(quality, config.size);
    const background = normalizeBackground(config.background);
    try {
        const response = await axios.post<ImageApiResponse>(
            aiApiUrl(requestConfig, "/images/generations"),
            {
                model: requestConfig.model,
                prompt: withSystemPrompt(requestConfig, prompt),
                n,
                ...(quality ? { quality } : {}),
                ...(requestSize ? { size: requestSize } : {}),
                ...(background ? { background } : {}),
                // gpt-image models reject response_format; they always return b64.
                ...(/gpt-image/.test(requestConfig.model) ? {} : { response_format: "b64_json" }),
                output_format: IMAGE_OUTPUT_FORMAT,
                ...(usesOiioiiImageTasks(requestConfig) ? { async: true } : {}),
            },
            {
                headers: aiHeaders(requestConfig, "application/json"),
                signal: options?.signal,
            },
        );
        return resolveImageTaskResponse(requestConfig, response.data, options);
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("requestFailed")));
    }
}

export async function requestEdit(config: AiConfig, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<RequestedImage[]> {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.imageModel);
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const requestPrompt = buildImageReferencePromptText(prompt, references);
    const script = resolveModelScript(config, config.model || config.imageModel);
    if (script) {
        const quality = normalizeQuality(config.quality);
        const requestSize = resolveRequestSize(quality, config.size);
        const background = normalizeBackground(config.background);
        const refs = isMiaowuImageEndpoint(requestConfig) ? await resolvePublicHttpUrls(references, options) : await Promise.all(references.map((image) => imageToDataUrl(image)));
        try {
            const result = await runModelPlugin({
                capability: "image",
                script,
                config: requestConfig,
                prompt: withSystemPrompt(requestConfig, requestPrompt),
                images: refs,
                params: { size: requestSize, quality, count: n, ...(background ? { background } : {}) },
                signal: options?.signal,
            });
            return normalizePluginImages(result).map((dataUrl) => ({ id: nanoid(), dataUrl }));
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("requestFailed")));
        }
    }
    if (requestConfig.apiFormat === "gemini") {
        try {
            return await requestGeminiImages(requestConfig, requestPrompt, references, n, options);
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("requestFailed")));
        }
    }
    if (isMiaowuImageEndpoint(requestConfig)) {
        return requestMiaowuImages(requestConfig, prompt, references, n, options);
    }

    const quality = normalizeQuality(config.quality);
    const requestSize = resolveRequestSize(quality, config.size);
    const background = normalizeBackground(config.background);
    const formData = new FormData();
    formData.set("model", requestConfig.model);
    formData.set("prompt", withSystemPrompt(requestConfig, requestPrompt));
    formData.set("n", String(n));
    // gpt-image models reject response_format; they always return b64.
    if (!/gpt-image/.test(requestConfig.model)) {
        formData.set("response_format", "b64_json");
    }
    formData.set("output_format", IMAGE_OUTPUT_FORMAT);
    if (quality) {
        formData.set("quality", quality);
    }
    if (requestSize) {
        formData.set("size", requestSize);
    }
    if (background) {
        formData.set("background", background);
    }
    if (usesOiioiiImageTasks(requestConfig)) {
        formData.set("async", "true");
    }
    const files = await Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    const imageField = files.length > 1 ? "image[]" : "image";
    files.forEach((file) => formData.append(imageField, file));

    try {
        const response = await axios.post<ImageApiResponse>(aiApiUrl(requestConfig, "/images/edits"), formData, { headers: aiHeaders(requestConfig), signal: options?.signal });
        return resolveImageTaskResponse(requestConfig, response.data, options);
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("requestFailed")));
    }
}

export async function requestImageQuestion(config: AiConfig, messages: AiTextMessage[], onDelta: (text: string) => void, options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.textModel);
    const script = resolveModelScript(config, config.model || config.textModel);
    if (script) {
        try {
            const answer = await runModelPlugin<string>({
                capability: "text",
                script,
                config: requestConfig,
                messages: withSystemMessage(requestConfig, messages),
                signal: options?.signal,
                onDelta,
            });
            const text = String(answer ?? "").trim() || apiText("noContent");
            if (text === apiText("noContent")) onDelta(text);
            return text;
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("requestFailed")));
        }
    }
    try {
        if (requestConfig.apiFormat === "gemini") {
            const answer = (await requestGeminiStreamingResponse(requestConfig, toGeminiBody(requestConfig, messages), onDelta, options)).content || apiText("noContent");
            if (answer === apiText("noContent")) onDelta(answer);
            return answer;
        }
        const answer = (await requestStreamingResponse(requestConfig, {
            model: requestConfig.model,
            input: toResponseInput(withSystemMessage(requestConfig, messages)),
            ...(requestConfig.reasoningEffort === "auto" ? {} : { reasoning: { effort: requestConfig.reasoningEffort } }),
        }, onDelta, options)).content || apiText("noContent");
        if (answer === apiText("noContent")) onDelta(answer);
        return answer;
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("requestFailed")));
    }
}

export async function fetchImageModels(config: Pick<AiConfig, "baseUrl" | "apiKey" | "apiFormat">) {
    try {
        if (config.apiFormat === "gemini") {
            const response = await axios.get<GeminiPayload>(geminiApiUrl({ ...defaultGeminiConfig, ...config }), { headers: geminiHeaders({ ...defaultGeminiConfig, ...config }) });
            validateGeminiPayload(response.data);
            return (response.data.models || [])
                .map((model) => model.name?.replace(/^models\//, ""))
                .filter((id): id is string => Boolean(id))
                .sort((a, b) => a.localeCompare(b));
        }
        const response = await axios.get<{ data?: Array<{ id?: string }>; error?: { message?: string } }>(buildApiUrl(config.baseUrl, "/models"), {
            headers: {
                Authorization: `Bearer ${config.apiKey}`,
            },
        });
        return (response.data.data || [])
            .map((model) => model.id)
            .filter((id): id is string => Boolean(id))
            .sort((a, b) => a.localeCompare(b));
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("modelReadFailed")));
    }
}

export type FetchedChannelModel = { name: string; capability: ModelCapability };

type DreamModelListItem = {
    id?: string;
    name?: string;
    display_name?: string;
    type?: string;
};

function capabilityFromDreamType(type: string | undefined, name: string): ModelCapability {
    const value = (type || "").trim().toLowerCase();
    if (value === "image" || value === "video" || value === "audio" || value === "text") return value;
    return guessCapability(name);
}

function parseDreamModelList(payload: { data?: DreamModelListItem[] } | undefined): FetchedChannelModel[] {
    const seen = new Set<string>();
    const models: FetchedChannelModel[] = [];
    for (const item of payload?.data || []) {
        const name = (item.id || item.name || item.display_name || "").trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        models.push({ name, capability: capabilityFromDreamType(item.type, name) });
    }
    return models.sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchMiaowuDreamModels(channel: ModelChannel): Promise<FetchedChannelModel[]> {
    try {
        const response = await axios.get<{ data?: DreamModelListItem[]; error?: { message?: string } }>(buildApiUrl(channel.baseUrl, isWankeChannel(channel) ? "/dream/model_list?type=video" : "/dream/model_list"), {
            headers: { Authorization: `Bearer ${channel.apiKey}` },
        });
        const models = parseDreamModelList(response.data);
        if (!models.length) throw new Error(apiText("modelReadFailed"));
        return models;
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("modelReadFailed")));
    }
}

export async function fetchChannelModels(channel: ModelChannel): Promise<FetchedChannelModel[]> {
    if (isBuiltInChannel(channel) || isWankeChannel(channel)) return fetchMiaowuDreamModels(channel);
    const names = await fetchImageModels({ baseUrl: channel.baseUrl, apiKey: channel.apiKey, apiFormat: channel.apiFormat });
    return names.map((name) => ({ name, capability: guessCapability(name) }));
}

const defaultGeminiConfig: Pick<AiConfig, "baseUrl" | "apiKey" | "apiFormat" | "model" | "systemPrompt"> = {
    baseUrl: "https://generativelanguage.googleapis.com",
    apiKey: "",
    apiFormat: "gemini",
    model: "",
    systemPrompt: "",
};
