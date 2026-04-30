import { orchestratorUrl, mcpUrl } from '../config.js';
import { get } from '../http.js';

export async function cmdStatus() {
  const results = await Promise.allSettled([
    get<{ status: string; tools: number }>(mcpUrl('/health')),
    get<{ status: string; workerRunning: boolean }>(orchestratorUrl('/health')),
  ]);

  const mcp   = results[0];
  const orch  = results[1];

  console.log('\nPantheon Status');
  console.log('─'.repeat(40));

  if (mcp.status === 'fulfilled') {
    console.log(`MCP Server   ✓  (${mcp.value.tools} tools)`);
  } else {
    console.log(`MCP Server   ✗  (not running — start with: pnpm start)`);
  }

  if (orch.status === 'fulfilled') {
    console.log(`Orchestrator ✓  (worker: ${orch.value.workerRunning ? 'running' : 'stopped'})`);
  } else {
    console.log(`Orchestrator ✗  (not running — start with: pnpm --filter @pantheon/orchestrator start)`);
  }

  console.log('');
}
