import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';
import { getAnthropicClient } from '../llm/client.js';
import { getMcpClient } from '../mcp/client.js';
import { getConfig } from '../config.js';

const AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../agents');

async function findAgentPrompt(agentName: string): Promise<string> {
  for (const tier of ['router-tier', 'core-tier', 'specialist-tier']) {
    const fp = path.join(AGENTS_DIR, tier, `${agentName}.md`);
    try { return await fs.readFile(fp, 'utf-8'); } catch { /* next tier */ }
  }
  throw new Error(`Agent "${agentName}" not found`);
}

export interface StreamToken {
  type:  'token' | 'done' | 'error';
  text?: string;
  error?: string;
}

export async function* streamAgent(
  agentName: string,
  task:      string,
  projectId?: string,
): AsyncGenerator<StreamToken> {
  const systemPrompt = await findAgentPrompt(agentName);
  const model        = getConfig().ai.models.btw;
  const anthropic    = getAnthropicClient();
  const mcp          = await getMcpClient();

  const { tools: mcpTools } = await mcp.listTools();
  const tools: Tool[] = mcpTools.map(t => ({
    name:         t.name,
    description:  t.description ?? '',
    input_schema: (t.inputSchema ?? { type: 'object', properties: {} }) as Tool['input_schema'],
  }));

  const taskWithCtx = projectId ? `[projectId: ${projectId}]\n\n${task}` : task;

  try {
    const stream = anthropic.messages.stream({
      model,
      max_tokens: 4096,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: taskWithCtx }],
      tools,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'token', text: event.delta.text };
      }
    }

    yield { type: 'done' };
  } catch (err) {
    yield { type: 'error', error: String(err) };
  }
}
