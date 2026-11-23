const DEFAULT_RETRIES = 2;
const DEFAULT_DELAY_MS = 400;

export function isRetryablePublicUploadError(error: unknown) {
    const candidate = error as { code?: unknown; response?: { status?: unknown }; message?: unknown } | null;
    const status = Number(candidate?.response?.status ?? candidate?.code);
    if (status >= 500 && status <= 599) return true;
    return /\b(server error|bad gateway|service unavailable|gateway timeout)\b/i.test(String(candidate?.message || error));
}

export async function retryPublicUpload<T>(
    operation: () => Promise<T>,
    options: { retries?: number; delay?: (ms: number) => Promise<void> } = {},
) {
    const retries = options.retries ?? DEFAULT_RETRIES;
    const delay = options.delay || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let attempt = 0;
    while (true) {
        try {
            return await operation();
        } catch (error) {
            if (attempt >= retries || !isRetryablePublicUploadError(error)) throw error;
            attempt += 1;
            await delay(DEFAULT_DELAY_MS * attempt);
        }
    }
}
