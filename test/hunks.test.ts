import { computeHunks, mergeHunks } from '../src/hunks'; import * as assert from 'assert'; import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
const WS = process.env.WS ?? path.join(os.tmpdir(), 'flask');
const src = fs.readFileSync(path.join(WS, 'src', 'flask', 'helpers.py'), 'utf8');
// Task A style: two separated changes (code + docstring) in get_debug_flag
let new1 = src.replace('return val.lower() not in {"0", "false", "no"}', 'return val.lower() not in {"0", "false", "no", "off", "n"}');
new1 = new1.replace('"0", "false", "no"', '"0", "false", "no", "off", "n"');
const doc = new1.replace('Get whether debug mode should be enabled', 'Get whether debug mode should be enabled (docstring edited)');
const prop = doc.replace(/^(\s*)import typing as t/m, '$1import typing as t\n$1import os as _os_unused'); // third, far-away hunk
const h = computeHunks(src, prop); console.log('hunks:', h.length);
assert.ok(h.length >= 2);
assert.strictEqual(mergeHunks(src, h, h.map(() => true)).replace(/\r/g, ''), prop, 'accept all == proposed');
assert.strictEqual(mergeHunks(src, h, h.map(() => false)), src, 'reject all == original');
for (let i = 0; i < h.length; i++) { const k = h.map((_, j) => j === i); const m = mergeHunks(src, h, k); assert.notStrictEqual(m, src); assert.notStrictEqual(m, prop); }
// edge cases: pure insertion at top, deletion at EOF, no trailing newline, empty original (new file)
for (const [a, b] of [['b\nc\n', 'a\nb\nc\n'], ['a\nb\nc\n', 'a\nb\n'], ['a\nb', 'a\nb\nc'], ['a\n', 'a\nb\nc\n'], ['x\ny\nz\n', 'x\nz\n']] as const) {
  const hh = computeHunks(a, b); assert.strictEqual(mergeHunks(a, hh, hh.map(() => true)), b, JSON.stringify([a, b]));
}
console.log('all hunk merge tests passed');
