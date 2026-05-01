import type { ModelSpec, UnifiedTool } from '../llm/types.js';
import type { Config } from '../config.js';
import { getProvider } from '../llm/provider.js';
import { getMcpClient } from '../mcp/client.js';
import { runAgent } from './agent-runner.js';

interface ProviderOutput {
  provider:      string;
  model:         string;
  output:        string;
  iterations:    number;
  toolCallCount: number;
  error?:        string;
}

async function callMcpTool(name: string, input: Record<string, unknown>): Promise<string> {
  const mcp    = await getMcpClient();
  const result = await mcp.callTool({ name, arguments: input });
  const block  = (result.content as Array<{ type: string; text?: string }>).find(b => b.type === 'text');
  return block?.text ?? '';
}

async function getMcpTools(): Promise<UnifiedTool[]> {
  const mcp = await getMcpClient();
  const { tools } = await mcp.listTools();
  return tools.map(t => ({
    name:        t.name,
    description: t.description ?? '',
    inputSchema: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
  }));
}

export async function runCrossCheck({
  systemPrompt,
  task,
  specs,
  config,
  projectId,
}: {
  systemPrompt: string;
  task:         string;
  specs:        ModelSpec[];
  config:       Config;
  projectId?:   string;
}): Promise<{ output: string; iterations: number; toolCallCount: number }> {
  const tools = await getMcpTools();
  const taskWithCtx = projectId ? `[projectId: ${projectId}]\n\n${task}` : task;

  // Run all providers in parallel
  const results = await Promise.allSettled(
    specs.map(async (spec): Promise<ProviderOutput> => {
      try {
        const provider = getProvider(spec.provider, config);
        const result   = await provider.runAgent({
          model:        spec.model,
          systemPrompt,
          task:         taskWithCtx,
          tools,
          callTool:     callMcpTool,
        });
        return {
          provider:      spec.provider,
          model:         spec.model,
          output:        result.output,
          iterations:    result.iterations,
          toolCallCount: result.toolCallCount,
        };
      } catch (err) {
        return { provider: spec.provider, model: spec.model, output: '', iterations: 0, toolCallCount: 0, error: String(err) };
      }
    })
  );

  const outputs: ProviderOutput[] = results.map(r =>
    r.status === 'fulfilled'
      ? r.value
      : { provider: 'unknown', model: 'unknown', output: '', iterations: 0, toolCallCount: 0, error: String(r.reason) }
  );

  const successful = outputs.filter(o => !o.error && o.output);
  const totalIterations    = outputs.reduce((sum, o) => sum + o.iterations, 0);
  const totalToolCallCount = outputs.reduce((sum, o) => sum + o.toolCallCount, 0);

  if (successful.length === 0) {
    const errors = outputs.map(o => `${o.provider}:${o.model} — ${o.error}`).join('\n');
    throw new Error(`All cross-check providers failed:\n${errors}`);
  }

  if (successful.length === 1) {
    const only = successful[0]!;
    return { output: only.output, iterations: totalIterations, toolCallCount: totalToolCallCount };
  }

  // Synthesize results across providers
  const synthTask = [
    'You received outputs from multiple AI providers for the same task. Synthesize the best answer.',
    '',
    `Original task: ${task}`,
    '',
    ...outputs.map((o, i) =>
      o.error
        ? `## Provider ${i + 1}: ${o.provider}:${o.model} (FAILED)\nError: ${o.error}`
        : `## Provider ${i + 1}: ${o.provider}:${o.model}\n${o.output}`
    ),
  ].join('\n');

  const synthResult = await runAgent({
    agentName: 'synthesizer',
    task:      synthTask,
    projectId,
  });

  return {
    output:        synthResult.output,
    iterations:    totalIterations + synthResult.iterations,
    toolCallCount: totalToolCallCount + synthResult.toolCallCount,
  };
}
