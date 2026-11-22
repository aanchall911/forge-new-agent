import * as vscode from 'vscode';
import { computeHunks, mergeHunks, norm, Hunk } from './hunks';

export interface Proposal { id: string; relPath: string; uri: vscode.Uri; original: string; proposed: string; isNew: boolean; title: string; range?: vscode.Range }
export interface ReviewResult { applied: boolean; accepted: number[]; rejected: number[]; total: number; note: string }
interface Session { p: Proposal; hunks: Hunk[]; keep: boolean[]; eol: string; resolve: (r: ReviewResult) => void; previewUri: vscode.Uri; leftUri: vscode.Uri }
interface JournalEntry { uri: vscode.Uri; before: string | undefined; after: string; runId: number }


export class ReviewController implements vscode.TextDocumentContentProvider, vscode.CodeLensProvider, vscode.Disposable {
  static readonly PREVIEW = 'forge-preview'; static readonly ORIG = 'forge-original';
  private sessions = new Map<string, Session>();
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  private lensEmitter = new vscode.EventEmitter<void>();
  onDidChange = this.emitter.event; onDidChangeCodeLenses = this.lensEmitter.event;
  private journal: JournalEntry[] = []; private runId = 0; private disposables: vscode.Disposable[] = [];
  private origs = new Map<string, string>();

