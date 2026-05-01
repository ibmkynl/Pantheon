# Pantheon

A self-extending agentic OS. Bring your own API key, describe what you want in plain language, and Pantheon routes your request through a pipeline of specialized agents — all coordinated through a custom MCP server that acts as the shared nervous system.

## The core idea

Every agent communicates exclusively through MCP tools. No agent reads or writes files directly. No agent holds state in memory. All state lives in SQLite, accessed through 32 MCP tools. This eliminates hallucinations from file path errors and dramatically reduces context usage — agents call `file.write()` instead of dumping code into their response.

```
User prompt → Understander → Classifier → Token-Estimator
                                              ↓
                                  Orchestrator (populates queue)
                                              ↓
                              Agent Queue (SQLite via MCP)
                                    ↙         ↘
                              go-dev        sql-dev     ← parallel
                                ↓               ↓
                           go-reviewer    sql-reviewer  ← sequential within domain
                                    ↘         ↙
                                  Final output
```

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 20+ |
| Language | TypeScript 5.x strict |
| Package manager | pnpm workspaces |
| Build | tsup |
| AI gateway | Anthropic SDK (BYOK) |
| MCP SDK | @modelcontextprotocol/sdk |
| MCP transport | Streamable HTTP |
| Validation | Zod |
| HTTP server | Fastify |
| Database | better-sqlite3 + drizzle-orm |
| Memory search | SQLite FTS5 |
| CLI | commander (Phase 2–4) → ink/React (Phase 5+) |

## Setup

### Prerequisites

- Node.js 20+
- pnpm 9+
- An Anthropic API key (or any LiteLLM-compatible provider)

### Install

```bash
git clone https://github.com/ibmkynl/Pantheon.git
cd Pantheon
pnpm install
pnpm build
```

### Configure

```bash
cp pantheon.yaml.example pantheon.yaml   # or edit pantheon.yaml directly
```

Edit `pantheon.yaml`:

```yaml
ai:
  provider: "anthropic"
  api_key: "sk-ant-..."          # your API key
  models:
    router:     "claude-haiku-4-5-20251001"   # cheap — router tier
    core:       "claude-sonnet-4-6"           # smart — orchestrator/planner/reviewer
    specialist: "claude-sonnet-4-6"           # smart — go-dev, sql-dev, etc.
    btw:        "claude-haiku-4-5-20251001"   # cheap — simple questions
```

### Start

**Terminal 1 — MCP server** (must start first):
```bash
pnpm start:mcp
# Listening on http://localhost:3100
# Verify: curl http://localhost:3100/health → {"status":"ok","tools":32}
```

**Terminal 2 — Orchestrator**:
```bash
pnpm start:orchestrator
# Listening on http://localhost:3101
```

**Terminal 3 — CLI**:
```bash
# Link the CLI globally (optional)
pnpm --filter @pantheon/cli link --global

# Or run directly:
node packages/cli/dist/index.js <command>
```

### Test it

```bash
# Check both servers
pantheon status

# Ask a simple question (routes to btw-agent)
pantheon run --yes "What is the difference between JWT and session cookies?"

# Run a full task (routes through orchestrator → specialists)
pantheon run --yes "Build a REST API with JWT auth in Go"

# Watch the queue live
pantheon queue --watch

# View logs
pantheon logs --project <project-id>
```

## CLI commands

```bash
pantheon run "build a REST API with JWT auth in Go"   # full pipeline
pantheon run "..." --yes                              # skip confirmation
pantheon run "..." --agent go-dev                     # specific agent
pantheon run "..." --project my-project               # named project

pantheon queue                                        # snapshot of queue
pantheon queue --watch                                # live auto-refresh
pantheon worker start                                 # start queue worker
pantheon worker stop                                  # stop queue worker

pantheon status                                       # MCP + orchestrator health
pantheon logs                                         # recent project logs
pantheon logs --follow                                # tail mode
pantheon logs --project <id>                          # filter by project

pantheon agents list                                  # list all agents by tier
pantheon validate                                     # health check — MCP + orchestrator
pantheon forge                                        # create a new agent (Phase 7)

pantheon budget set 200000                            # set token limit
pantheon budget status                                # usage report
```

## Project structure

