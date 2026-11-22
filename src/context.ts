import * as vscode from 'vscode';

export interface Chunk { path: string; startLine: number; endLine: number; symbol?: string; text: string; tf: Map<string, number>; len: number }
export interface SymbolInfo { name: string; kind: string; path: string; line: number; endLine: number }
export interface Hit { chunk: Chunk; score: number; why: string[] }
export interface Retrieval { hits: Hit[]; omitted: Hit[]; usedTokens: number; budgetTokens: number; chunksIndexed: number; filesIndexed: number; query: string }

const EXCLUDE = '**/{node_modules,.git,.venv,venv,env,dist,build,out,__pycache__,.tox,.mypy_cache,.pytest_cache,.idea,.vscode-test}/**';
const INCLUDE = '**/*.{py,pyi,ts,tsx,js,jsx,mjs,go,rs,java,kt,c,h,cpp,hpp,cs,rb,php,md,rst,toml,cfg,ini,yaml,yml,json,txt,html,css}';
const STOP = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'into', 'not', 'are', 'all', 'any', 'new', 'add', 'use', 'its', 'but', 'has', 'have', 'will', 'must', 'should', 'when', 'then', 'than', 'also', 'self', 'return', 'import', 'def', 'class']);
const SYM_RE = /^(\s{0,4})(?:export\s+(?:default\s+)?)?(?:async\s+)?(def|class|function|func|fn|interface|type|struct|enum|trait|impl)\s+\*?([A-Za-z_][\w]*)/;
const MAX_CHUNK_LINES = 60;

export function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const raw of s.split(/[^A-Za-z0-9_]+/)) {
    if (!raw) continue;
    const lower = raw.toLowerCase();
    if (lower.length > 2 && !STOP.has(lower)) out.push(lower);
    const parts = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[_\s]+/);
    if (parts.length > 1) for (const p of parts) { const l = p.toLowerCase(); if (l.length > 2 && !STOP.has(l)) out.push(l); }
  }
  return out;
}

export class ContextEngine implements vscode.Disposable {
  private chunks: Chunk[] = [];
  private byFile = new Map<string, Chunk[]>();
  private symbols: SymbolInfo[] = [];
  private imports = new Map<string, Set<string>>(); // path -> basenames imported
  private df = new Map<string, number>();
  private avgLen = 1;
  private ready: Promise<void> | undefined;
  private watcher?: vscode.FileSystemWatcher;
  private dirty = new Set<string>();

  constructor(private root: () => vscode.Uri | undefined) {}

  dispose() { this.watcher?.dispose(); }

  async ensure(): Promise<void> {
    if (!this.ready) this.ready = this.build();
    await this.ready;
    if (this.dirty.size) { const d = [...this.dirty]; this.dirty.clear(); for (const p of d) await this.indexFile(p); this.recompute(); }
  }

