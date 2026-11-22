# Forge Agent — VS Code coding agent on TrueForge

**Team: Astracoders**

## 1. Team

| Name | Role | GitHub |
|---|---|---|
| *(your name)* | *(your role)* | *(your handle)* |

Team name: **Astracoders**  
College / employer: *(fill in)*

## 2. Starting point

Built **from scratch** — no upstream fork, no upstream agent loop.  
Editor plumbing (diff view, CodeLens, webview) uses plain VS Code API only.  
No upstream repository or commit to declare.

## 3. Architecture on TrueForge

The extension is a **client** of TrueForge. It never calls a model provider directly.

**Session flow:**
1. On "Forge: Connect to TrueForge", the extension starts a localhost MCP HTTP server (`src/mcp.ts`, bearer-token auth) and registers it in TrueForge via `PUT /api/v1/settings/mcp-servers`.
2. For each agent run, `AgentRunner` (`src/agent.ts`) calls `sessions.create` with an inline agent spec (`agent/forge-agent.json`, model substituted at runtime), then `sessions.createTurnStream` to stream events.
3. Streamed `model.message.delta` events are forwarded token-by-token to the webview panel.
4. When TrueForge pauses a turn for tool approval (`turn.update` → `paused`), the extension opens the hunk review UI, waits for the user's per-hunk decision, then resumes the same turn via `sessions.createTurnEvents` with `user.tool_approval`.

**MCP tools exposed to the agent:**

| Tool | Type | Description |
|---|---|---|
| `retrieve_context` | read-only | BM25 retrieval over the whole workspace, budgeted |
| `find_symbol` | read-only | Exact/prefix/substring symbol lookup |
| `search_code` | read-only | Regex search across workspace files |
| `read_file` | read-only | Line-range read (max 400 lines per call) |
| `list_files` | read-only | Glob file listing |
| `propose_edit` | **gated** | Exact-match replacement edits; requires user approval |
| `propose_new_file` | **gated** | New file creation; requires user approval |
| `run_command` | **gated** | Shell command in workspace root; requires user approval |

**Harness features used:**
- **Tool approval** (`requireApprovalForTools`): gated tools pause the turn; the extension drives the diff review, then resumes with `user.tool_approval`.
- **Deferred tool loading** (`preloadTools: ["retrieve_context", "read_file", "propose_edit"]`): three tools are always loaded; the rest are discovered on demand, keeping the context window smaller.
- **Subagents** (`dynamicSubAgents: true`): the agent is instructed to delegate broad file exploration to subagents so its own context stays small.
- **Compaction** (`compaction.trigger.value: 60000` input tokens): automatic context compaction on long runs.
- **`ask_user_question`** (`askUserQuestions: true`): the agent can ask clarifying questions via VS Code quick-pick / input box.

## 4. How context is selected

`src/context.ts` builds a BM25 index over symbol-aligned chunks (≤ 60 lines each, split at function/class boundaries). The index is built on extension activation and kept warm via a `FileSystemWatcher`.

**Retrieval pipeline:**
1. Tokenize query: camelCase split, stopword filter, deduplicate.
2. BM25 score all chunks (k1=1.5, b=0.75). Path tokens weighted ×3, symbol-name tokens ×5.
3. Downweight data/config files (`.json`, `.toml`, `static/`) by 0.6×.
4. Second pass — graph boosts around the top-5 files:
   - Chunks in files that import a top-5 file: ×1.15
   - Chunks in files imported by a top-5 file: ×1.15
   - Test files paired with a top-5 source file: ×1.25
5. Greedy pack under token budget (default 6000 tokens, max 2 chunks per file).
6. Return hits with file, line range, matched tokens, score + omitted list for transparency.

**Budget:** configurable via `forge.contextBudgetTokens` (default 6000). `@file:path` and `@symbol:name` mentions are resolved before retrieval and counted against the same budget.

The agent sees which files were chosen and why (matched tokens + score) in every `retrieve_context` response, making the selection visible in the TrueForge session.

## 5. Model setup

| Model | Where it ran | Approx. cost (Task B) | Notes |
|---|---|---|---|
| `anthropic/claude-sonnet-4-6` | Anthropic API via TrueForge | ~$0.05–0.15 | Primary |
| `openai/gpt-4o` | OpenAI API via TrueForge | ~$0.05–0.10 | Automatic fallback |

**How to switch models:** open VS Code Settings → search `forge.models` → edit the ordered list. The first model is primary; the rest are automatic fallbacks tried in order with exponential backoff (1s, 2s) before moving on. Auth errors (401/403) skip retries immediately.

