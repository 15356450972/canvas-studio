import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Run the real exported video service without importing browser storage or React.
// Only its HTTP/storage boundaries are substituted; no network or paid generation occurs.
const source = readFileSync(new URL("../src/services/api/video.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const baseUrl = "https://64.81.113.214:8443/v1";
const config = { baseUrl, apiKey: "test-only-key", model: "newtake::wanx3.0", videoModel: "newtake::wanx3.0", channels: [], videoSeconds: "15", size: "9:16", vquality: "720p", apiFormat: "openai" };
const task = { id: "task-123", provider: "newtake", model: config.model };

function harness({ post, get, newtake = true } = {}) {
    const calls = [];
    const axios = {
        post: async (...args) => {
            calls.push(["POST", ...args]);
            return { data: await post?.(...args) };
        },
        get: async (...args) => {
            calls.push(["GET", ...args]);
            return { data: await get?.(...args) };
        },
        isCancel: () => false,
        isAxiosError: (error) => error?.isAxiosError === true,
    };
    const modules = {
        axios,
        nanoid: { nanoid: () => "test-id" },
        "@/i18n": { t: (key) => key },
        "@/lib/image-utils": { dataUrlToFile: () => new File(["image"], "reference.png", { type: "image/png" }) },
        "@/lib/media-size": { clampVideoSeconds: (value) => String(Math.min(30, Math.max(4, Number(value) || 8))), inferVideoRatio: (size) => size },
        "@/services/file-storage": { getMediaBlob: async () => new Blob(["audio"], { type: "audio/mpeg" }) },
        "@/services/image-storage": { imageToDataUrl: async () => "data:image/png;base64,aW1hZ2U=" },
        "@/services/public-upload": { resolvePublicHttpUrls: async () => [] },
        "@/stores/use-config-store": {
            NEWTAKE_MAX_IMAGES: 10,
            NEWTAKE_MAX_AUDIOS: 5,
            NEWTAKE_MAX_DURATION_SECONDS: 20,
            buildApiUrl: (base, path) => `${base.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1${path}`,
            isNewtakeRequest: () => newtake,
            resolveModelRequestConfig: (value) => ({ ...value, model: "wanx3.0" }),
            resolveModelScript: () => undefined,
            modelOptionName: (model) => model.split("::").at(-1),
        },
        "@/stores/use-video-folder-store": {},
        "./model-plugin": {},
    };
    const module = { exports: {} };
    vm.runInNewContext(
        compiled,
        {
            module,
            exports: module.exports,
            require: (name) => {
                assert.ok(name in modules, `Unexpected import: ${name}`);
                return modules[name];
            },
            Blob,
            File,
            FormData,
            DOMException,
            AbortController,
            setTimeout,
            clearTimeout,
        },
        { filename: "video.ts" },
    );
    return { service: module.exports, calls };
}

// Objects returned by the VM belong to a different realm.
const plain = (value) => JSON.parse(JSON.stringify(value));

test("Newtake creates /videos with model, prompt, seconds and top-level response id", async () => {
    const { service, calls } = harness({ post: () => ({ id: task.id, status: "queued", seconds: "15" }) });
    const result = await service.createVideoGenerationTask(config, "rainy road");
    assert.deepEqual(plain(result), task);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], `${baseUrl}/videos`);
    assert.deepEqual(plain(calls[0][2]), { model: "wanx3.0", prompt: "rainy road", seconds: 15 });
    assert.equal(calls[0][3].headers.Authorization, "Bearer test-only-key");
});

test("Newtake uploads images/audio first and forwards ordered ID arrays", async () => {
    const { service, calls } = harness({
        post: (url) =>
            url.endsWith("/images")
                ? {
                      images: [
                          { id: "ref-1", kind: "image" },
                          { id: "ref-2", kind: "image" },
                          { id: "aud-1", kind: "audio" },
                      ],
                  }
                : { id: task.id },
    });
    await service.createVideoGenerationTask(config, "references", [{ name: "a" }, { name: "b" }], { audios: [{ name: "voice.mp3", storageKey: "audio-1" }] });
    assert.equal(calls[0][1], `${baseUrl}/images`);
    assert.equal(calls[0][2].getAll("files").length, 2);
    assert.equal(calls[0][2].getAll("audios").length, 1);
    assert.equal(calls[1][1], `${baseUrl}/videos`);
    assert.deepEqual(plain(calls[1][2]), { model: "wanx3.0", prompt: "references", seconds: 15, image_ids: ["ref-1", "ref-2"], audio_ids: ["aud-1"] });
});

