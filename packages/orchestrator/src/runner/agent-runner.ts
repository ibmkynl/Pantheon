import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MessageParam, Tool, ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages.js';
import { getAnthropicClient } from '../llm/client.js';
import { getMcpClient } from '../mcp/client.js';
import { getConfig } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/index.js → 4 levels up to repo root
const AGENTS_DIR = path.resolve(__dirname, '../../../../agents');
const TIERS = ['router-tier', 'core-tier', 'specialist-tier'];

async function findAgent(agentName: string): Promise<{ prompt: string; tier: string }> {
  for (const tier of TIERS) {
    const fp = path.join(AGENTS_DIR, tier, `${agentName}.md`);
    try {
      const prompt = await fs.readFile(fp, 'utf-8');
      return { prompt, tier };
    } catch { /* not in this tier */ }
  }
  throw new Error(`Agent "${agentName}" not found in any tier under ${AGENTS_DIR}`);
}

function modelForTier(agentName: string, tier: string): string {
  const { models } = getConfig().ai;
  if (tier === 'router-tier')  return models.router;
  if (agentName === 'btw-agent') return models.btw;
  if (tier === 'core-tier')    return models.core;
  return models.specialist;
}

export interface RunAgentOpts {
  agentName:     string;
  task:          string;
  projectId?:    string;
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
  const model     = modelForTier(agentName, tier);
  const anthropic = getAnthropicClient();
  const mcp       = await getMcpClient();

  const { tools: mcpTools } = await mcp.listTools();
  const tools: Tool[] = mcpTools.map(t => ({
    name:         t.name,
    description:  t.description ?? '',
    input_schema: (t.inputSchema ?? { type: 'object', properties: {} }) as Tool['input_schema'],
  }));

  // Inject projectId into task context so agents always know their project scope
  const taskWithCtx = projectId
    ? `[projectId: ${projectId}]\n\n${task}`
    : task;

  const messages: MessageParam[] = [{ role: 'user', content: taskWithCtx }];
  let iterations    = 0;
  let toolCallCount = 0;

  while (iterations < maxIterations) {
    iterations++;

    const response = await anthropic.messages.create({
      model,
      max_tokens: 8192,
      system:     systemPrompt,
      messages,
      tools,
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      const output = response.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text)
        .join('\n')
        .trim();
      return { output, iterations, toolCallCount };
    }

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(
        (b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } =>
          b.type === 'tool_use'
      );

      const toolResults: ToolResultBlockParam[] = await Promise.all(
        toolUseBlocks.map(async block => {
          toolCallCount++;
          try {
            const result = await mcp.callTool({ name: block.name, arguments: block.input });
            return {
              type:        'tool_result' as const,
              tool_use_id: block.id,
              content:     result.content as Array<{ type: 'text'; text: string }>,
            };
          } catch (err) {
            return {
              type:        'tool_result' as const,
              tool_use_id: block.id,
              content:     [{ type: 'text' as const, text: `Tool error: ${String(err)}` }],
              is_error:    true,
            };
          }
        })
      );

      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // max_tokens or other stop — collect whatever text we have and break
    break;
  }

  const lastMsg = messages.findLast(m => m.role === 'assistant');
  const output  = Array.isArray(lastMsg?.content)
    ? lastMsg.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text)
        .join('\n')
        .trim()
    : '';
  return { output, iterations, toolCallCount };
}
