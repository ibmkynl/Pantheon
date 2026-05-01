# Pantheon

Self-extending agentic OS. Install once, type what you want, AI handles planning, agent selection, execution, and testing.

```bash
npm install -g pantheon-cli
pantheon
```

That's it. On first run Pantheon prompts for your provider + API key, writes `~/.pantheon/pantheon.yaml`, spawns the MCP server and orchestrator in the background, and drops you into an interactive shell. No manual server processes, no choosing which agent to call.

---

## What it does

You describe what you want in plain language. Pantheon's router classifies the request, the orchestrator decomposes it into a queue of agent jobs, specialists run in parallel across non-overlapping domains, reviewers grade outputs, and the synthesizer combines results. State lives in SQLite, accessed by every agent through a custom MCP server.

```
User prompt
   ↓
Router tier        understander → classifier → token-estimator
   ↓
Orchestrator       decomposes the task, populates the queue
   ↓
Agent queue        SQLite via MCP — dependency graph, no race conditions
   ↓
Specialists       go-dev · python-dev · rust-dev · sql-dev · git-dev · …  (parallel where possible)
   ↓
Reviewers         per-domain grading and revision loop
   ↓
Synthesizer       merges multi-provider outputs (when cross-check is enabled)
   ↓
Final output
```

Every agent talks only through MCP tools. No agent reads or writes files directly. No agent holds state in memory.

---

## Install

```bash
npm install -g pantheon-cli
```

Requires Node.js 20+. Native deps (`better-sqlite3`) build automatically on install.

### Updating

```bash
npm update -g pantheon-cli
```

Your `~/.pantheon/pantheon.yaml` is preserved across updates.

---

## First run

```bash
pantheon
```

You'll see:

```
  Welcome to Pantheon
  ──────────────────

  Choose a provider:
    1) Anthropic   (Claude)
    2) OpenAI      (GPT)
    3) Google      (Gemini)
    4) Skip
```

Pick one, paste an API key, and the shell launches. Add more providers (or enable cross-check) by editing `~/.pantheon/pantheon.yaml` later.

---

## Configuration

Pantheon looks for `pantheon.yaml` in this order:

1. `$PANTHEON_CONFIG` (explicit env override)
2. `./pantheon.yaml` (project-local — overrides global for that directory)
3. `~/.pantheon/pantheon.yaml` (global, written by first-run setup)

Example:

```yaml
ai:
  default_provider: "anthropic"

  providers:
    anthropic:
      api_key: "sk-ant-..."
    # openai:
    #   api_key: "sk-openai-..."
    # google:
    #   api_key: "AIza..."

  models:
    router:     "claude-haiku-4-5-20251001"   # cheap — router tier
    core:       "claude-sonnet-4-6"           # smart — orchestrator/planner/reviewer
    specialist: "claude-opus-4-7"             # most capable — go-dev, sql-dev, git-dev, etc.
    btw:        "claude-haiku-4-5-20251001"   # cheap — simple Q&A

  # Per-agent overrides (optional)
  agent_models:
    go-dev:       "anthropic:claude-opus-4-7"
    python-dev:   "openai:gpt-4o"
    researcher:   "google:gemini-2.5-pro"

    # Cross-check: same task on two providers, synthesizer picks the best
    go-reviewer:  "cross-check:anthropic:claude-sonnet-4-6,openai:gpt-4o"
```

---

## Usage

```bash
pantheon                                    # interactive shell — just type
pantheon run "build a REST API in Go"       # one-shot pipeline
pantheon run "what is JWT?"                 # routes to btw-agent (fast Q&A)
pantheon queue --watch                      # live queue view
pantheon logs --follow                      # live log tail
pantheon agents list                        # show all agents by tier
pantheon forge                              # create a new agent (Prometheus)
pantheon validate                           # health check MCP + orchestrator
pantheon budget set 200000                  # cap token usage per session
```

Inside the interactive shell, slash commands stay available for power users (`/queue`, `/providers`, `/budget`, `/forge`, `/help`) but are never required — type your request in plain English and routing is automatic.

---

## Adding your own agents

Every agent is one Markdown file. Either:

```bash
pantheon forge        # interactive creator
```

Or drop a file into `agents/specialist-tier/<name>.md`. The runner picks it up on the next invocation. No TypeScript needed.

---

## What ships

| Layer | Choice |
|---|---|
| Runtime | Node.js 20+ |
| Language | TypeScript 5.x strict |
| Package manager | pnpm workspaces |
| AI providers | Anthropic, OpenAI, Google Gemini, LiteLLM (any OpenAI-compatible) |
| MCP transport | Streamable HTTP |
| HTTP server | Fastify |
| Database | better-sqlite3 + drizzle-orm |
| CLI | ink/React full-screen REPL |
| Build | tsup |
| Validation | Zod |

