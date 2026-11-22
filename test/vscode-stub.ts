import * as fs from 'fs'; import * as p from 'path'; import * as os from 'os';
export const ROOT = process.env.WS ?? p.join(os.tmpdir(), 'flask');
export class Uri { constructor(public fsPath: string) {} get path() { return this.fsPath; } static file(f: string) { return new Uri(f); } static joinPath(b: Uri, ...s: string[]) { return new Uri(p.join(b.fsPath, ...s)); } }
export class RelativePattern { constructor(public base: Uri, public pattern: string) {} }
function walk(d: string, out: string[]) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (['.git', 'node_modules', '__pycache__', '.venv'].includes(e.name)) continue; const f = p.join(d, e.name); e.isDirectory() ? walk(f, out) : out.push(f); } }
export const workspace = {
  workspaceFolders: [{ uri: new Uri(ROOT) }],
  async findFiles(_pat: RelativePattern, _ex: string, max: number) { const o: string[] = []; walk(ROOT, o); return o.filter(f => /\.(py|md|rst|toml|cfg|ini|yaml|yml|json|txt|html|css|js)$/.test(f)).slice(0, max).map(f => new Uri(f)); },
  fs: { readFile: async (u: Uri) => fs.promises.readFile(u.fsPath) },
  asRelativePath: (u: Uri, _includeWorkspace?: boolean) => p.relative(ROOT, u.fsPath).replace(/\\/g, '/'),
  createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }),
  openTextDocument: async (u: Uri) => ({ getText: () => fs.readFileSync(u.fsPath, 'utf8') }),
};
export const window = { createOutputChannel: () => ({ appendLine() {}, append() {} }) };
