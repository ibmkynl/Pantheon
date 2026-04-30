# Pantheon

A self-extending agentic OS. Bring your own API key, describe what you want in plain language, and Pantheon routes your request through a pipeline of specialized agents — all coordinated through a custom MCP server that acts as the shared nervous system.

## The core idea

Every agent communicates exclusively through MCP tools. No agent reads or writes files directly. No agent holds state in memory. All state lives in SQLite, accessed through 32 MCP tools. This eliminates hallucinations from file path errors and dramatically reduces context usage — agents call `file.write()` instead of dumping code into their response.

```
User prompt → Understander → Classifier → Orchestrator
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
| AI gateway | LiteLLM (BYOK — any provider) |
| MCP SDK | @modelcontextprotocol/sdk |
| MCP transport | Streamable HTTP |
| Validation | Zod |
| HTTP server | Fastify |
| Database | better-sqlite3 + drizzle-orm |
| Memory search | SQLite FTS5 |
| CLI | ink (React for terminals) |

## Getting started

```bash
# Clone and install
git clone https://github.com/ibmkynl/Pantheon.git
cd Pantheon
pnpm install

# Configure
cp pantheon.yaml.example pantheon.yaml
# Add your API key to pantheon.yaml

# Start the MCP server
pnpm start

# Verify
curl http://localhost:3100/health
# → {"status":"ok","tools":32}
```

## Project structure

```
pantheon/
├── pantheon.yaml          ← config: API keys, model choices, limits
├── pantheon.db            ← SQLite database (gitignored)
├── agents/                ← agent system prompts (.md files)
│   ├── router-tier/       ← understander, classifier, token-estimator
│   ├── core-tier/         ← orchestrator, planner, reviewer, prometheus
│   └── specialist-tier/   ← go-dev, sql-dev, flutter-dev, frontend-dev, ...
└── packages/
    ├── mcp-server/        ← @pantheon/mcp-server  (port 3100)
    ├── orchestrator/      ← @pantheon/orchestrator (port 3101)
    ├── cli/               ← @pantheon/cli → `pantheon` command
    └── web/               ← @pantheon/web (Phase 8, future)
```

## MCP tools (32 total)

All agent state flows through these tools. Agents never touch the filesystem directly.

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
- `btw-agent` — handles simple questions with a single LLM call, no MCP
- `prometheus` — creates new agents from user description (`pantheon forge`)

**Specialist tier** (smart model, run in parallel across domains)
- `go-dev`, `go-reviewer`
- `sql-dev`, `sql-reviewer`
- `flutter-dev`, `flutter-reviewer`
- `frontend-dev`, `frontend-reviewer`
- `designer`, `researcher`
- _...any agent you create with `pantheon forge`_

## Queue system

The agent queue is the heart of Pantheon. Same-domain agents are always sequential; different-domain agents run in parallel.

```
Position  Agent          Domain       DependsOn
0         planner        general      []
1         go-dev         go           [planner.id]
2         sql-dev        sql          [planner.id]     ← parallel with go-dev
3         go-reviewer    go-review    [go-dev.id]      ← waits for go-dev
4         sql-reviewer   sql-review   [sql-dev.id]     ← waits for sql-dev
```

Queue state persists in SQLite — process restart resumes where it left off.

## CLI

```bash
pantheon run "build a REST API with JWT auth in Go"   # run full pipeline
pantheon run "..." --yes                              # skip confirmation
pantheon forge                                        # create a new agent
pantheon agents list                                  # show all agents
pantheon queue                                        # live queue status
pantheon status                                       # project + token usage
pantheon logs                                         # tail live logs
pantheon budget set 200000                            # set token limit
```

## Adding your own agents

Every agent is a `.md` system prompt file. No TypeScript required.

```bash
# Interactive agent creator
pantheon forge

# Or manually: create agents/specialist-tier/rust-dev.md
# and add the domain to pantheon.yaml
```

Prometheus (the agent creator agent) will interview you, generate the system prompt, write the file, and register the domain — all automatically.

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

The orchestrator connects to each plugin at startup, discovers its tools, and makes them available to agents.

## Build phases

| Phase | Status | Description |
|---|---|---|
| 1 | ✅ Done | MCP server — 32 tools, SQLite, SSE, Fastify |
| 2 | 🔜 Next | LiteLLM + agent runner |
| 3 | — | Router + understander |
| 4 | — | Orchestrator + single-domain pipeline |
| 5 | — | CLI with live status (ink) |
| 6 | — | All specialists + parallel execution |
| 7 | — | Prometheus (agent creator) |
| 8 | — | Web dashboard (Next.js + shadcn/ui) |

## Key invariants

1. Agents never touch the filesystem directly — only via `file.*` MCP tools
2. Agents never hold state in context — all state lives in SQLite via MCP
3. Agent `.md` files live in `agents/` at repo root — never inside packages
4. Same domain = sequential. Different domains = parallel.
5. Token budget is checked before spawning expensive agents
6. `pantheon.yaml` is the only config file — not `.env`, not `config.yaml`

## License

Apache 2.0
