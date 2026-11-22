import * as http from 'http';
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { ContextEngine, Retrieval } from './context';
import { Args, callKey, describeResult, readLines, runCommand, root } from './tools';
import { ReviewResult } from './review';

export interface McpDeps {
  ctx: ContextEngine; budget: () => number; out: vscode.OutputChannel;
  approvals: Map<string, ReviewResult | { command: true }>;
  signal: () => AbortSignal | undefined; onContext: (r: Retrieval) => void; onTool: (name: string, summary: string) => void;
}
export interface McpHandle { url: string; token: string; close(): Promise<void> }

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

function build(d: McpDeps): McpServer {
  const server = new McpServer({ name: 'forge-editor', version: '0.1.0' });
  // Loosely typed on purpose: the SDK's zod generics make tsc exhaust memory on this many tools.
  type Handler = (a: any) => Promise<{ content: { type: 'text'; text: string }[] }>;
  const reg = (server as any).tool.bind(server) as (...a: unknown[]) => void;
  const s = {
    tool: (name: string, desc: string, shape: unknown, a2: Handler | object, a3?: Handler) => a3 ? reg(name, desc, shape, a2, a3) : reg(name, desc, shape, a2),
  };
  const ro = { readOnlyHint: true };
  s.tool('retrieve_context', 'Budgeted semantic-ish retrieval over the whole workspace. Call FIRST with a keyword-rich task description. Returns snippets, the files chosen and why, and what was left out for budget.',
    { query: z.string(), budget_tokens: z.number().int().min(500).max(20000).optional() }, ro,
    async ({ query, budget_tokens }: any) => { const r = await d.ctx.retrieve(query, budget_tokens ?? d.budget()); d.onContext(r); return text(d.ctx.format(r)); });
  s.tool('find_symbol', 'Find a function/class/etc. by name (exact, prefix or substring) and return its definition.', { name: z.string() }, ro,
    async ({ name }: any) => { d.onTool('find_symbol', name); return text(await d.ctx.findSymbol(name)); });
  s.tool('search_code', 'Regex search across the workspace. Returns path:line: text.', { pattern: z.string(), glob: z.string().optional(), max_results: z.number().int().max(100).optional() }, ro,
    async ({ pattern, glob, max_results }: any) => { d.onTool('search_code', pattern); return text(await d.ctx.search(pattern, glob, max_results ?? 40)); });
  s.tool('read_file', 'Read a line range of a workspace file (max 400 lines per call).', { path: z.string(), start_line: z.number().int().optional(), end_line: z.number().int().optional() }, ro,
    async ({ path, start_line, end_line }: any) => { d.onTool('read_file', `${path}:${start_line ?? 1}-${end_line ?? ''}`); return text(await readLines(path, start_line, end_line)); });
  s.tool('list_files', 'List workspace files matching a glob (default src/**).', { glob: z.string().optional() }, ro, async ({ glob }: any) => {
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(root(), glob ?? '**/*'), '**/{node_modules,.git,.venv,__pycache__,dist}/**', 300);
    return text(files.map(f => vscode.workspace.asRelativePath(f, false)).sort().join('\n') || 'No files.');
  });
  const gated = async (tool: string, args: Args) => {
    const r = d.approvals.get(callKey(tool, args));
    return r ?? null;
  };
  s.tool('propose_edit', 'Propose edits to ONE existing file as exact-match replacements. The user reviews each hunk; nothing is written without approval.',
    { path: z.string(), edits: z.array(z.object({ old_text: z.string(), new_text: z.string() })).min(1) as z.ZodTypeAny, rationale: z.string().optional() },
    async (args: any) => { const r = await gated('propose_edit', args as Args); d.onTool('propose_edit', String(args.path)); return text(r && 'total' in r ? describeResult(r) : 'ERROR: this call was not approved through review; nothing was written.'); });
  s.tool('propose_new_file', 'Propose creating a new file. The user reviews it before it is written.', { path: z.string(), content: z.string(), rationale: z.string().optional() },
    async (args: any) => { const r = await gated('propose_new_file', args as Args); d.onTool('propose_new_file', String(args.path)); return text(r && 'total' in r ? describeResult(r) : 'ERROR: this call was not approved through review; nothing was written.'); });
  s.tool('run_command', 'Run a shell command in the workspace root (e.g. tests). Requires user approval.', { command: z.string(), timeout_s: z.number().int().min(1).max(600).optional() },
    async (args: any) => {
      const r = await gated('run_command', args as Args); d.onTool('run_command', args.command);
      if (!r) return text('ERROR: command was not approved; it was not run.');
      return text(await runCommand(args.command, args.timeout_s ?? 120, d.signal(), d.out));
    });
  return server;
}

export async function startMcp(d: McpDeps, port: number): Promise<McpHandle> {
  const token = randomBytes(24).toString('hex');
  const srv = http.createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
      if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const server = build(d); const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport); await transport.handleRequest(req, res, body);
    } catch (e) { if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: (e as Error).message }, id: null })); }
  });
  await new Promise<void>(r => srv.listen(port, '127.0.0.1', r));
  const addr = srv.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}/mcp`, token, close: () => new Promise(r => srv.close(() => r())) };
}
