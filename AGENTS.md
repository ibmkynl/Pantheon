# Claude Code Instructions for Pantheon

Read `CONTEXT.md` fully before writing any code. Everything is decided there.

## Quick reference

- Project name: **Pantheon**
- CLI command: `pantheon`
- Config file: `pantheon.yaml`
- Database: `pantheon.db`
- All packages: `@pantheon/*`
- Agent prompts: top-level `agents/` directory ONLY

## Build order

Phase 1 → Phase 2 → ... → Phase 7. One phase at a time. Verify each phase works before starting the next.

## Hard rules

- Agents never access filesystem directly — only via `file.*` MCP tools
- Agent `.md` files live in `agents/` at repo root — never inside packages
- Same domain agents are always sequential in queue
- BTW agent has no MCP tools
- Check token budget before spawning expensive agents
- All TypeScript in strict mode

## MCP Server (Phase 1)

- POST /mcp — primary MCP endpoint (Streamable HTTP transport)
- GET /mcp — SSE stream for MCP protocol resumability
- DELETE /mcp — session termination
- GET /events — custom SSE stream for live UI updates
- GET /health — returns `{"status":"ok","tools":24}`
