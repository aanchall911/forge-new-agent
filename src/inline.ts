import * as vscode from 'vscode';
import { TrueForge, isEventDelta } from '@truefoundry/trueforge-sdk';
import { randomBytes } from 'crypto';
import { resilient } from './agent';
import { ReviewController } from './review';

const INSTRUCTIONS = 'You are a precise code editor. You receive a selected region of a file plus surrounding context and an instruction. Reply with ONLY the complete replacement for the selected region inside a single fenced code block. No commentary. Preserve indentation, style and every line the instruction does not require changing. Do not invent APIs.';

export async function inlineEdit(deps: { client: () => TrueForge; models: () => string[]; review: ReviewController; ready: () => Promise<void> }) {
  const ed = vscode.window.activeTextEditor; if (!ed || ed.selection.isEmpty) { vscode.window.showWarningMessage('Select some code first.'); return; }
  const instruction = await vscode.window.showInputBox({ prompt: 'Forge: what should change in the selection?', ignoreFocusOut: true }); if (!instruction) return;
  const doc = ed.document; const sel = ed.selection;
  const range = new vscode.Range(sel.start.line, 0, sel.end.line, doc.lineAt(sel.end.line).text.length); // whole lines
  const selected = doc.getText(range); const full = doc.getText();
  const before = full.slice(0, doc.offsetAt(range.start)); const after = full.slice(doc.offsetAt(range.end));
  const ctxBefore = doc.getText(new vscode.Range(Math.max(0, range.start.line - 40), 0, range.start.line, 0));
  const ctxAfter = doc.getText(new vscode.Range(range.end.line + 1, 0, Math.min(doc.lineCount - 1, range.end.line + 40), 0));
  const rel = vscode.workspace.asRelativePath(doc.uri, false);
  const content = `File: ${rel} (${doc.languageId})\nSelected lines ${range.start.line + 1}-${range.end.line + 1}.\n\nContext before:\n${ctxBefore}\n--- SELECTED REGION ---\n${selected}\n--- END SELECTED REGION ---\n\nContext after:\n${ctxAfter}\n\nInstruction: ${instruction}`;
  const ac = new AbortController();
  let replacement: string | undefined; let failure: string | undefined;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Forge: editing…', cancellable: true }, async (progress, token) => {
    token.onCancellationRequested(() => ac.abort());
    await deps.ready();
    let chars = 0;
    const r = await resilient({
      models: deps.models(), signal: ac.signal, info: m => progress.report({ message: m }), canRetry: () => true,
      attempt: async (model) => {
        const client = deps.client();
        const { data: s } = await client.sessions.create({ agent: { spec: { model: { name: model }, instructions: INSTRUCTIONS, config: { sandbox: { enabled: false }, generativeUi: { enabled: false }, askUserQuestions: { enabled: false }, dynamicSubAgents: { enabled: false } } } as never } }, { abortSignal: ac.signal });
        const stream = await client.sessions.createTurnStream(s.id, { input: [{ type: 'user.message', content }] }, { abortSignal: ac.signal });
        let acc = ''; let done: any;
        for await (const ev of stream as AsyncIterable<any>) {
          if (isEventDelta(ev)) { if (ev.threadId === 'main' && ev.content) { acc += ev.content; chars += ev.content.length; progress.report({ message: `${chars} chars…` }); } }
          else if (ev.type === 'turn.done') done = ev.state;
        }
        if (ac.signal.aborted) throw new Error('cancelled');
        if (!done) throw new Error('Stream ended without a turn.done event.');
        if (done.status === 'error') throw new Error(done.message ?? 'model error');
        if (done.status === 'cancelled') throw new Error('cancelled');
        return acc;
      },
    });
    if (r.ok) replacement = r.value; else if (!r.cancelled) failure = r.error;
  });
  if (failure) { vscode.window.showErrorMessage(`Forge: ${failure}`); return; }
  if (replacement === undefined) { vscode.window.showInformationMessage('Forge: cancelled — no files were changed.'); return; }
  const m = /```[\w+-]*\n([\s\S]*?)```/.exec(replacement); let code = (m ? m[1] : replacement).replace(/\n$/, '');
  if (!code.trim()) { vscode.window.showWarningMessage('Forge: the model returned an empty edit.'); return; }
  if (doc.eol === vscode.EndOfLine.CRLF) code = code.replace(/\r?\n/g, '\r\n');
  await deps.review.review({ id: randomBytes(6).toString('hex'), relPath: rel, uri: doc.uri, original: full, proposed: before + code + after, isNew: false, title: `inline edit — ${instruction.slice(0, 50)}` });
}
