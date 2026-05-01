import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMcpClient } from '../mcp/client.js';
import { getConfig } from '../config.js';
import { getProvider, resolveAgentModel } from '../llm/provider.js';
import { runCrossCheck } from './cross-check-runner.js';
import type { UnifiedTool } from '../llm/types.js';

// packages/orchestrator/dist/index.js → 3 levels up = repo root
const AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../agents');
const TIERS = ['router-tier', 'core-tier', 'specialist-tier'];

export async function findAgent(agentName: string): Promise<{ prompt: string; tier: string }> {
  for (const tier of TIERS) {
    const fp = path.join(AGENTS_DIR, tier, `${agentName}.md`);
    try {
      const prompt = await fs.readFile(fp, 'utf-8');
      return { prompt, tier };
    } catch { /* not in this tier */ }
  }
  throw new Error(`Agent "${agentName}" not found in any tier under ${AGENTS_DIR}`);
}

export interface RunAgentOpts {
  agentName:      string;
  task:           string;
  projectId?:     string;
  maxIterations?: number;
}

export interface RunAgentResult {
  output:        string;
  iterations:    number;
  toolCallCount: number;
}

export async function runAgent({
  agentName,
  task,
  projectId,
  maxIterations = 50,
}: RunAgentOpts): Promise<RunAgentResult> {
  const { prompt: systemPrompt, tier } = await findAgent(agentName);
  const config  = getConfig();
  const mcp     = await getMcpClient();

  const { tools: mcpTools } = await mcp.listTools();
  const tools: UnifiedTool[] = mcpTools.map(t => ({
    name:        t.name,
    description: t.description ?? '',
    inputSchema: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
  }));

  const taskWithCtx = projectId ? `[projectId: ${projectId}]\n\n${task}` : task;

  const callTool = async (name: string, input: Record<string, unknown>): Promise<string> => {
    try {
      const result = await mcp.callTool({ name, arguments: input });
      const block  = (result.content as Array<{ type: string; text?: string }>).find(b => b.type === 'text');
      return block?.text ?? '';
    } catch (err) {
      throw new Error(`Tool error (${name}): ${String(err)}`);
    }
  };

  // Resolve which provider+model to use (supports cross-check)
  const agentSpec = resolveAgentModel(agentName, tier, config);

  if (agentSpec.kind === 'cross-check') {
    return runCrossCheck({
      systemPrompt,
      task:      taskWithCtx,
      specs:     agentSpec.specs,
      config,
      projectId,
    });
  }

  const { provider: providerName, model } = agentSpec.spec;
  const provider = getProvider(providerName, config);

  return provider.runAgent({
    model,
    systemPrompt,
    task: taskWithCtx,
    tools,
    callTool,
    maxIterations,
  });
}