for (const status of ["queued", "in_progress"]) {
    test(`Newtake polls ${status} from top-level video object`, async () => {
        const { service, calls } = harness({ get: () => ({ id: task.id, status }) });
        assert.deepEqual(plain(await service.pollVideoGenerationTask(config, task)), { status: "pending" });
        assert.equal(calls[0][1], `${baseUrl}/videos/${task.id}`);
        assert.equal(calls.length, 1);
    });
}

test("Newtake completed task downloads authenticated /content", async () => {
    const content = new Blob(["video"], { type: "video/mp4" });
    const { service, calls } = harness({ get: (url) => (url.endsWith("/content") ? content : { id: task.id, status: "completed" }) });
    const result = await service.pollVideoGenerationTask(config, task);
    assert.equal(result.status, "completed");
    assert.equal(result.result.blob, content);
    assert.equal(calls[1][1], `${baseUrl}/videos/${task.id}/content`);
    assert.equal(calls[1][2].headers.Authorization, "Bearer test-only-key");
    assert.equal(calls[1][2].responseType, "blob");
});

test("Newtake failed task displays error.message and does not download", async () => {
    const { service, calls } = harness({ get: () => ({ id: task.id, status: "failed", error: { message: "upstream quota exhausted" } }) });
    assert.deepEqual(plain(await service.pollVideoGenerationTask(config, task)), { status: "failed", error: "upstream quota exhausted" });
    assert.equal(calls.length, 1);
});

for (const seconds of ["4", "20", ""]) {
    test(`Newtake accepts documented duration ${JSON.stringify(seconds)}`, async () => {
        const { service, calls } = harness({ post: () => ({ id: task.id }) });
        await service.createVideoGenerationTask({ ...config, videoSeconds: seconds }, "test");
        assert.equal(calls[0][2].seconds, seconds ? Number(seconds) : 4);
    });
}

for (const seconds of ["3", "21", "4.5", "not-a-number"]) {
    test(`Newtake rejects invalid duration ${seconds} before HTTP`, async () => {
        const { service, calls } = harness({ post: () => ({ tasks: [{ id: task.id }], id: task.id }) });
        await assert.rejects(service.createVideoGenerationTask({ ...config, videoSeconds: seconds }, "test"), /newtakeDurationInvalid/);
        assert.equal(calls.length, 0);
    });
}

for (const [name, images, audios, error] of [
    ["too many images", 11, 0, "newtakeImageLimit"],
    ["too many audios", 1, 6, "newtakeAudioLimit"],
    ["audio without image", 0, 1, "newtakeAudioNeedsImage"],
]) {
    test(`Newtake rejects ${name} before uploading`, async () => {
        const { service, calls } = harness({ post: () => ({ tasks: [{ id: task.id }], id: task.id, images: [] }) });
        await assert.rejects(
            service.createVideoGenerationTask(
                config,
                "test",
                Array.from({ length: images }, () => ({ name: "image" })),
                { audios: Array.from({ length: audios }, () => ({ name: "audio.mp3", storageKey: "audio" })) },
            ),
            new RegExp(error),
        );
        assert.equal(calls.length, 0);
    });
}

test("Newtake rejects reference videos before HTTP", async () => {
    const { service, calls } = harness();
    await assert.rejects(service.createVideoGenerationTask(config, "test", [], { videos: [{ name: "video.mp4" }] }), /newtakeVideoRefUnsupported/);
    assert.equal(calls.length, 0);
});

test("ordinary OpenAI provider keeps its own parameters and provider tag", async () => {
    const { service, calls } = harness({ newtake: false, post: () => ({ id: "other-id" }) });
    const result = await service.createVideoGenerationTask(config, "test");
    assert.equal(result.provider, "openai");
    assert.equal(calls[0][2].ratio, "9:16");
    assert.equal(calls[0][2].resolution, "720p");
});
