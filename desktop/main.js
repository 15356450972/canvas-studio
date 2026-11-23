import { app, BrowserWindow, ipcMain, nativeImage, net, protocol, session, shell } from "electron";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { basename, join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { handleImageFolder } from "./image-folder.js";

// 窗口“自己消失”时，终端里的输出会随父进程一起没掉，崩溃报告又只在硬崩溃时才有。
// 这里把启动、退出、信号、渲染进程崩溃、未捕获异常都写到 userData/main.log，事后可以直接看是谁让进程退出的。
const logFile = join(app.getPath("userData"), "main.log");

function log(tag, detail) {
    const text = detail instanceof Error ? (detail.stack || detail.message) : typeof detail === "string" ? detail : JSON.stringify(detail);
    const line = `[${new Date().toISOString()}] [pid ${process.pid}] ${tag}${text ? ` ${text}` : ""}\n`;
    try {
        appendFileSync(logFile, line);
    } catch {}
    console.log(line.trimEnd());
}

process.on("uncaughtException", (error) => log("[uncaughtException]", error));
process.on("unhandledRejection", (reason) => log("[unhandledRejection]", reason));
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => {
        log(`[signal] ${signal}，父进程 ${process.ppid}`);
        app.quit();
    });
}

// 把画布里的媒体拖到剪映、Finder 等外部应用。网页的 HTML5 拖拽只能带 URL，对方拿不到文件，
// 必须由主进程落盘一份真实文件再调用 startDrag，效果等同于从 Finder 拖文件出来。
const dragCacheDir = () => join(app.getPath("userData"), "drag-cache");

// startDrag 必须要一张拖拽预览图（macOS 上不能是空图）；优先用应用图标，缺了退回内置的小方块。
const FALLBACK_DRAG_ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAF0lEQVR42mNkYPhfz0BEwKCaGmphAABxbgQBRk7c9QAAAABJRU5ErkJggg==";
let dragIcon = null;
function getDragIcon() {
    if (dragIcon) return dragIcon;
    const icon = nativeImage.createFromPath(join(import.meta.dirname, "build/icon.png"));
    dragIcon = icon.isEmpty() ? nativeImage.createFromDataURL(FALLBACK_DRAG_ICON) : icon.resize({ width: 96 });
    return dragIcon;
}

async function startFileDrag(sender, payload) {
    const name = typeof payload?.name === "string" ? payload.name : "";
    const buffer = payload?.buffer;
    if (!name || !buffer) return log("[drag-out] 参数不完整");
    // 名字只用来给剪映识别扩展名，去掉路径成分与非法字符，避免写到目录外。
    const safe = basename(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "") || "canvas-media.mp4";
    // IPC 传过来的是 ArrayBuffer，先转成 Buffer 再参与哈希与写盘。
    const data = Buffer.from(buffer);
    const dot = safe.lastIndexOf(".");
    const stem = dot > 0 ? safe.slice(0, dot) : safe;
    const extension = dot > 0 ? safe.slice(dot) : "";
    // 文件名带上内容摘要：同一节点换了素材就是另一个文件，剪映不会拿到旧内容；
    // 同一节点只留最后一份，缓存目录不会越拖越大。
    const digest = createHash("sha1").update(data).digest("hex").slice(0, 8);
    try {
        const dir = dragCacheDir();
        await mkdir(dir, { recursive: true });
        const fileName = `${stem}-${digest}${extension}`;
        const file = join(dir, fileName);
        await writeFile(file, data);
        const stale = await readdir(dir).catch(() => []);
        await Promise.all(stale.filter((entry) => entry !== fileName && entry.startsWith(`${stem}-`) && entry.endsWith(extension)).map((entry) => unlink(join(dir, entry)).catch(() => undefined)));
        log("[drag-out]", file);
        // 拖拽会话会一直占用主进程直到松手，所以放在最后。
        sender.startDrag({ file, icon: getDragIcon() });
    } catch (error) {
        log("[drag-out] 失败", error);
    }
}

ipcMain.on("canvas:drag-file", (event, payload) => void startFileDrag(event.sender, payload));