```
pantheon/
├── pantheon.yaml              ← config: API keys, model choices, limits
├── pantheon.db                ← SQLite database (gitignored)
├── agents/                    ← agent system prompts (.md files)
│   ├── router-tier/           ← understander, classifier, token-estimator
│   ├── core-tier/             ← orchestrator, planner, reviewer, btw-agent, prometheus
│   └── specialist-tier/       ← go-dev, sql-dev, frontend-dev, flutter-dev, ...
└── packages/
    ├── mcp-server/            ← @pantheon/mcp-server  (port 3100)
    ├── orchestrator/          ← @pantheon/orchestrator (port 3101)
    ├── cli/                   ← @pantheon/cli → `pantheon` command
    └── web/                   ← @pantheon/web (Phase 8)
```

## MCP tools (32 total)

All agent state flows through these tools.

| Namespace | Tools |
|---|---|
| `memory.*` | save, search, get, list, delete — FTS5 full-text search |
| `file.*` | write, read, list, delete, exists — sandboxed per project |
| `todo.*` | add, list, update, complete, delete |
| `agent.*` | queue_add, queue_next, queue_start, queue_complete, queue_error, queue_status, emit_event |
| `project.*` | get_context, update, set_plan, get_plan, log, get_logs |
| `token.*` | check_budget, consume, get_usage, set_limit |

## Agent tiers

**Router tier** (cheap model — ~300 tokens, always runs first)
- `understander` — extracts structured intent from raw prompt
- `classifier` — simple / off-topic / task / research
- `token-estimator` — checks budget before spawning expensive agents

**Core tier** (smart model)
- `orchestrator` — decomposes task, builds dependency graph, populates queue
- `planner` — writes detailed execution plan to MCP
- `reviewer` — validates specialist output, scores 1-10, requests revision
- `btw-agent` — handles simple questions with a single LLM call
- `prometheus` — creates new agents from user description (`pantheon forge`)

**Specialist tier** (smart model, run in parallel across domains)
- `go-dev`, `go-reviewer`
- `sql-dev`, `sql-reviewer`
- `frontend-dev`, `frontend-reviewer`
- `flutter-dev`, `flutter-reviewer`
- `python-dev`, `python-reviewer`
- `rust-dev`, `rust-reviewer`
- `designer`, `researcher`
- _...any agent you create with `pantheon forge`_

## Adding your own agents

Every agent is a `.md` system prompt file. No TypeScript required.

```bash
# Interactive agent creator (Phase 7)
pantheon forge

# Or manually: create agents/specialist-tier/rust-dev.md
# The runner will pick it up automatically on the next run.
```

## Adding external MCP servers / plugins

In `pantheon.yaml`:

```yaml
plugins:
  - name: "browser"
    transport: "stdio"
    command: "npx @playwright/mcp"
  - name: "github"
    transport: "http"
    url: "http://localhost:3200/mcp"
```

## Build phases & development timeline

| Phase | Branch | Status | Description |
|---|---|---|---|
| 1 | `feat/phase-1` | ✅ Merged | MCP server — 32 tools, SQLite, SSE, Fastify |
| 2 | `phase/2-agent-runner` | ✅ Merged | Orchestrator + agent runner + basic CLI + all agent prompts |
| 3 | `phase/3-router` | ✅ Merged | Router tier: understander → classifier → token-estimator |
| 4 | `phase/4-pipeline` | ✅ Merged | Full pipeline: route → orchestrate → queue → run |
| 5 | `phase/5-ink-cli` | ✅ Merged | Ink/React CLI — live QueueView, LogsView, RunView |
| 6 | `phase/6-specialists-parallel` | ✅ Merged | Queue-manager agent, python/rust specialists, CI workflow |
| 7 | `phase/7-forge` | 🔜 Next | Prometheus agent creator (`pantheon forge`) |
| 8 | — | — | Web dashboard (Next.js + shadcn/ui) |

## Contribution & merge rules

- **One branch per phase.** Branches are named `phase/N-description`.
- **PRs only after the phase is complete.** No draft PRs mid-phase.
- **Review before merge.** Every PR is reviewed (self-review at minimum), issues fixed, and the PR re-pushed before merge.
- **Squash merge only.** `main` history stays clean: one commit per phase.
- **`main` is always deployable.** No broken builds on `main`.
- Branch protection: 1 required approving review, stale review dismissal, no force-push, no deletion.

## Key invariants

1. Agents never touch the filesystem directly — only via `file.*` MCP tools
2. Agents never hold state in context — all state lives in SQLite via MCP
3. Agent `.md` files live in `agents/` at repo root — never inside packages
4. Same domain = sequential. Different domains = parallel.
5. Token budget is checked before spawning expensive agents
6. `pantheon.yaml` is the only config file — not `.env`, not `config.yaml`

## License

Apache 2.0
