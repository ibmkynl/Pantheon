import type { LLMProvider, ProviderRunOpts, RunAgentResult } from './types.js';

export function createOpenAIProvider(apiKey: string, baseUrl?: string): LLMProvider {
  return {
    async runAgent({
      model,
      systemPrompt,
      task,
      tools: unifiedTools,
      callTool,
      maxIterations = 50,
    }: ProviderRunOpts): Promise<RunAgentResult> {
      // Lazy-load the openai package — not required if user doesn't configure OpenAI
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let OpenAI: any;
      try {
        const pkgId = 'openai';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mod = await import(pkgId) as any;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        OpenAI = mod.default ?? mod;
      } catch {
        throw new Error('OpenAI SDK not installed. Run: pnpm add openai --filter @pantheon/orchestrator');
      }

      const client = new OpenAI({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });

      const functions = unifiedTools.map(t => ({
        type: 'function' as const,
        function: {
          name:        t.name,
          description: t.description,
          parameters:  t.inputSchema,
        },
      }));

      type OAIMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string; tool_calls?: unknown[] };
      const messages: OAIMessage[] = [
        { role: 'system',    content: systemPrompt },
        { role: 'user',      content: task },
      ];

      let iterations    = 0;
      let toolCallCount = 0;

      while (iterations < maxIterations) {
        iterations++;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        const response = await client.chat.completions.create({
          model,
          messages,
          tools: functions.length > 0 ? functions : undefined,
        });

        const choice = response.choices[0];
        if (!choice) break;

        const assistantMsg = choice.message;
        messages.push({
          role:       'assistant',
          content:    assistantMsg.content ?? '',
          tool_calls: assistantMsg.tool_calls as unknown[],
        });

        if (choice.finish_reason === 'stop' || !assistantMsg.tool_calls?.length) {
          return { output: assistantMsg.content ?? '', iterations, toolCallCount };
        }

        if (choice.finish_reason === 'tool_calls' && assistantMsg.tool_calls?.length) {
          for (const tc of assistantMsg.tool_calls) {
            const call = tc as { id: string; function: { name: string; arguments: string } };
            toolCallCount++;
            try {
              const input = JSON.parse(call.function.arguments) as Record<string, unknown>;
              const text  = await callTool(call.function.name, input);
              messages.push({ role: 'tool', content: text, tool_call_id: call.id });
            } catch (err) {
              messages.push({ role: 'tool', content: `Error: ${String(err)}`, tool_call_id: call.id });
            }
          }
          continue;
        }

        break;
      }

      const last = messages.findLast((m: OAIMessage) => m.role === 'assistant');
      return { output: last?.content ?? '', iterations, toolCallCount };
    },
  };
}
