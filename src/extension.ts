import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import { ContextEngine } from './context';
import { ReviewController, ReviewResult } from './review';
import { startMcp, McpHandle } from './mcp';
import { AgentRunner } from './agent';
import { AgentPanel } from './panel';
import { inlineEdit } from './inline';

export async function activate(ext: vscode.ExtensionContext) {
  const cfg = () => vscode.workspace.getConfiguration('forge');
  const out = vscode.window.createOutputChannel('Forge');
  const ctx = new ContextEngine(() => vscode.workspace.workspaceFolders?.[0]?.uri);
  const review = new ReviewController();
  const approvals = new Map<string, ReviewResult | { command: true }>();
  const panel = new AgentPanel(ext);
  const baseUrl = () => cfg().get<string>('trueforge.baseUrl', 'http://localhost:8790').replace(/\/$/, '');
  const client = () => new TrueForge({ baseUrl: baseUrl(), timeoutInSeconds: 600 });
  const models = () => { const m = cfg().get<string[]>('models', []); return m.length ? m : ['anthropic/claude-sonnet-4-6']; };
  const budget = () => cfg().get<number>('contextBudgetTokens', 6000);
  const spec = () => { const s = JSON.parse(fs.readFileSync(path.join(ext.extensionPath, 'agent', 'forge-agent.json'), 'utf8')); s.config.iterationLimit = cfg().get('iterationLimit', 60); return s; };

  let runner: AgentRunner; let mcp: McpHandle | undefined; let ready: Promise<void> | undefined;
  const connect = async (): Promise<void> => {
    mcp ??= await startMcp({ ctx, budget, out, approvals, signal: () => runner?.signal, onContext: r => panel.ui().context({ retrieval: r }), onTool: () => undefined }, cfg().get<number>('mcpPort', 0));
    // Register our local MCP server in TrueForge (header auth). PUT replaces by name, so this is idempotent.
    const res = await fetch(`${baseUrl()}/api/v1/settings/mcp-servers`, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: { type: 'remote', name: 'forge-editor', url: mcp.url, description: 'VS Code editor tools: retrieval, file reads, reviewed edits, commands.', auth: { type: 'header', headers: { Authorization: `Bearer ${mcp.token}` } } } }) });
    if (!res.ok) throw new Error(`TrueForge rejected MCP registration (${res.status}): ${(await res.text()).slice(0, 200)}`);
  };
  // Connection is lazy + cached; a failure is surfaced to the caller (agent/inline) as a clear message, never a hang.
  const ensureReady = () => (ready ??= connect().catch(e => { ready = undefined; throw new Error(`Cannot reach TrueForge at ${baseUrl()} — is "npx @truefoundry/trueforge" running? (${(e as Error).message})`); }));

  runner = new AgentRunner({ client, models, spec, review, approvals, ctx, budget, ready: ensureReady });
  panel.onSend = t => { void runner.run(t, panel.ui()); };
  panel.onNew = () => { runner.newChat(); };

  ext.subscriptions.push(out, ctx, review,
    vscode.window.registerWebviewViewProvider('forge.agentView', panel),
    vscode.commands.registerCommand('forge.openAgent', () => vscode.commands.executeCommand('forge.agentView.focus')),
    vscode.commands.registerCommand('forge.inlineEdit', () => inlineEdit({ client, models, review, ready: ensureReady }).catch(e => vscode.window.showErrorMessage(`Forge: ${(e as Error).message}`))),
    vscode.commands.registerCommand('forge.cancel', () => { runner.cancel(); }),
    vscode.commands.registerCommand('forge.undoRun', async () => vscode.window.showInformationMessage(await review.undoRun())),
    vscode.commands.registerCommand('forge.undoLast', async () => vscode.window.showInformationMessage(await review.undoLast())),
    vscode.commands.registerCommand('forge.setup', async () => { ready = undefined; try { await ensureReady(); vscode.window.showInformationMessage('Forge: connected to TrueForge.'); } catch (e) { vscode.window.showErrorMessage((e as Error).message); } }),
    { dispose: () => void mcp?.close() });
  void ctx.ensure(); // warm the index in the background; the editor never blocks on it
}
export function deactivate() { /* disposables handle cleanup */ }