  constructor() {
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(ReviewController.PREVIEW, this),
      vscode.workspace.registerTextDocumentContentProvider(ReviewController.ORIG, { provideTextDocumentContent: (u) => this.origs.get(u.path) ?? '' }),
      vscode.languages.registerCodeLensProvider({ scheme: ReviewController.PREVIEW }, this),
      vscode.commands.registerCommand('forge.review.toggleHunk', (id: string, i: number) => this.toggle(id, i)),
      vscode.commands.registerCommand('forge.review.apply', (id?: string) => this.finish(id ?? this.activeId(), true)),
      vscode.commands.registerCommand('forge.review.discard', (id?: string) => this.finish(id ?? this.activeId(), false)),
    );
  }
  dispose() { this.disposables.forEach(d => d.dispose()); }
  newRun() { this.runId++; }
  get currentRunId() { return this.runId; }
  hasPending() { return this.sessions.size > 0; }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const s = this.sessions.get(uri.query); return s ? this.merge(s) : '';
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const s = this.sessions.get(doc.uri.query); if (!s) return [];
    const lenses: vscode.CodeLens[] = [];
    const acc = s.keep.filter(Boolean).length;
    const top = new vscode.Range(0, 0, 0, 0);
    lenses.push(new vscode.CodeLens(top, { title: `$(check-all) Apply ${acc}/${s.hunks.length} hunks`, command: 'forge.review.apply', arguments: [s.p.id] }));
    lenses.push(new vscode.CodeLens(top, { title: '$(discard) Reject all', command: 'forge.review.discard', arguments: [s.p.id] }));
    this.layout(s).forEach((line, i) => {
      const r = new vscode.Range(Math.max(0, line), 0, Math.max(0, line), 0);
      lenses.push(new vscode.CodeLens(r, { title: s.keep[i] ? `$(check) Hunk ${i + 1}: keep — click to reject` : `$(x) Hunk ${i + 1}: rejected — click to keep`, command: 'forge.review.toggleHunk', arguments: [s.p.id, i] }));
    });
    return lenses;
  }

  private activeId() { return [...this.sessions.keys()].pop() ?? ''; }

  /** Show a diff and wait for the user's per-hunk decision. Applies accepted hunks to disk (undoable). */
  async review(p: Proposal, signal?: AbortSignal): Promise<ReviewResult> {
    
    const hunks: Hunk[] = computeHunks(p.original, p.proposed);
    if (!hunks.length) return { applied: false, accepted: [], rejected: [], total: 0, note: 'No changes (proposed text equals current text).' };
    const eol = p.original.includes('\r\n') ? '\r\n' : '\n';
    return new Promise<ReviewResult>((resolve) => {
      const previewUri = vscode.Uri.from({ scheme: ReviewController.PREVIEW, path: '/' + p.relPath, query: p.id });
      const leftUri = p.isNew ? vscode.Uri.from({ scheme: ReviewController.ORIG, path: '/' + p.id }) : p.uri;
      if (p.isNew) this.origs.set('/' + p.id, '');
      const s: Session = { p, hunks, keep: hunks.map(() => true), eol, resolve, previewUri, leftUri };
      this.sessions.set(p.id, s);
      const onAbort = () => { if (this.sessions.has(p.id)) { this.close(s); resolve({ applied: false, accepted: [], rejected: hunks.map((_, i) => i), total: hunks.length, note: 'Cancelled before review finished; nothing was written.' }); } };
      signal?.addEventListener('abort', onAbort, { once: true });
      vscode.commands.executeCommand('vscode.diff', leftUri, previewUri, `Forge: ${p.title} — review ${hunks.length} hunk(s)`, { preview: false });
      vscode.window.showInformationMessage(`Forge proposes ${hunks.length} change hunk(s) in ${p.relPath}. Use the CodeLens in the right pane to keep/reject each hunk.`, 'Apply', 'Reject all')
        .then(c => { if (c === 'Apply') this.finish(p.id, true); else if (c === 'Reject all') this.finish(p.id, false); });
    });
  }

  private toggle(id: string, i: number) { const s = this.sessions.get(id); if (!s) return; s.keep[i] = !s.keep[i]; this.emitter.fire(s.previewUri); this.lensEmitter.fire(); }

  /** Result text with kept hunks applied (rejected hunks leave the original lines). */
  private merge(s: Session): string {
    if (s.p.isNew) return s.keep.some(Boolean) ? norm(s.p.proposed) : ''; // a new file is one all-or-nothing hunk
    return mergeHunks(s.p.original, s.hunks, s.keep);
  }

  private layout(s: Session): number[] {
    const res: number[] = []; let delta = 0;
    s.hunks.forEach((h, i) => {
      const start = (h.oldLines === 0 ? h.oldStart : h.oldStart - 1) + delta; res.push(start);
      const newLen = s.keep[i] ? h.lines.filter(l => l[0] !== '-').length : h.lines.filter(l => l[0] !== '+').length;
      delta += newLen - h.oldLines;
    });
    return res;
  }

  private close(s: Session) {
    this.sessions.delete(s.p.id); this.origs.delete('/' + s.p.id);
    for (const g of vscode.window.tabGroups.all) for (const t of g.tabs) {
      const inp = t.input as { modified?: vscode.Uri } | undefined;
      if (inp?.modified?.scheme === ReviewController.PREVIEW && inp.modified.query === s.p.id) void vscode.window.tabGroups.close(t);
    }
    this.lensEmitter.fire();
  }

  private async finish(id: string, apply: boolean) {
    const s = this.sessions.get(id); if (!s) return;
    const accepted = s.keep.map((k, i) => k ? i : -1).filter(i => i >= 0);
    const rejected = s.keep.map((k, i) => !k ? i : -1).filter(i => i >= 0);
    this.close(s);
    if (!apply || !accepted.length) { s.resolve({ applied: false, accepted: [], rejected: s.hunks.map((_, i) => i), total: s.hunks.length, note: 'User rejected all hunks; nothing was written.' }); return; }
    try {
      const finalText = this.merge(s).split('\n').join(s.eol);
      await this.write(s.p, finalText);
      s.resolve({ applied: true, accepted, rejected, total: s.hunks.length, note: rejected.length ? `User accepted hunks ${accepted.map(i => i + 1)} and rejected hunks ${rejected.map(i => i + 1)}.` : 'User accepted all hunks.' });
    } catch (e) { s.resolve({ applied: false, accepted: [], rejected: s.hunks.map((_, i) => i), total: s.hunks.length, note: `Failed to apply: ${(e as Error).message}` }); }
  }

  private async write(p: Proposal, finalText: string) {
    const we = new vscode.WorkspaceEdit();
    let before: string | undefined;
    if (p.isNew) { we.createFile(p.uri, { ignoreIfExists: true }); we.insert(p.uri, new vscode.Position(0, 0), finalText); }
    else {
      const doc = await vscode.workspace.openTextDocument(p.uri);
      before = doc.getText();
      if (norm(before) !== norm(p.original)) throw new Error('file changed since the proposal was made; ask the agent to re-read it');
      const full = new vscode.Range(doc.positionAt(0), doc.positionAt(before.length));
      we.replace(p.uri, full, finalText);
    }
    if (!(await vscode.workspace.applyEdit(we))) throw new Error('VS Code rejected the edit');
    const doc = await vscode.workspace.openTextDocument(p.uri); await doc.save();
    this.journal.push({ uri: p.uri, before, after: finalText, runId: this.runId });
    await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
  }

  async undoLast(): Promise<string> { const e = this.journal.pop(); return e ? this.revert(e) : 'Nothing to undo.'; }
  async undoRun(): Promise<string> {
    const n = [...this.journal].filter(j => j.runId === this.runId).length; if (!n) return 'No changes from the last run.';
    for (let i = this.journal.length - 1; i >= 0; i--) if (this.journal[i].runId === this.runId) { const e = this.journal.splice(i, 1)[0]; await this.revert(e); }
    return `Reverted ${n} change(s).`;
  }
  appliedInRun() { return this.journal.filter(j => j.runId === this.runId).length; }

  private async revert(e: JournalEntry): Promise<string> {
    const we = new vscode.WorkspaceEdit();
    if (e.before === undefined) { we.deleteFile(e.uri, { ignoreIfNotExists: true }); await vscode.workspace.applyEdit(we); return `Removed ${vscode.workspace.asRelativePath(e.uri)}`; }
    const doc = await vscode.workspace.openTextDocument(e.uri);
    we.replace(e.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), e.before);
    await vscode.workspace.applyEdit(we); await (await vscode.workspace.openTextDocument(e.uri)).save();
    return `Reverted ${vscode.workspace.asRelativePath(e.uri)}`;
  }
}