  private async build() {
    const root = this.root();
    if (!root) return;
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(root, INCLUDE), EXCLUDE, 8000);
    for (const f of files) await this.indexFile(vscode.workspace.asRelativePath(f, false));
    this.recompute();
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, INCLUDE));
    const mark = (u: vscode.Uri) => this.dirty.add(vscode.workspace.asRelativePath(u, false));
    this.watcher.onDidChange(mark); this.watcher.onDidCreate(mark); this.watcher.onDidDelete(mark);
  }

  private async indexFile(rel: string) {
    this.removeFile(rel);
    const root = this.root(); if (!root) return;
    let text: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, rel));
      if (bytes.byteLength > 400_000) return;
      text = Buffer.from(bytes).toString('utf8');
    } catch { return; }
    const lines = text.split(/\r?\n/);
    const starts: { line: number; name: string; kind: string }[] = [];
    const imps = new Set<string>();
    lines.forEach((l, i) => {
      const m = SYM_RE.exec(l);
      if (m) starts.push({ line: i, name: m[3], kind: m[2] });
      const im = /^\s*(?:from\s+([.\w]+)\s+import|import\s+([.\w]+)|(?:import|export)\s.*from\s+['"]([^'"]+)['"])/.exec(l);
      if (im) { const mod = (im[1] || im[2] || im[3] || '').split(/[./]/).filter(Boolean).pop(); if (mod) imps.add(mod.toLowerCase()); }
    });
    this.imports.set(rel, imps);
    const bounds = [0, ...starts.filter(s => s.line > 0).map(s => s.line)];
    const out: Chunk[] = [];
    for (let b = 0; b < bounds.length; b++) {
      const from = bounds[b], to = (bounds[b + 1] ?? lines.length);
      const sym = starts.find(s => s.line === from);
      for (let s = from; s < to; s += MAX_CHUNK_LINES) {
        const e = Math.min(s + MAX_CHUNK_LINES, to);
        const body = lines.slice(s, e).join('\n');
        if (!body.trim()) continue;
        out.push(this.mkChunk(rel, s + 1, e, body, sym && s === from ? sym.name : undefined));
      }
    }
    starts.forEach((s, i) => this.symbols.push({ name: s.name, kind: s.kind, path: rel, line: s.line + 1, endLine: (starts[i + 1]?.line ?? lines.length) }));
    this.byFile.set(rel, out); this.chunks.push(...out);
  }

  private mkChunk(path: string, startLine: number, endLine: number, text: string, symbol?: string): Chunk {
    const tf = new Map<string, number>();
    const add = (t: string, w = 1) => tf.set(t, (tf.get(t) ?? 0) + w);
    for (const t of tokenize(text)) add(t);
    for (const t of tokenize(path)) add(t, 3);
    if (symbol) for (const t of tokenize(symbol)) add(t, 5);
    let len = 0; tf.forEach(v => len += v);
    return { path, startLine, endLine, symbol, text, tf, len };
  }

  private removeFile(rel: string) {
    const old = this.byFile.get(rel);
    if (old) { const s = new Set(old); this.chunks = this.chunks.filter(c => !s.has(c)); this.byFile.delete(rel); }
    this.symbols = this.symbols.filter(s => s.path !== rel); this.imports.delete(rel);
  }

  private recompute() {
    this.df.clear(); let total = 0;
    for (const c of this.chunks) { total += c.len; for (const t of c.tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1); }
    this.avgLen = this.chunks.length ? total / this.chunks.length : 1;
  }

  stats() { return { files: this.byFile.size, chunks: this.chunks.length, symbols: this.symbols.length }; }

  /** BM25 + path/symbol boosts + import-graph and test-pairing boosts, packed greedily under a token budget. */
  async retrieve(query: string, budgetTokens: number, exclude: Set<string> = new Set()): Promise<Retrieval> {
    await this.ensure();
    const q = [...new Set(tokenize(query))];
    const N = this.chunks.length || 1, k1 = 1.5, b = 0.75;
    const scored: Hit[] = [];
    for (const c of this.chunks) {
      if (exclude.has(c.path)) continue;
      let score = 0; const why: string[] = [];
      for (const t of q) {
        const f = c.tf.get(t); if (!f) continue;
        const df = this.df.get(t) ?? 0; const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * c.len / this.avgLen));
        why.push(t);
      }
      if (/(^|\/)static\//.test(c.path) || /\.(json|toml|txt|cfg|ini|ya?ml)$/.test(c.path)) score *= 0.6; // data fixtures rarely need edits
      if (score > 0) scored.push({ chunk: c, score, why });
    }
    scored.sort((a, b2) => b2.score - a.score);
    // second pass: graph boost around the strongest files
    const topFiles = [...new Set(scored.slice(0, 5).map(h => h.chunk.path))];
    const topBase = new Set(topFiles.map(baseName));
    for (const h of scored) {
      const p = h.chunk.path; if (topFiles.includes(p)) continue;
      const imps = this.imports.get(p);
      const imports = imps && [...imps].some(i => topBase.has(i));
      const imported = topFiles.some(t => this.imports.get(t)?.has(baseName(p)));
      const testPair = /(^|\/)tests?\//.test(p) && topBase.has(baseName(p).replace(/^test_?/, ''));
      if (imports) { h.score *= 1.15; h.why.push('imports a top hit'); }
      if (imported) { h.score *= 1.15; h.why.push('imported by a top hit'); }
      if (testPair) { h.score *= 1.25; h.why.push('test for a top hit'); }
    }
    scored.sort((a, b2) => b2.score - a.score);
    const picked: Hit[] = []; const omitted: Hit[] = []; const perFile = new Map<string, number>(); let used = 0;
    for (const h of scored.slice(0, 60)) {
      const cost = Math.ceil(h.chunk.text.length / 4) + 20;
      const n = perFile.get(h.chunk.path) ?? 0;
      if (used + cost > budgetTokens || n >= 2) { if (omitted.length < 12) omitted.push(h); continue; }
      picked.push(h); used += cost; perFile.set(h.chunk.path, n + 1);
    }
    picked.sort((a, b2) => a.chunk.path === b2.chunk.path ? a.chunk.startLine - b2.chunk.startLine : 0);
    return { hits: picked, omitted, usedTokens: used, budgetTokens, chunksIndexed: this.chunks.length, filesIndexed: this.byFile.size, query };
  }

  format(r: Retrieval): string {
    const files = [...new Set(r.hits.map(h => h.chunk.path))];
    let s = `# Retrieved context (${r.usedTokens}/${r.budgetTokens} tokens, ${files.length} files, from ${r.filesIndexed} indexed files)\n`;
    s += `Files chosen: ${files.join(', ')}\n\n`;
    for (const h of r.hits) {
      s += `## ${h.chunk.path}:${h.chunk.startLine}-${h.chunk.endLine}${h.chunk.symbol ? ` (${h.chunk.symbol})` : ''}\nwhy: matched [${[...new Set(h.why)].slice(0, 8).join(', ')}] score=${h.score.toFixed(2)}\n\`\`\`\n${numbered(h.chunk.text, h.chunk.startLine)}\n\`\`\`\n\n`;
    }
    if (r.omitted.length) s += `# Left out for budget (use read_file if needed)\n` + r.omitted.map(h => `- ${h.chunk.path}:${h.chunk.startLine}-${h.chunk.endLine}${h.chunk.symbol ? ` (${h.chunk.symbol})` : ''} score=${h.score.toFixed(2)}`).join('\n') + '\n';
    return s;
  }

  async findSymbol(name: string, limit = 8): Promise<string> {
    await this.ensure();
    const n = name.toLowerCase();
    const ranked = this.symbols.map(s => ({ s, r: s.name.toLowerCase() === n ? 0 : s.name.toLowerCase().startsWith(n) ? 1 : s.name.toLowerCase().includes(n) ? 2 : 9 })).filter(x => x.r < 9).sort((a, b) => a.r - b.r).slice(0, limit);
    if (!ranked.length) return `No symbol matching "${name}".`;
    const out: string[] = [];
    for (const { s } of ranked) {
      const ch = (this.byFile.get(s.path) ?? []).filter(c => c.startLine >= s.line && c.startLine <= Math.min(s.endLine, s.line + 40));
      const body = ch.map(c => c.text).join('\n').split('\n').slice(0, 40).join('\n');
      out.push(`## ${s.kind} ${s.name} — ${s.path}:${s.line}-${s.endLine}\n\`\`\`\n${numbered(body, s.line)}\n\`\`\``);
    }
    return out.join('\n\n');
  }

  async search(pattern: string, glob?: string, max = 40): Promise<string> {
    await this.ensure();
    let re: RegExp; try { re = new RegExp(pattern, 'i'); } catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
    const gre = glob ? globToRe(glob) : undefined; const res: string[] = [];
    for (const [path, chunks] of this.byFile) {
      if (gre && !gre.test(path)) continue;
      for (const c of chunks) {
        const ls = c.text.split('\n');
        for (let i = 0; i < ls.length && res.length < max; i++) if (re.test(ls[i])) res.push(`${path}:${c.startLine + i}: ${ls[i].trim().slice(0, 160)}`);
      }
      if (res.length >= max) break;
    }
    return res.length ? res.join('\n') : 'No matches.';
  }

  /** Resolve @file / @symbol mentions into attached context (counted against the same budget). */
  async expandMentions(prompt: string, budgetTokens: number): Promise<{ text: string; mentions: string[] }> {
    await this.ensure();
    const root = this.root(); const mentions: string[] = []; let text = ''; let used = 0;
    const re = /@(file:|symbol:)?([\w./\\-]+)/g; let m: RegExpExecArray | null;
    while ((m = re.exec(prompt))) {
      const kind = m[1]?.slice(0, -1); const ref = m[2];
      const isFile = kind === 'file' || (!kind && /[./\\]/.test(ref));
      if (isFile && root) {
        const hit = [...this.byFile.keys()].find(p => p === ref || p.endsWith('/' + ref));
        if (!hit) continue;
        const body = (this.byFile.get(hit) ?? []).map(c => c.text).join('\n');
        const cost = Math.ceil(body.length / 4);
        const clipped = used + cost > budgetTokens ? body.slice(0, Math.max(0, (budgetTokens - used) * 4)) : body;
        used += Math.ceil(clipped.length / 4); mentions.push(`file ${hit}${clipped.length < body.length ? ' (truncated)' : ''}`);
        text += `\n### @${hit}\n\`\`\`\n${clipped}\n\`\`\`\n`;
      } else {
        const s = await this.findSymbol(ref, 2);
        if (s.startsWith('No symbol')) continue;
        used += Math.ceil(s.length / 4); mentions.push(`symbol ${ref}`); text += `\n${s}\n`;
      }
    }
    return { text, mentions };
  }
}

const baseName = (p: string) => (p.split('/').pop() ?? p).replace(/\.[^.]+$/, '').toLowerCase();
const numbered = (t: string, start: number) => t.split('\n').map((l, i) => `${start + i}\t${l}`).join('\n');
function globToRe(g: string): RegExp {
  const esc = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '(?:.*/)?').replace(/\?/g, '.');
  return new RegExp('^' + esc + '$');
}
