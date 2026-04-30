# Pantheon — Project Context

Pantheon is a self-extending agentic OS. Agents communicate exclusively through MCP tools. No agent reads or writes files directly. All state lives in SQLite accessed via MCP.

## Architecture

- **MCP Server**: `@pantheon/mcp-server` (port 3100) — 24 tools, SQLite storage
- **Orchestrator**: `@pantheon/orchestrator` (port 3101) — agent runner, pipeline, queue processor
- **CLI**: `@pantheon/cli` — `pantheon` command, ink UI
- **Database**: `pantheon.db` at repo root (SQLite via better-sqlite3 + drizzle-orm)
- **Transport**: Streamable HTTP (MCP spec compliant)
- **Config**: `pantheon.yaml` at repo root

## Key Invariants

1. Agents never touch the filesystem directly — all file ops go through `file.*` MCP tools
2. Agents never hold state in context — all state lives in SQLite via MCP
3. Agent `.md` files live in top-level `agents/` only — never inside packages
4. Same domain = sequential (go-dev and go-reviewer can never run simultaneously)
5. Different domains = parallel (go-dev and sql-dev run simultaneously)
6. Reviewer always depends on its worker's specific queue ID
7. BTW agent has zero MCP tools — pure LLM call, no side effects
8. Token budget is checked before spawning expensive agents
9. Config file is `pantheon.yaml` — not config.yaml, not .env
10. All package names are `@pantheon/*`

## Build Phases

- **Phase 1**: MCP Server + Storage (current)
- **Phase 2**: LiteLLM + Agent Runner
- **Phase 3**: Router + Understander
- **Phase 4**: Orchestrator + Single Domain Pipeline
- **Phase 5**: CLI with Live Status
- **Phase 6**: All Specialists + Parallel Execution
- **Phase 7**: Prometheus (agent creator)
- **Phase 8**: Web Dashboard (Next.js, future)
