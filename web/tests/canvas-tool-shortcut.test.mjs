import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/pages/canvas/canvas-tool-shortcut.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
vm.runInNewContext(compiled, { module, exports: module.exports });
const { getCanvasToolAfterShortcut, getShouldHandleCanvasToolToggle } = module.exports;

test("A toggles the canvas between selection and pan tools", () => {
    assert.equal(getCanvasToolAfterShortcut("pan"), "select");
    assert.equal(getCanvasToolAfterShortcut("select"), "pan");
});

test("A toggles the tool from non-editable zoom-isolated canvas controls", () => {
    assert.equal(
        getShouldHandleCanvasToolToggle({ key: "a", metaKey: false, ctrlKey: false, altKey: false, isEditable: false, isShortcutsIgnored: false }),
        true,
    );
});

test("A does not toggle while typing or when a modifier is held", () => {
    assert.equal(
        getShouldHandleCanvasToolToggle({ key: "a", metaKey: false, ctrlKey: false, altKey: false, isEditable: true, isShortcutsIgnored: false }),
        false,
    );
    assert.equal(
        getShouldHandleCanvasToolToggle({ key: "a", metaKey: true, ctrlKey: false, altKey: false, isEditable: false, isShortcutsIgnored: false }),
        false,
    );
});