// 画布、素材等数据存在 IndexedDB，按 origin 隔离。固定用自定义协议而不是 http://localhost:端口，
// 端口被占用或变化时 origin 也不会变，数据不会因此“消失”。
const ORIGIN = "app://canvas-studio";
const webRoot = app.isPackaged ? join(process.resourcesPath, "web") : join(import.meta.dirname, "../web/dist");
// --dev：页面仍走 app:// 以保留同一份 IndexedDB，页面资源改由进程内的 Vite 提供，前端改动热更新。
const devMode = !app.isPackaged && process.argv.includes("--dev");
let devServerUrl = null;

// 同域转发规则，与 nginx.conf / web/vite.config.ts 保持一致：前缀 → 上游地址，返回 null 表示拒绝。
const upstreams = {
    __miaowu: (rest) => `https://api.miaowuai.store${rest}`,
    __oiioii: (rest) => `http://64.83.9.159:18481${rest}`,
    __uguu: (rest) => `https://uguu.se${rest}`,
    __tos: (rest) => {
        const [, host, path] = rest.match(/^\/([-0-9A-Za-z.]+)(.*)$/) || [];
        return host && /\.(volces|volcengine)\.com$/i.test(host) ? `https://${host}${path || "/"}` : null;
    },
    // 很多图床不允许网页跨域读取，页面直接下载会失败并退回成只存链接；由主进程代为下载（仅 GET）。
    __media: (rest) => {
        const target = decodeURIComponent(rest.slice(1));
        return /^https?:\/\//i.test(target) ? target : null;
    },
};

/** 描述“浏览器 → 本应用”这一跳的请求头，不能带给上游。 */
const SKIP_REQUEST_HEADERS = new Set(["host", "connection", "content-length", "accept-encoding", "origin", "referer"]);
/** net.fetch 已经解压并重新分帧，上游的分帧头不再适用。 */
const SKIP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

function pickHeaders(source, skip) {
    const headers = new Headers();
    source.forEach((value, key) => {
        if (!skip.has(key) && !key.startsWith("sec-")) headers.set(key, value);
    });
    return headers;
}

// Chromium 会把上游响应头按 UTF-8 解码后再交给 net.fetch，而 net.fetch 内部用 undici 的 Headers 承接：
// 遇到中文这类非 Latin-1 字符会抛 ByteString 异常。异常发生在其内部事件回调里，await 外面的 try/catch 拦不住，
// 主进程会直接弹出 “A JavaScript error occurred in the main process”。上游偶发把中文写进响应头（常见于国内中转），
// 所以在头进入 JS 之前把这类非法值丢掉，请求照常返回，只是少了那个头。
// 只拦主进程自己发起的请求（没有 webContentsId），不碰渲染进程自己的图片和接口。
const LATIN1_HEADER_VALUE = /^[\u0000-\u00ff]*$/;

function ignoreNonLatin1ResponseHeaders() {
    session.defaultSession.webRequest.onHeadersReceived({ urls: ["*://*/*"] }, (details, callback) => {
        const { webContentsId, responseHeaders: source, url } = details;
        // 渲染进程发起的请求由 Chromium 自己处理，这里只管主进程的 net.fetch。
        if (webContentsId !== undefined || !source) return callback({});
        const responseHeaders = {};
        for (const [name, values] of Object.entries(source)) {
            const list = Array.isArray(values) ? values : [values];
            const valid = list.filter((value) => typeof value === "string" && LATIN1_HEADER_VALUE.test(value));
            if (valid.length !== list.length) console.warn(`[headers] 已丢弃非 Latin-1 响应头 ${name}：${url}`);
            if (valid.length) responseHeaders[name] = valid;
        }
        callback({ responseHeaders });
    });
}

