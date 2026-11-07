import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { parseChangelog } from "./src/lib/release";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";
const localChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");

// Expose /plugins/index.json with local plugin files from public/plugins.
// The frontend can discover and list them when enabled; development reads the directory live, while builds emit a static registry.
function localPluginsManifest(): Plugin {
    const pluginsDir = resolve(webDir, "public/plugins");
    const listLocalPlugins = () => {
        try {
            return readdirSync(pluginsDir)
                .filter((file) => file.endsWith(".js"))
                .sort()
                .map((file) => `/plugins/${file}`);
        } catch {
            return [];
        }
    };
    return {
        name: "local-plugins-manifest",
        configureServer(server) {
            server.middlewares.use("/plugins/index.json", (_req, res) => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(listLocalPlugins()));
            });
        },
        generateBundle() {
            this.emitFile({ type: "asset", fileName: "plugins/index.json", source: JSON.stringify(listLocalPlugins()) });
        },
    };
}

const uguuProxy = {
    "/__uguu": {
        target: "https://uguu.se",
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/__uguu/, ""),
    },
    "/__oiioii": {
        target: "http://64.83.9.159:18481",
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/__oiioii/, ""),
    },
};

function isAllowedTosHost(host: string) {
    return /(\.volces\.com|\.volcengine\.com)$/i.test(host);
}

function miaowuApiProxy(): Plugin {
    const handle = async (req: { url?: string; method?: string; headers: { authorization?: string; accept?: string } }, res: { statusCode: number; setHeader: (name: string, value: string) => void; end: (body?: unknown) => void }, next: () => void) => {
        if (!req.url?.startsWith("/__miaowu/")) return next();
        const path = req.url.slice("/__miaowu".length) || "/";
        try {
            const headers: Record<string, string> = { Accept: req.headers.accept || "*/*" };
            if (req.headers.authorization) headers.Authorization = req.headers.authorization;
            const upstream = await fetch(`https://api.miaowuai.store${path}`, { method: req.method || "GET", headers, redirect: "follow" });
            res.statusCode = upstream.status;
            const type = upstream.headers.get("content-type");
            if (type) res.setHeader("Content-Type", type);
            res.end(Buffer.from(await upstream.arrayBuffer()));
        } catch {
            res.statusCode = 502;
            res.end("bad gateway");
        }
    };
    return {
        name: "miaowu-api-proxy",
        configureServer(server) {
            server.middlewares.use(handle);
        },
        configurePreviewServer(server) {
            server.middlewares.use(handle);
        },
    };
}

function tosMediaProxy(): Plugin {
    const handle = async (req: { url?: string }, res: { statusCode: number; setHeader: (name: string, value: string) => void; end: (body?: unknown) => void }, next: () => void) => {
        if (!req.url?.startsWith("/__tos/")) return next();
        const rest = req.url.slice("/__tos/".length);
        const slash = rest.indexOf("/");
        const host = decodeURIComponent(slash === -1 ? rest.split("?")[0] || "" : rest.slice(0, slash));
        const path = slash === -1 ? "/" : rest.slice(slash);
        if (!isAllowedTosHost(host)) {
            res.statusCode = 403;
            res.end("forbidden");
            return;
        }
        try {
            const upstream = await fetch(`https://${host}${path}`, { headers: { Accept: "image/*,video/*,*/*;q=0.8" } });
            res.statusCode = upstream.status;
            const type = upstream.headers.get("content-type");
            if (type) res.setHeader("Content-Type", type);
            res.end(Buffer.from(await upstream.arrayBuffer()));
        } catch {
            res.statusCode = 502;
            res.end("bad gateway");
        }
    };
    return {
        name: "tos-media-proxy",
        configureServer(server) {
            server.middlewares.use(handle);
        },
        configurePreviewServer(server) {
            server.middlewares.use(handle);
        },
    };
}

export default defineConfig({
    base: process.env.VITE_BASE || "/",
    plugins: [react(), localPluginsManifest(), miaowuApiProxy(), tosMediaProxy()],
    resolve: {
        alias: {
            "@": resolve(webDir, "src"),
        },
    },
    server: { proxy: uguuProxy },
    preview: { proxy: uguuProxy },
    define: {
        __APP_VERSION__: JSON.stringify(localVersion),
        __APP_RELEASES__: JSON.stringify(parseChangelog(localChangelog)),
    },
});
