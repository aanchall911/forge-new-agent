import * as vscode from 'vscode';
import * as cp from 'child_process';
import { createHash } from 'crypto';
import { Proposal, ReviewResult } from './review';

export const PROPOSAL_TOOLS = ['propose_edit', 'propose_new_file'];
export type Args = Record<string, unknown>;

export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v as object).sort().map(k => JSON.stringify(k) + ':' + stableStringify((v as Args)[k])).join(',') + '}';
  return JSON.stringify(v);
}
export const callKey = (tool: string, args: Args) => createHash('sha1').update(tool + stableStringify(args)).digest('hex').slice(0, 16);

export function root(): vscode.Uri { const f = vscode.workspace.workspaceFolders?.[0]; if (!f) throw new Error('No workspace folder is open.'); return f.uri; }

export function resolveSafe(rel: string): vscode.Uri {
  const r = root(); const clean = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  const uri = vscode.Uri.joinPath(r, clean);
  if (!uri.path.startsWith(r.path)) throw new Error(`Path escapes the workspace: ${rel}`);
  return uri;
}

export async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try { return (await vscode.workspace.openTextDocument(uri)).getText(); } catch { return undefined; }
}

export async function readLines(rel: string, start = 1, end?: number, cap = 400): Promise<string> {
  const text = await readText(resolveSafe(rel)); if (text === undefined) return `File not found: ${rel}`;
  const lines = text.split(/\r?\n/); const s = Math.max(1, start); const e = Math.min(lines.length, end ?? s + 199, s + cap - 1);
  return `${rel} (lines ${s}-${e} of ${lines.length})\n` + lines.slice(s - 1, e).map((l, i) => `${s + i}\t${l}`).join('\n') + (e < lines.length ? `\n… ${lines.length - e} more lines; call again with start_line=${e + 1}` : '');
}

/** Build a Proposal from a propose_* tool call. Returns an error string the agent can act on. */
export async function buildProposal(tool: string, args: Args): Promise<{ proposal?: Proposal; error?: string }> {
  const rel = String(args.path ?? ''); if (!rel) return { error: 'Missing "path".' };
  let uri: vscode.Uri; try { uri = resolveSafe(rel); } catch (e) { return { error: (e as Error).message }; }
  const id = callKey(tool, args); const rationale = String(args.rationale ?? '');
  if (tool === 'propose_new_file') {
    if ((await readText(uri)) !== undefined) return { error: `${rel} already exists; use propose_edit.` };
    return { proposal: { id, relPath: rel, uri, original: '', proposed: String(args.content ?? ''), isNew: true, title: `${rel} (new)${rationale ? ' — ' + rationale : ''}` } };
  }
  const original = await readText(uri); if (original === undefined) return { error: `File not found: ${rel}. Use propose_new_file to create it.` };
  const edits = args.edits as { old_text: string; new_text: string }[] | undefined;
  if (!Array.isArray(edits) || !edits.length) return { error: 'Provide a non-empty "edits" array of {old_text,new_text}.' };
  let text = original.replace(/\r\n/g, '\n');
  for (const [i, ed] of edits.entries()) {
    const old = String(ed.old_text ?? '').replace(/\r\n/g, '\n');
    if (!old) return { error: `edit ${i + 1}: old_text is empty.` };
    const n = text.split(old).length - 1;
    if (n === 0) return { error: `edit ${i + 1}: old_text not found in ${rel}. Re-read the file region and copy the text exactly.` };
    if (n > 1) return { error: `edit ${i + 1}: old_text occurs ${n} times in ${rel}; include more surrounding lines so it is unique.` };
    text = text.replace(old, () => String(ed.new_text ?? '').replace(/\r\n/g, '\n'));
  }
  return { proposal: { id, relPath: rel, uri, original, proposed: text, isNew: false, title: `${rel}${rationale ? ' — ' + rationale : ''}` } };
}

export function describeResult(r: ReviewResult): string {
  return r.applied ? `APPLIED. ${r.note} (${r.accepted.length}/${r.total} hunks written to disk).` : `NOT APPLIED. ${r.note}`;
}

export function runCommand(command: string, timeoutS: number, signal: AbortSignal | undefined, out: vscode.OutputChannel): Promise<string> {
  return new Promise(resolve => {
    out.appendLine(`$ ${command}`);
    const child = cp.spawn(command, { shell: true, cwd: root().fsPath, env: process.env });
    let buf = ''; let done = false;
    const add = (d: Buffer) => { const s = d.toString(); buf += s; out.append(s); if (buf.length > 200_000) buf = buf.slice(-100_000); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const finish = (msg: string) => { if (done) return; done = true; clearTimeout(timer); const tail = buf.length > 8000 ? '…(truncated)…\n' + buf.slice(-8000) : buf; resolve(`${msg}\n${tail}`); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(`TIMEOUT after ${timeoutS}s`); }, timeoutS * 1000);
    signal?.addEventListener('abort', () => { child.kill('SIGKILL'); finish('CANCELLED by user'); }, { once: true });
    child.on('close', code => finish(`exit code ${code}`));
    child.on('error', e => finish(`failed to start: ${e.message}`));
  });
}
