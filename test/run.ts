import { ContextEngine } from '../src/context';
import { startMcp } from '../src/mcp';
import { Uri, ROOT } from './vscode-stub';
(async () => {
  const ctx = new ContextEngine(() => new Uri(ROOT) as never);
  let t = Date.now(); await ctx.ensure(); console.log('index', ctx.stats(), `${Date.now() - t}ms`);
  const q = 'add built-in CLI command flask config print application configuration as JSON mask SECRET PASSWORD TOKEN KEY test documented';
  const r = await ctx.retrieve(q, 6000);
  console.log(`used ${r.usedTokens}/${r.budgetTokens} tokens`);
  for (const h of r.hits) console.log(' ', h.chunk.path + ':' + h.chunk.startLine, h.chunk.symbol ?? '', h.score.toFixed(1), h.why.slice(0, 4).join(','));
  console.log('omitted:', r.omitted.slice(0, 5).map(h => h.chunk.path));
  console.log((await ctx.findSymbol('get_debug_flag')).split('\n').slice(0, 4).join('\n'));
  console.log((await ctx.expandMentions('fix @symbol:get_debug_flag and @src/flask/cli.py please', 3000)).mentions);
  // MCP over real HTTP, as TrueForge would call it
  const h = await startMcp({ ctx, budget: () => 6000, out: { appendLine() {}, append() {} } as never, approvals: new Map(), signal: () => undefined, onContext: () => {}, onTool: () => {} }, 0);
  const hdr = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${h.token}` };
  const no = await fetch(h.url, { method: 'POST', headers: { ...hdr, authorization: 'Bearer x' }, body: '{}' }); console.log('unauth ->', no.status);
  const list = await fetch(h.url, { method: 'POST', headers: hdr, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  console.log('tools:', ((await list.text()).match(/"name":"(\w+)"/g) ?? []).join(' '));
  const call = await fetch(h.url, { method: 'POST', headers: hdr, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'propose_edit', arguments: { path: 'src/flask/helpers.py', edits: [{ old_text: 'a', new_text: 'b' }] } } }) });
  console.log('unapproved propose_edit ->', (await call.text()).slice(0, 220).replace(/\n/g, ' '));
  await h.close();
})();
