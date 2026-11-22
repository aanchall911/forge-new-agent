import { ContextEngine } from '../src/context'; import { Uri, ROOT } from './vscode-stub';
(async () => { const ctx = new ContextEngine(() => new Uri(ROOT) as never); await ctx.ensure();
  for (const q of ['full task: add built-in CLI command flask config print application configuration as JSON mask SECRET PASSWORD TOKEN KEY test documented',
    'click CLI command with_appcontext built-in commands routes shell run', 'CliRunner invoke test cli command output', 'docs command line interface built-in commands flask routes']) {
    const r = await ctx.retrieve(q, 3000); console.log('\nQ:', q.slice(0, 60)); console.log(' ', [...new Set(r.hits.map(h => h.chunk.path))].join('\n  ')); } })();
