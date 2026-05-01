import type { LLMProvider, ProviderRunOpts, RunAgentResult } from './types.js';

export function createGoogleProvider(apiKey: string): LLMProvider {
  return {
    async runAgent({
      model,
      systemPrompt,
      task,
      tools: unifiedTools,
      callTool,
      maxIterations = 50,
    }: ProviderRunOpts): Promise<RunAgentResult> {
      // Lazy-load Google GenAI SDK
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let GoogleGenAI: any;
      try {
        const pkgId = '@google/genai';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mod = await import(pkgId) as any;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        GoogleGenAI = mod.GoogleGenAI;
      } catch {
        throw new Error('@google/genai SDK not installed. Run: pnpm add @google/genai --filter @pantheon/orchestrator');
      }

      const genai = new GoogleGenAI({ apiKey });

      const functionDeclarations = unifiedTools.map(t => ({
        name:        t.name,
        description: t.description,
        parameters:  t.inputSchema,
      }));

      const toolConfig = functionDeclarations.length > 0
        ? [{ functionDeclarations }]
        : undefined;

      type GContent = { role: string; parts: Array<{ text?: string; functionCall?: unknown; functionResponse?: { name: string; response: { result: string } } }> };
      const contents: GContent[] = [{ role: 'user', parts: [{ text: task }] }];

      let iterations    = 0;
      let toolCallCount = 0;

      while (iterations < maxIterations) {
        iterations++;
        const response = await genai.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: systemPrompt,
            tools: toolConfig,
          },
        });

        const candidate = response.candidates?.[0];
        if (!candidate) break;

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const parts = candidate.content?.parts ?? [];
        contents.push({ role: 'model', parts });

        const partsArr: unknown[] = Array.isArray(parts) ? parts : [];
        const textParts  = partsArr.filter((p): p is { text: string } => typeof (p as { text?: string }).text === 'string');
        const fnCallParts = partsArr.filter((p): p is { functionCall: { name: string; args: Record<string, unknown> } } => !!(p as { functionCall?: unknown }).functionCall);

        if (fnCallParts.length === 0) {
          const output = textParts.map(p => p.text).join('').trim();
          return { output, iterations, toolCallCount };
        }

        // Handle function calls
        const fnResults: GContent['parts'] = [];
        for (const part of fnCallParts) {
          const fc = part.functionCall;
          toolCallCount++;
          try {
            const result = await callTool(fc.name, fc.args ?? {});
            fnResults.push({ functionResponse: { name: fc.name, response: { result } } });
          } catch (err) {
            fnResults.push({ functionResponse: { name: fc.name, response: { result: `Error: ${String(err)}` } } });
          }
        }
        contents.push({ role: 'user', parts: fnResults });
      }

      const lastModel = contents.findLast((c: GContent) => c.role === 'model');
      const output = (lastModel?.parts ?? [])
        .filter((p: unknown): p is { text: string } => typeof (p as { text?: string }).text === 'string')
        .map(p => p.text).join('').trim();
      return { output, iterations, toolCallCount };
    },
  };
}
