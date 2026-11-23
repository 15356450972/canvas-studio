import { app, dialog } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

// 图片与视频使用独立配置，保留原有 image-folder.json，不迁移或覆盖图片目录。
const settingsFile = (kind) => join(app.getPath("userData"), `${kind}-folder.json`);
const json = (value, status = 200) => Response.json(value, { status });

async function readFolder(kind) {
    try {
        return String(JSON.parse(await readFile(settingsFile(kind), "utf8")).path || "");
    } catch (error) {
        if (error.code === "ENOENT") return "";
        throw error;
    }
}

async function writeFolder(kind, path) {
    await writeFile(settingsFile(kind), JSON.stringify({ path }));
    return path;
}

async function pickFolder(kind, window) {
    const current = await readFolder(kind);
    const { canceled, filePaths } = await dialog.showOpenDialog(window, { defaultPath: current || app.getPath(kind === "video" ? "videos" : "pictures"), properties: ["openDirectory", "createDirectory"] });
    return canceled || !filePaths[0] ? current : writeFolder(kind, filePaths[0]);
}

async function saveFile(kind, name, data) {
    const root = await readFolder("media");
    const folder = root ? join(root, kind === "video" ? "视频" : "图片") : await readFolder(kind);
    if (!folder) return json({ error: "未设置保存文件夹" }, 409);
    if (root) await mkdir(folder, { recursive: true });
    const safe = basename(name).replace(/[\\/:*?"<>|]/g, "_").replace(/^\.+/, "") || (kind === "video" ? "video.bin" : "image.png");
    const ext = extname(safe);
    const stem = safe.slice(0, safe.length - ext.length);
    // 排他创建确保重复保存或并发写入都不会覆盖已有文件。
    for (let index = 1; ; index += 1) {
        const file = join(folder, index === 1 ? safe : `${stem}-${index}${ext}`);
        try {
            await writeFile(file, data, { flag: "wx" });
            return json({ path: file });
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
        }
    }
}

export async function handleImageFolder(request, rest, window) {
    const match = rest.match(/^\/(image|video|media)-folder(.*)$/);
    if (!match) return json({ error: "not found" }, 404);
    const [, kind, path] = match;
    const { method } = request;
    if (path === "" && method === "GET") {
        const root = await readFolder("media");
        return json({ path: root || await readFolder(kind) });
    }
    if (path === "/pick" && method === "POST") return json({ path: await pickFolder("media", window) });
    if (path === "/clear" && method === "POST") {
        await writeFolder("image", "");
        await writeFolder("video", "");
        return json({ path: await writeFolder("media", "") });
    }
    const [, name] = path.match(/^\/files\/([^/]+)$/) || [];
    if (name && method === "POST") return saveFile(kind, decodeURIComponent(name), Buffer.from(await request.arrayBuffer()));
    return json({ error: "not found" }, 404);
}