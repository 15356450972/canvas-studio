import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/services/public-upload-name.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
vm.runInNewContext(compiled, { module, exports: module.exports });
const { safeUploadFileName } = module.exports;

test("Chinese reference filenames are reduced to ASCII names", () => {
    // uguu 对非 ASCII 文件名会直接返回 500 Server error。
    const cases = [
        ["参考图 2026-11-14.png", "image/png"],
        ["截屏2026-11-14 20.30.11.png", "image/png"],
        ["中文.png", "image/png"],
        ["日本語1.png", "image/png"],
    ];
    for (const [name, type] of cases) {
        const safe = safeUploadFileName(name, type);
        assert.match(safe, /^[A-Za-z0-9._-]+$/, `${name} -> ${safe}`);
        assert.ok(safe.endsWith(".png"), `${name} -> ${safe}`);
        assert.ok(!safe.startsWith("."), `${name} -> ${safe}`);
    }
});

test("ASCII filenames keep their readable stem and extension", () => {
    assert.equal(safeUploadFileName("reference-01.png", "image/jpeg"), "reference-01.png");
    assert.equal(safeUploadFileName("my ref 01.jpg", "image/jpeg"), "my-ref-01.jpg");
    assert.equal(safeUploadFileName("clip.mp4", "video/mp4"), "clip.mp4");
});

test("filenames without a usable stem or extension fall back safely", () => {
    assert.equal(safeUploadFileName("中文", "image/webp"), "file.webp");
    assert.equal(safeUploadFileName("", "image/jpeg"), "file.jpg");
    assert.equal(safeUploadFileName(undefined, ""), "file.bin");
    assert.equal(safeUploadFileName("../assets/图片.png", "image/png"), "file.png");
});