**Never commit API keys.** Keys are entered in TrueForge at `http://localhost:8790/settings/models`. See `config.example.json` for the VS Code settings template.

## 6. Scorecard

| Criterion | Claim | Video timestamp |
|---|---|---|
| A1 Inline edit | Diff rendered with per-hunk accept/reject via CodeLens | 0:00 |
| A2 Agent mode | Discovers and edits ≥3 files unprompted (Task B) | 1:10 |
| A3 Streaming + cancellation | Tokens stream live; cancel leaves workspace consistent | 3:20 |
| B1 Context assembly | BM25 retrieval with token budget; files chosen + why shown in session | 1:10 |
| B2 Diff safety | Per-hunk review; undo via "Forge: Undo All Changes From Last Run" | 0:30 |
| B3 Resilience | Automatic fallback to second model; workspace unchanged on all-fail | 3:20 |
| B4 TrueForge integration | Tool approval drives review; deferred loading + subagents + compaction | 1:10 |
| C1 Video | All three tasks complete, legible, verified on screen | — |
| C2 Write-up | Architecture, context strategy, model setup, trade-offs, scorecard, limitations | — |

## 7. Tools used

- **Amazon Q Developer** (AI coding assistant) — used to scaffold and review extension code
- **TypeScript / esbuild** — build toolchain
- **TrueForge SDK** (`@truefoundry/trueforge-sdk`) — agent harness client
- **MCP SDK** (`@modelcontextprotocol/sdk`) — MCP server for editor tools
- **diff** (npm) — unified diff / hunk computation

## 8. Known limitations and what we'd do with another month

**Current limitations:**
- Inline edit has no retrieval step — only the selected region + 40 lines of surrounding context are sent. For cross-file inline edits this is insufficient.
- `list_files` throws if no workspace folder is open (TrueForge sees the error text and the agent recovers, but the UX is rough).
- The BM25 index is in-memory and rebuilt on each extension host restart; a large monorepo (>8000 files) will be slow to index.
- No streaming progress for the hunk review — the diff editor opens only after the full proposal is received.
- The webview panel is minimal HTML; no syntax highlighting in the context display.

**With another month:**
- Add a vector embedding index (e.g. local `all-MiniLM`) alongside BM25 for semantic retrieval, with a hybrid RRF merge.
- Stream proposed hunks into the diff editor as they arrive rather than waiting for the full proposal.
- Add a file-tree view showing which files the agent has read/modified in the current run.
- Persist the BM25 index to disk (SQLite) so restarts are instant.
- Contribute the deferred-tool-loading pattern back to TrueForge as a documented example.

---

## Quick start

```bash
# 1. Clone the pinned test repository
git clone https://github.com/pallets/flask.git --branch 3.1.3 /tmp/flask
# (or set WS=/path/to/flask for the test suite)

# 2. Start TrueForge in local mode, then configure a model at http://localhost:8790/settings/models
npx @truefoundry/trueforge@latest

# 3. Install dependencies and build the extension
npm install && npm run build

# 4. Press F5 in VS Code (launches the Extension Development Host)
#    Open the flask folder, then run "Forge: Connect to TrueForge" from the command palette.
```

## Model configuration

Copy `config.example.json` entries into your VS Code `settings.json` (or use the Settings UI).  
**Never commit API keys** — provider keys are entered in TrueForge at `http://localhost:8790/settings/models`.

```jsonc
// settings.json (excerpt)
{
  "forge.trueforge.baseUrl": "http://localhost:8790",
  "forge.models": ["anthropic/claude-sonnet-4-6", "openai/gpt-4o"],
  "forge.contextBudgetTokens": 6000
}
```

## Running tests

```bash
npm run typecheck && npm test
```

Tests cover hunk merge: accept-all / reject-all / partial / edge cases (insertion at top, deletion at EOF, no trailing newline).  
Set `WS` to point at your flask clone: `WS=/path/to/flask npm test`

## Capability map

| Capability | Keybinding | Source |
|---|---|---|
| Inline edit | `Ctrl/Cmd+Alt+K` (with selection) | `src/inline.ts` |
| Agent panel | Activity bar → Forge icon | `src/agent.ts` + `src/panel.ts` |
| Context assembly | automatic + `@file:` / `@symbol:` | `src/context.ts` |
| Diff review + undo | CodeLens in diff editor | `src/review.ts` + `src/hunks.ts` |
| Streaming + cancel | `Ctrl/Cmd+Alt+C` | `src/agent.ts` → `sessions.cancel` |
| MCP tools | localhost HTTP, bearer auth | `src/mcp.ts` |
| Agent definition | sent inline on each session | `agent/forge-agent.json` |
