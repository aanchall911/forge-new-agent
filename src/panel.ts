import * as vscode from 'vscode';
import { Ui } from './agent';

export class AgentPanel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView; private queue: unknown[] = [];
  onSend: (text: string) => void = () => undefined;
  onNew: () => void = () => undefined;
  constructor(private ext: vscode.ExtensionContext) {}
  post(m: unknown) { if (this.view) void this.view.webview.postMessage(m); else this.queue.push(m); }
  ui(): Ui {
    return {
      delta: t => this.post({ type: 'delta', t }), tool: (name, summary, state) => this.post({ type: 'tool', name, summary, state }),
      context: info => this.post({ type: 'context', mentions: info.mentions, r: info.retrieval && { used: info.retrieval.usedTokens, budget: info.retrieval.budgetTokens, files: info.retrieval.filesIndexed, query: info.retrieval.query,
        hits: info.retrieval.hits.map(h => ({ loc: `${h.chunk.path}:${h.chunk.startLine}-${h.chunk.endLine}`, sym: h.chunk.symbol, why: [...new Set(h.why)].slice(0, 6), score: +h.score.toFixed(1) })),
        omitted: info.retrieval.omitted.map(h => `${h.chunk.path}:${h.chunk.startLine}`) } }),
      info: m => this.post({ type: 'info', m }), error: m => this.post({ type: 'error', m }), done: m => this.post({ type: 'done', m }),
    };
  }
  resolveWebviewView(v: vscode.WebviewView) {
    this.view = v; v.webview.options = { enableScripts: true };
    const nonce = Math.random().toString(36).slice(2);
    v.webview.html = html(nonce);
    v.webview.onDidReceiveMessage(m => {
      if (m.type === 'send') this.onSend(String(m.text));
      else if (m.type === 'new') this.onNew();
      else if (m.type === 'cancel') void vscode.commands.executeCommand('forge.cancel');
      else if (m.type === 'undo') void vscode.commands.executeCommand('forge.undoRun');
      else if (m.type === 'setup') void vscode.commands.executeCommand('forge.setup');
    });
    for (const q of this.queue.splice(0)) void v.webview.postMessage(q);
  }
}

const html = (n: string) => `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}'">
<style>body{font:13px var(--vscode-font-family);color:var(--vscode-foreground);padding:8px}#log{white-space:pre-wrap;margin-bottom:8px}
.t{opacity:.85;font-size:12px;margin:2px 0}.ok{color:var(--vscode-testing-iconPassed)}.denied{color:var(--vscode-errorForeground)}.err{color:var(--vscode-errorForeground)}.info{opacity:.7}
details{border:1px solid var(--vscode-panel-border);border-radius:4px;padding:4px 6px;margin:6px 0}textarea{width:100%;box-sizing:border-box;min-height:70px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border)}
button{margin:4px 4px 0 0;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:4px 10px;cursor:pointer}button.s{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}</style></head>
<body><div id="log"></div><textarea id="in" placeholder="Describe a task. Use @file:path or @symbol:name to attach context. Ctrl+Enter to send."></textarea>
<div><button id="go">Run</button><button id="stop" class="s">Cancel</button><button id="undo" class="s">Undo run</button><button id="nc" class="s">New chat</button><button id="setup" class="s">Connect</button></div>
<script nonce="${n}">const vs=acquireVsCodeApi(),log=document.getElementById('log'),inp=document.getElementById('in');let cur=null;
function add(cls,txt){const d=document.createElement('div');d.className=cls;d.textContent=txt;log.appendChild(d);cur=null;return d}
function send(){const t=inp.value.trim();if(!t)return;add('t','▶ '+t);inp.value='';vs.postMessage({type:'send',text:t})}
document.getElementById('go').onclick=send;document.getElementById('stop').onclick=()=>vs.postMessage({type:'cancel'});document.getElementById('undo').onclick=()=>vs.postMessage({type:'undo'});document.getElementById('nc').onclick=()=>{log.innerHTML='';vs.postMessage({type:'new'})};document.getElementById('setup').onclick=()=>vs.postMessage({type:'setup'});
inp.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey))send()});
window.addEventListener('message',e=>{const m=e.data;
if(m.type==='delta'){if(!cur){cur=document.createElement('div');log.appendChild(cur)}cur.textContent+=m.t}
else if(m.type==='tool'){add('t '+(m.state==='ok'?'ok':m.state==='denied'?'denied':''),(m.state==='run'?'⏳ ':m.state==='ok'?'✔ ':'✖ ')+m.name+' '+m.summary)}
else if(m.type==='context'){const d=document.createElement('details');d.open=true;const s=document.createElement('summary');
if(m.mentions){s.textContent='@-mentions attached: '+m.mentions.join(', ');d.append(s)}else{const r=m.r;s.textContent='Context: '+r.hits.length+' snippets · '+r.used+'/'+r.budget+' tokens · query "'+r.query+'"';
d.append(s);for(const h of r.hits){const p=document.createElement('div');p.className='t';p.textContent=h.loc+(h.sym?' ('+h.sym+')':'')+' — matched ['+h.why.join(', ')+'] score '+h.score;d.append(p)}
if(r.omitted.length){const p=document.createElement('div');p.className='t info';p.textContent='left out for budget: '+r.omitted.join(', ');d.append(p)}}
log.appendChild(d);cur=null}
else if(m.type==='info')add('info','ℹ '+m.m);else if(m.type==='error')add('err','⚠ '+m.m);else if(m.type==='done')add('ok','■ '+m.m)});</script></body></html>`;
