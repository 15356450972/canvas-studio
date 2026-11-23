import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/services/public-upload-retry.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
vm.runInNewContext(compiled, { module, exports: module.exports, setTimeout });
const { retryPublicUpload, isRetryablePublicUploadError } = module.exports;

test("public uploads retry server failures and return on recovery", async () => {
    let attempts = 0;
    const result = await retryPublicUpload(
        async () => {
            attempts += 1;
            if (attempts < 3) throw Object.assign(new Error("Server error."), { code: 500 });
            return "https://files.example/image.png";
        },
        { delay: async () => {} },
    );
    assert.equal(result, "https://files.example/image.png");
    assert.equal(attempts, 3);
});

test("public uploads do not retry permanent failures", async () => {
    let attempts = 0;
    await assert.rejects(
        retryPublicUpload(
            async () => {
                attempts += 1;
                throw Object.assign(new Error("invalid file"), { code: 400 });
            },
            { delay: async () => {} },
        ),
        /invalid file/,
    );
    assert.equal(attempts, 1);
});

test("Uguu 5xx responses and server error descriptions are retryable", () => {
    assert.equal(isRetryablePublicUploadError(Object.assign(new Error("Server error."), { code: 500 })), true);
    assert.equal(isRetryablePublicUploadError(Object.assign(new Error("Bad gateway"), { response: { status: 502 } })), true);
    assert.equal(isRetryablePublicUploadError(Object.assign(new Error("Unsupported file"), { code: 400 })), false);
});
