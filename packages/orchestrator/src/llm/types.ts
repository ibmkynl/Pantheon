// Unified LLM types shared across all provider implementations

export interface UnifiedTool {
  name:        string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RunAgentResult {
  output:        string;
  iterations:    number;
  toolCallCount: number;
}

export interface ProviderRunOpts {
  model:         string;
  systemPrompt:  string;
  task:          string;
  tools:         UnifiedTool[];
  callTool:      (name: string, input: Record<string, unknown>) => Promise<string>;
  maxIterations?: number;
}

export interface LLMProvider {
  runAgent(opts: ProviderRunOpts): Promise<RunAgentResult>;
}

// Parsed model spec: "provider:model" or just "model"
export interface ModelSpec {
  provider: string;       // e.g. "anthropic"
  model:    string;       // e.g. "claude-sonnet-4-6"
}

// Cross-check spec: multiple provider:model pairs
export interface CrossCheckSpec {
  targets: ModelSpec[];
}

export type AgentModelSpec =
  | { kind: 'single';     spec: ModelSpec }
  | { kind: 'cross-check'; specs: ModelSpec[] };
