import ts from 'typescript';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
function load(source) { const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText; const module = { exports: {} }; vm.runInNewContext(js, { module, exports: module.exports }); return module.exports.default; }
function flatten(value, prefix = '', result = {}) { if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, result); else result[prefix] = value; return result; }
for (const file of ['en-US.ts', 'zh-CN.ts']) { const current = flatten(load(readFileSync(`src/i18n/locales/${file}`, 'utf8'))); const head = flatten(load(execFileSync('git', ['show', `HEAD:web/src/i18n/locales/${file}`], { encoding: 'utf8' }))); const keys = [...new Set([...Object.keys(head), ...Object.keys(current)])].filter((key) => JSON.stringify(head[key]) !== JSON.stringify(current[key])); console.log(`--- ${file}: ${keys.length} changed values ---`); for (const key of keys) console.log(`${key}\n  HEAD=${JSON.stringify(head[key])}\n  NOW=${JSON.stringify(current[key])}`); }
