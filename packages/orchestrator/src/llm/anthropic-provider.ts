import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages.js';
import type { LLMProvider, ProviderRunOpts, RunAgentResult } from './types.js';

export function createAnthropicProvider(apiKey: string, baseUrl?: string): LLMProvider {
  const client = new Anthropic({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });

  return {
    async runAgent({
      model,
      systemPrompt,
      task,
      tools: unifiedTools,
      callTool,
      maxIterations = 50,
    }: ProviderRunOpts): Promise<RunAgentResult> {
      const tools: Tool[] = unifiedTools.map(t => ({
        name:         t.name,
        description:  t.description,
        input_schema: t.inputSchema as Tool['input_schema'],
      }));

      const messages: MessageParam[] = [{ role: 'user', content: task }];
      let iterations    = 0;
      let toolCallCount = 0;

      while (iterations < maxIterations) {
        iterations++;
        const response = await client.messages.create({
          model,
          max_tokens: 8192,
          system:     systemPrompt,
          messages,
          tools,
        });

        messages.push({ role: 'assistant', content: response.content });

        if (response.stop_reason === 'end_turn') {
          const output = response.content
            .filter(b => b.type === 'text')
            .map(b => (b as { type: 'text'; text: string }).text)
            .join('\n')
            .trim();
          return { output, iterations, toolCallCount };
        }

        if (response.stop_reason === 'tool_use') {
          const toolUseBlocks = response.content.filter(b => b.type === 'tool_use') as Array<
            { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
          >;

          const toolResults = await Promise.all(
            toolUseBlocks.map(async block => {
              toolCallCount++;
              try {
                const text = await callTool(block.name, block.input);
                return { type: 'tool_result' as const, tool_use_id: block.id, content: [{ type: 'text' as const, text }] };
              } catch (err) {
                return { type: 'tool_result' as const, tool_use_id: block.id, content: [{ type: 'text' as const, text: `Error: ${String(err)}` }], is_error: true };
              }
            })
          );

          messages.push({ role: 'user', content: toolResults });
          continue;
        }

        break;
      }

      const lastAssistant = messages.findLast((m: MessageParam) => m.role === 'assistant');
      const output = Array.isArray(lastAssistant?.content)
        ? (lastAssistant.content as Array<{ type: string; text?: string }>)
            .filter(b => b.type === 'text').map(b => b.text ?? '').join('\n').trim()
        : '';
      return { output, iterations, toolCallCount };
    },
  };
}
