import * as vscode from 'vscode';
import { TrueForge, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';
import { ReviewController, ReviewResult } from './review';
import { buildProposal, callKey, PROPOSAL_TOOLS, Args } from './tools';
import { ContextEngine, Retrieval } from './context';

export interface Ui {
  delta(text: string): void; tool(name: string, summary: string, state: 'run' | 'ok' | 'denied'): void;
  context(info: { retrieval?: Retrieval; mentions?: string[] }): void; info(msg: string): void; error(msg: string): void; done(summary: string): void;
}

class Cancelled extends Error { constructor() { super('cancelled'); } }
const AUTH_RE = /\b(401|403|unauthori[sz]ed|invalid.{0,20}(api )?key|forbidden)\b/i;

/** Retry with backoff on one model, then fall through to the next configured model. Never touches the workspace. */
export async function resilient<T>(o: { models: string[]; signal: AbortSignal; info: (m: string) => void; canRetry: () => boolean; attempt: (model: string, n: number) => Promise<T> }):
  Promise<{ ok: true; value: T; model: string } | { ok: false; error: string; cancelled: boolean }> {
  const errors: string[] = [];
  for (let mi = 0; mi < o.models.length; mi++) {
    const model = o.models[mi];
    if (mi > 0) o.info(`Switching to fallback model ${model}…`);
    for (let n = 0; n < 2; n++) {
      try { return { ok: true, value: await o.attempt(model, n), model }; }
      catch (e) {
        if (o.signal.aborted || e instanceof Cancelled) return { ok: false, error: 'Cancelled.', cancelled: true };
        const msg = (e as Error).message || String(e);
        if (!o.canRetry()) return { ok: false, error: `${model} failed after changes were already applied: ${msg}`, cancelled: false };
        errors.push(`${model}: ${msg.slice(0, 200)}`);
        if (AUTH_RE.test(msg) || n === 1) break;
        o.info(`${model} failed (${msg.slice(0, 120)}). Retrying in ${1 << n}s…`);
        await new Promise(r => setTimeout(r, 1000 * (1 << n)));
      }
    }
  }
  return { ok: false, error: `No configured model could complete the request. ${errors.join(' | ')}. No files were changed.`, cancelled: false };
}

export interface RunnerDeps {
  client: () => TrueForge; models: () => string[]; spec: () => Record<string, unknown>; review: ReviewController;
  approvals: Map<string, ReviewResult | { command: true }>; ctx: ContextEngine; budget: () => number; ready: () => Promise<void>;
}

export class AgentRunner {
  private abort?: AbortController; private session?: { id: string; model: string }; running = false;
  constructor(private d: RunnerDeps) {}
  get signal() { return this.abort?.signal; }
  newChat() { this.session = undefined; }

  cancel() {
    if (!this.running) return;
    this.abort?.abort();
    const id = this.session?.id; if (id) void this.d.client().sessions.cancel(id).catch(() => undefined);
  }

  async run(prompt: string, ui: Ui) {
    if (this.running) { ui.info('A task is already running.'); return; }
    this.running = true; this.abort = new AbortController(); const signal = this.abort.signal;
    this.d.review.newRun(); this.d.approvals.clear();
    try {
      await this.d.ready();
      const { text, mentions } = await this.d.ctx.expandMentions(prompt, Math.floor(this.d.budget() / 2));
      if (mentions.length) ui.context({ mentions });
      const content = text ? `${prompt}\n\n[Context attached via @-mentions]\n${text}` : prompt;
      const r = await resilient({
        models: this.d.models(), signal, info: m => ui.info(m), canRetry: () => this.d.review.appliedInRun() === 0,
        attempt: (model, n) => this.attempt(model, n, content, ui, signal),
      });
      const applied = this.d.review.appliedInRun();
      if (r.ok) ui.done(`${r.value}${applied ? ` ${applied} change(s) applied (each reviewed by you). Run "Forge: Undo All Changes From Last Run" to revert.` : ''}`);
      else if (r.cancelled) ui.done(applied ? `Cancelled. ${applied} change(s) you had already approved remain on disk; nothing half-applied. "Forge: Undo All Changes From Last Run" reverts them.` : 'Cancelled. No files were changed.');
      else ui.error(r.error);
    } catch (e) { ui.error((e as Error).message); }
    finally { this.running = false; }
  }

  private async attempt(model: string, n: number, content: string, ui: Ui, signal: AbortSignal): Promise<string> {
    const client = this.d.client();
    if (!this.session || this.session.model !== model || n > 0) {
      const { data } = await client.sessions.create({ agent: { spec: { ...(this.d.spec() as object), model: { name: model } } as never } }, { abortSignal: signal });
      this.session = { id: data.id, model };
    }
    const sid = this.session.id;
    const events = new Map<string, any>(); let turnId = ''; let lastId: string | undefined; let final: any;
    const pending: any[] = [];
    const consume = async (stream: AsyncIterable<any>): Promise<'paused' | 'done'> => {
      for await (const ev of stream) {
        if (signal.aborted) throw new Cancelled();
        lastId = ev.id;
        if (isEventDelta(ev)) { const b = events.get(ev.id); if (b) mergeEventDelta(b, ev); if (ev.threadId === 'main' && ev.content) ui.delta(ev.content); continue; }
        events.set(ev.id, ev);
        switch (ev.type) {
          case 'turn.created': turnId = ev.turnId; break;
          case 'thread.created': ui.tool('subagent', ev.title ?? 'subagent', 'run'); break;
          case 'tool.approval_required': case 'tool.response_required': pending.push(ev); break;
          case 'tool.response': ui.tool(this.nameOf(events, ev.toolCallId), 'result received', 'ok'); break;
          case 'turn.update': if (ev.state?.status === 'paused') return 'paused'; break;
          case 'turn.done': final = ev.state; return 'done';
        }
      }
      if (!final) throw new Error('Stream ended without a turn.done event.');
      return 'done';
    };
    try {
      let stream: AsyncIterable<any> = await client.sessions.createTurnStream(sid, { input: [{ type: 'user.message', content }] }, { abortSignal: signal });
      let state = await consume(stream);
      while (state === 'paused') {
        const answers = await this.answer(events, pending.splice(0), ui, signal);
        const sub = await client.sessions.subscribeToTurn(sid, turnId, { afterEventId: lastId }, { abortSignal: signal, timeoutInSeconds: 600 });
        await client.sessions.createTurnEvents(sid, turnId, { events: answers as never });
        state = await consume(sub);
      }
    } catch (e) { if (signal.aborted) throw new Cancelled(); throw e; }
    if (signal.aborted || final?.status === 'cancelled') throw new Cancelled();
    if (final?.status === 'error') { this.session = undefined; throw new Error(final.message ?? 'model error'); }
    const m = final?.metrics;
    return `Done.${m ? ` (${m.totalTokens ?? ''} tokens${m.totalCostInUsd != null ? `, ~$${Number(m.totalCostInUsd).toFixed(4)}` : ''})` : ''}`;
  }

  private nameOf(events: Map<string, any>, callId: string): string {
    for (const e of events.values()) if (e.type === 'model.message') { const c = e.toolCalls?.find((t: any) => t.id === callId); if (c) return c.toolInfo?.name ?? c.function?.name ?? 'tool'; }
    return 'tool';
  }

  private race<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((res, rej) => { signal.addEventListener('abort', () => rej(new Cancelled()), { once: true }); p.then(res, rej); });
  }

  /** Turn TrueForge approval pauses into editor UI: diff review for edits, confirmation for commands, quick-pick for questions. */
  private async answer(events: Map<string, any>, pending: any[], ui: Ui, signal: AbortSignal): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const p of pending) for (const ref of p.toolCalls) {
      const msg = events.get(ref.sourceEventId); const call = msg?.toolCalls?.find((t: any) => t.id === ref.id);
      const name: string = call?.toolInfo?.name ?? call?.function?.name ?? ''; let args: Args = {};
      try { args = JSON.parse(call?.function?.arguments || '{}'); } catch { /* handled below */ }
      const base = { threadId: p.threadId, toolCallId: ref.id };
      if (p.type === 'tool.response_required') {
        const q = String(args.question ?? 'The agent has a question'); const opts = (args.options as string[] | undefined) ?? [];
        let ans = opts.length ? await this.race(Promise.resolve(vscode.window.showQuickPick([...opts, 'Other…'], { title: q, ignoreFocusOut: true })), signal) : undefined;
        if (!ans || ans === 'Other…') ans = await this.race(Promise.resolve(vscode.window.showInputBox({ prompt: q, ignoreFocusOut: true })), signal);
        out.push({ type: 'user.tool_response', ...base, content: ans ?? 'No answer given.' }); continue;
      }
      const tool = PROPOSAL_TOOLS.find(t => name.endsWith(t));
      if (tool) {
        ui.tool(tool, String(args.path ?? ''), 'run');
        const { proposal, error } = await buildProposal(tool, args);
        if (!proposal) { ui.tool(tool, error ?? 'invalid', 'denied'); out.push({ type: 'user.tool_approval', ...base, approval: { status: 'deny', reason: error } }); continue; }
        const res = await this.race(this.d.review.review(proposal, signal), signal);
        this.d.approvals.set(callKey(tool, args), res);
        ui.tool(tool, `${proposal.relPath}: ${res.note}`, res.applied ? 'ok' : 'denied');
        out.push({ type: 'user.tool_approval', ...base, approval: res.applied ? { status: 'allow' } : { status: 'deny', reason: res.note } });
      } else if (name.endsWith('run_command')) {
        const cmd = String(args.command ?? ''); ui.tool('run_command', cmd, 'run');
        const pick = await this.race(Promise.resolve(vscode.window.showWarningMessage(`Forge wants to run: ${cmd}`, 'Allow', 'Deny')), signal);
        if (pick === 'Allow') { this.d.approvals.set(callKey('run_command', args), { command: true }); out.push({ type: 'user.tool_approval', ...base, approval: { status: 'allow' } }); }
        else { ui.tool('run_command', 'denied by user', 'denied'); out.push({ type: 'user.tool_approval', ...base, approval: { status: 'deny', reason: 'User denied the command.' } }); }
      } else out.push({ type: 'user.tool_approval', ...base, approval: { status: 'deny', reason: `Tool ${name} is not allowed.` } });
    }
    return out;
  }
}
