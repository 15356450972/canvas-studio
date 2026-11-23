import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import i18next from "i18next";

for (const language of ["zh-CN", "en-US"]) {
    test(`${language} loads settings translations without broken object nesting`, async () => {
        const filename = new URL(`../src/i18n/locales/${language}.ts`, import.meta.url);
        const source = readFileSync(filename, "utf8");
        const parsed = ts.createSourceFile(filename.pathname, source, ts.ScriptTarget.Latest, true);
        assert.deepEqual(parsed.parseDiagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")), []);
        const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
        const module = { exports: {} };
        vm.runInNewContext(compiled, { module, exports: module.exports });
        const instance = i18next.createInstance();
        await instance.init({ lng: language, resources: { [language]: { translation: module.exports.default } } });
        // Missing object boundaries must not move these settings outside config.
        for (const key of ["config.promptSources.add", "config.imageFolder.title", "config.videoFolder.title", "agent.status.connected"]) {
            assert.ok(instance.exists(key), `Missing translation: ${key}`);
            assert.equal(typeof instance.t(key), "string");
            assert.notEqual(instance.t(key), key);
        }
    });
}
