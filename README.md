# Forge Agent — a VS Code coding agent whose loop runs on TrueForge

**Starting point:** built from scratch — no upstream fork, no upstream loop. Editor plumbing (diff view, CodeLens, webview) is plain VS Code API.

## Quick start

```bash
# 1. Clone the pinned repository for testing
git clone https://github.com/pallets/flask.git --branch 3.1.3 /tmp/flask   # or set WS env var

# 2. Start TrueForge in local mode (configure a model at http://localhost:8790)
npx @truefoundry/trueforge@latest

# 3. Install and build the extension
npm install && npm run build

# 4. Press F5 in VS Code (Run Extension), open a folder, then run "Forge: Connect to TrueForge"
```

## Model configuration

Copy `config.example.json` and configure your model in TrueForge at `http://localhost:8790/settings/models`.  
The extension reads `forge.models` (an ordered list of TrueForge model FQNs) from VS Code settings.  
**Never commit API keys** — use `config.example.json` as a template only.

To switch models: open VS Code settings → search `forge.models` → edit the list.  
Fallback is automatic: if the first model fails, the extension retries with backoff then moves to the next.

## How it maps to the five capabilities

| Capability | Where |
|---|---|
| Inline edit (`Ctrl/Cmd+Alt+K`) | `src/inline.ts` → TrueForge session (no tools) → per-hunk review |
| Agent mode (panel) | `src/agent.ts` + `agent/forge-agent.json`; agent discovers files itself via MCP tools |
| Context assembly | `src/context.ts`: BM25 over symbol-aligned chunks + path/symbol boosts + import-graph/test-pairing boosts, packed under a token budget; `@file:` / `@symbol:` mentions |
| Diff review | `src/review.ts` + `src/hunks.ts`: diff editor, CodeLens keep/reject per hunk, undo (`Forge: Undo All Changes From Last Run`) |
| Streaming + cancel | `model.message.delta` events → panel; `Ctrl/Cmd+Alt+C` aborts the stream and calls `sessions.cancel` |

## Architecture on TrueForge

The extension is a **client**: it creates sessions, sends turns and renders events through `@truefoundry/trueforge-sdk`. It never calls a model provider directly.

Editor capabilities are exposed to the agent as **MCP tools** from a localhost-only HTTP server (`src/mcp.ts`, bearer-token auth), registered in TrueForge via `PUT /api/v1/settings/mcp-servers` on connect:

- **Read-only:** `retrieve_context`, `find_symbol`, `search_code`, `read_file`, `list_files`
- **Gated (require approval):** `propose_edit`, `propose_new_file`, `run_command`

**TrueForge tool approval drives the review:** gated tools are listed in `requireApprovalForTools`. The turn pauses (`turn.update` → `paused`), the extension opens the hunk review (or a command confirmation), writes only what the user kept, then resumes the same turn with `user.tool_approval` via `createTurnEvents` (TrueForge ≥ 0.185 pause/resume model). A tool call not approved through review cannot write — the MCP handler refuses it.

**Harness features used:** tool approval, deferred tool loading (`preloadTools` keeps three tools loaded, rest discovered on demand), subagents (instructed for broad exploration), compaction (60k-token trigger), `ask_user_question`.

## Context assembly

`src/context.ts` builds a BM25 index over symbol-aligned chunks (≤ 60 lines each, split at function/class boundaries). Retrieval pipeline:

1. Tokenize query (camelCase split, stopword filter)
2. BM25 score all chunks against query tokens
3. Second pass: boost chunks that import or are imported by top-5 files (+15%), boost test files paired with top hits (+25%)
4. Greedy pack under token budget (default 6000 tokens, max 2 chunks per file)
5. Return hits (with file, line range, matched tokens, score) + omitted list for transparency

`@file:path` and `@symbol:name` mentions are resolved before retrieval and counted against the same budget.

## Resilience

On any model error: retry once with exponential backoff (1s, 2s), skip retries on auth errors (401/403), then fall back to the next model in `forge.models` automatically with no user action required. If all models fail, one clear error message is shown and **no files have been changed** (nothing is written before user review).

## Tests

```bash
npm run typecheck && npm test
```

Tests cover hunk merge: accept-all / reject-all / partial / edge cases (insertion at top, deletion at EOF, no trailing newline).  
Set `WS` env var to point at your flask clone: `WS=/path/to/flask npm test`

## Agent definition

`agent/forge-agent.json` — sent as an inline spec to TrueForge on each session. The model is substituted from `forge.models` at runtime.

## Known limitations

- Not yet exercised end-to-end against a live model in the VS Code UI — verify Task A (inline edit) first, then Task B (agent mode, three-file change), then Task C (resilience with bad credentials).
- `list_files` throws if no workspace folder is open (TrueForge sees the error text and the agent recovers).
- Inline edit has no retrieval step — only the selected region + 40 lines of surrounding context are sent.