Three Node processes run when `pantheon` starts: MCP server (port 3100), orchestrator (port 3101), CLI (foreground). The CLI auto-spawns the other two if they aren't already running. Kill the CLI and the children exit with it.

---

## MCP tools (42 total)

Every agent's only interface to the outside world.

| Namespace | Tools |
|---|---|
| `memory.*` | save, search, get, list, delete (FTS5 search) |
| `file.*` | write, read, list, delete, exists (sandboxed per project) |
| `todo.*` | add, list, update, complete, delete |
| `agent.*` | queue_add, queue_next, queue_start, queue_complete, queue_error, queue_status, queue_reorder, emit_event, create_agent |
| `project.*` | get_context, update, set_plan, get_plan, log, get_logs |
| `token.*` | check_budget, consume, get_usage, set_limit |
| `git.*`    | status, diff, log, branch, checkout, add, commit, push, pull, current_branch, show |

---

## Agent tiers

**Router tier** (cheap model — always runs first)
- `understander`, `classifier`, `token-estimator`

**Core tier** (smart model)
- `orchestrator` — decomposes task, builds dependency graph, populates queue
- `planner` — writes detailed execution plan
- `reviewer` — validates specialist output, scores 1-10, requests revision
- `btw-agent` — handles simple questions with a single LLM call (streamed)
- `prometheus` — creates new agents on demand
- `queue-manager` — topologically sorts the queue for max parallelism
- `synthesizer` — merges multi-provider outputs in cross-check mode

**Specialist tier** (most capable model — runs in parallel across domains)
- `go-dev`, `go-reviewer`
- `python-dev`, `python-reviewer`
- `rust-dev`, `rust-reviewer`
- `sql-dev`, `sql-reviewer`
- `frontend-dev`, `frontend-reviewer`
- `flutter-dev`, `flutter-reviewer`
- `git-dev` — branch / commit / push / diff / log
- `designer`, `researcher`
- _…plus anything you create with `pantheon forge`_

---

## File locations

```
~/.pantheon/
├── pantheon.yaml         # config (created by first-run setup)
├── data/
│   └── pantheon.db       # SQLite — all agent state lives here
└── workspaces/
    └── <project-id>/
        └── files/        # sandboxed file.* writes
```

Override any path with env vars: `PANTHEON_HOME`, `PANTHEON_CONFIG`, `PANTHEON_DB_PATH`, `PANTHEON_WORKSPACES`, `PANTHEON_AGENTS_DIR`.

---

## External MCP plugins

Add any third-party MCP server in `pantheon.yaml`:

```yaml
plugins:
  - name: "browser"
    transport: "stdio"
    command: "npx @playwright/mcp"
  - name: "github"
    transport: "http"
    url: "http://localhost:3200/mcp"
```

---

## Development from source

```bash
git clone https://github.com/ibmkynl/Pantheon.git
cd Pantheon
pnpm install
pnpm build
node packages/cli/dist/index.js     # or: pnpm --filter @pantheon/cli link --global
```

---

## Build phases

| Phase | Description | Status |
|---|---|---|
| 1 | MCP server: 32 tools, SQLite, SSE, Fastify | ✅ |
| 2 | Orchestrator + agent runner + basic CLI + agent prompts | ✅ |
| 3 | Router tier (understander → classifier → token-estimator) | ✅ |
| 4 | Full pipeline: route → orchestrate → queue → run | ✅ |
| 5 | Ink/React CLI — live QueueView, LogsView, RunView | ✅ |
| 6 | Queue-manager agent, python/rust specialists, CI workflow | ✅ |
| 7 | Prometheus agent creator (`pantheon forge`) | ✅ |
| 8 | Full terminal UI shell — interactive REPL, streaming | ✅ |
| 9 | Multi-provider support + cross-check mode | ✅ |
| 10 | Single-line install + auto-orchestration + git agent + zero-config UX | ✅ |
| 11 | Codebase mapper (`code.*` MCP namespace, tree-sitter index) | 🔜 |

---

## Key invariants

1. Agents never touch the filesystem directly — only via `file.*` MCP tools
2. Agents never hold state in context — all state lives in SQLite via MCP
3. Agent prompts live in `agents/` — never inside packages
4. Same domain = sequential, different domains = parallel
5. Token budget is checked before spawning expensive agents
6. `pantheon.yaml` is the only config file — not `.env`, not `config.yaml`
7. Slash commands are optional — natural language is the primary interface

---

## License

Apache 2.0