async function forward(request, target) {
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    const upstream = await net.fetch(target, { method: request.method, headers: pickHeaders(request.headers, SKIP_REQUEST_HEADERS), body, redirect: "follow" });
    return new Response(upstream.body, { status: upstream.status, headers: pickHeaders(upstream.headers, SKIP_RESPONSE_HEADERS) });
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = createNetServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

async function startDevServer() {
    const webDir = join(import.meta.dirname, "../web");
    // Tailwind v4 按 process.cwd() 扫描 class；从 desktop/ 启动时扫不到 web/src，工具类会整包缺失，页面塌成左上角。
    // 先切到 web 再起 Vite，听完再切回，避免主进程其它相对路径被带偏。
    const previousCwd = process.cwd();
    process.chdir(webDir);
    try {
        const { createServer } = await import(pathToFileURL(join(webDir, "node_modules/vite/dist/node/index.js")).href);
        const port = await freePort();
        // 页面地址是 app://，Vite 客户端无法从中推出 websocket 地址，必须显式指定。
        const server = await createServer({ root: webDir, server: { host: "127.0.0.1", port, strictPort: true, hmr: { protocol: "ws", host: "127.0.0.1", clientPort: port } } });
        await server.listen();
        app.on("will-quit", () => void server.close());
        return `http://127.0.0.1:${port}`;
    } finally {
        process.chdir(previousCwd);
    }
}

async function serveDev(request, url) {
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    const headers = new Headers(request.headers);
    ["host", "connection", "content-length", "accept-encoding", "origin", "referer"].forEach((name) => headers.delete(name));
    const upstream = await net.fetch(`${devServerUrl}${url.pathname}${url.search}`, { method: request.method, headers, body });
    return new Response(upstream.body, { status: upstream.status, headers: pickHeaders(upstream.headers, SKIP_RESPONSE_HEADERS) });
}

async function serveStatic(pathname) {
    const file = normalize(join(webRoot, decodeURIComponent(pathname)));
    const isFile = file.startsWith(webRoot + sep) && (await stat(file).then((info) => info.isFile(), () => false));
    // 前端是 history 路由，不是静态文件的路径一律回到 index.html。
    return net.fetch(pathToFileURL(isFile ? file : join(webRoot, "index.html")).toString());
}

async function handle(request) {
    const url = new URL(request.url);
    const [, prefix, rest = "/"] = url.pathname.match(/^\/(__[a-z]+)(\/.*)?$/) || [];
    try {
        if (prefix === "__desktop") return await handleImageFolder(request, rest, BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]);
        if (!prefix || !Object.hasOwn(upstreams, prefix)) return devServerUrl ? await serveDev(request, url) : await serveStatic(url.pathname);
        if (prefix === "__media" && request.method !== "GET") return new Response("method not allowed", { status: 405 });
        const target = upstreams[prefix](`${rest}${url.search}`);
        return target ? await forward(request, target) : new Response("forbidden", { status: 403 });
    } catch (error) {
        return new Response(error instanceof Error ? error.message : String(error), { status: 502 });
    }
}

function openExternal(url) {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
}

function createWindow() {
    const window = new BrowserWindow({ width: 1440, height: 900, minWidth: 960, minHeight: 600, backgroundColor: "#0a0a0a", title: "Canvas Studio", webPreferences: { preload: join(import.meta.dirname, "preload.cjs") } });
    window.on("closed", () => log("[window-closed]"));
    // 文档、GitHub 等外链交给系统浏览器，应用窗口只承载自身页面。
    window.webContents.setWindowOpenHandler(({ url }) => {
        openExternal(url);
        return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
        if (url.startsWith(`${ORIGIN}/`)) return;
        event.preventDefault();
        openExternal(url);
    });
    void window.loadURL(`${ORIGIN}/`);
}

// standard：启用 IndexedDB / localStorage 和相对路径解析；secure：启用选择文件夹等仅安全上下文可用的 API。
protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

// 两个实例同时读写同一份 IndexedDB 会互相覆盖，只允许一个实例。
if (!app.requestSingleInstanceLock()) {
    log("[single-instance] 已有实例在跑，本次启动直接退出");
    app.quit();
} else {
    log("[start]", `父进程 ${process.ppid}，dev=${devMode}，打包=${app.isPackaged}`);
    app.on("render-process-gone", (_event, _contents, details) => log("[render-process-gone]", details));
    app.on("child-process-gone", (_event, details) => log("[child-process-gone]", details));
    app.on("before-quit", () => log("[before-quit]"));
    app.on("will-quit", () => log("[will-quit]"));
    app.on("second-instance", () => {
        const [window] = BrowserWindow.getAllWindows();
        // macOS 关掉窗口后进程仍在，再次启动时要重新开窗。
        if (!window) return createWindow();
        if (window.isMinimized()) window.restore();
        window.focus();
    });
    app.on("window-all-closed", () => {
        log("[window-all-closed]");
        if (process.platform !== "darwin") app.quit();
    });
    void app.whenReady().then(async () => {
        ignoreNonLatin1ResponseHeaders();
        protocol.handle("app", handle);
        if (devMode) devServerUrl = await startDevServer();
        createWindow();
        app.on("activate", () => {
            if (!BrowserWindow.getAllWindows().length) createWindow();
        });
    });
}