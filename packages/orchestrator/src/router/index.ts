import { randomUUID } from 'node:crypto';
import { runAgent } from '../runner/agent-runner.js';
import { getMcpClient } from '../mcp/client.js';

export interface RouterInput {
  prompt:    string;
  projectId?: string;
}

export interface RouterOutput {
  projectId:      string;
  classification: string;
  routeTo:        string;
  understood:     UnderstanderResult;
  tokenDecision:  'approved' | 'blocked';
  estimatedTokens: number;
}

interface UnderstanderResult {
  intent:        string;
  type:          string;
  entities:      string[];
  constraints:   string[];
  output_format: string;
  tech_stack:    string[];
  ambiguities:   string[];
}

interface ClassifierResult {
  classification: string;
  route_to:       string;
  reason:         string;
}

interface TokenEstimatorResult {
  decision:         'approved' | 'blocked';
  estimated_tokens: number;
  remaining_tokens: number | null;
  reason:           string;
}

function readJson<T>(text: string | null | undefined, fallback: T): T {
  try { return JSON.parse(text ?? '') as T; }
  catch { return fallback; }
}

async function readMemory(key: string, projectId?: string): Promise<string | null> {
  const mcp = await getMcpClient();
  const res = await mcp.callTool({ name: 'memory.get', arguments: { key, projectId } });
  const text = (res.content as Array<{ type: string; text?: string }>)
    .find(c => c.type === 'text')?.text;
  return text === 'null' || !text ? null : text;
}

export async function runRouter(input: RouterInput): Promise<RouterOutput> {
  const projectId = input.projectId ?? `proj-${randomUUID().slice(0, 8)}`;

  // Step 1 — Understander
  await runAgent({
    agentName: 'understander',
    task:      input.prompt,
    projectId,
  });

  const understoodRaw = await readMemory('understander.result', projectId);
  const understood = readJson<UnderstanderResult>(understoodRaw, {
    intent: input.prompt, type: 'task', entities: [], constraints: [],
    output_format: 'files', tech_stack: [], ambiguities: [],
  });

  // Step 2 — Classifier
  await runAgent({
    agentName: 'classifier',
    task:      `Classify this request. The understander result is in memory under key "understander.result" for projectId "${projectId}".`,
    projectId,
  });

  const classifiedRaw = await readMemory('classifier.result', projectId);
  const classified = readJson<ClassifierResult>(classifiedRaw, {
    classification: 'task',
    route_to: 'orchestrator',
    reason: 'Default classification',
  });

  // Step 3 — Token estimator
  await runAgent({
    agentName: 'token-estimator',
    task:      `Estimate token budget for this request. Read "understander.result" and "classifier.result" from memory for projectId "${projectId}".`,
    projectId,
  });

  const estimatorRaw = await readMemory('token-estimator.result', projectId);
  const estimator = readJson<TokenEstimatorResult>(estimatorRaw, {
    decision: 'approved', estimated_tokens: 10000, remaining_tokens: null, reason: 'Default',
  });

  return {
    projectId,
    classification:  classified.classification,
    routeTo:         classified.route_to,
    understood,
    tokenDecision:   estimator.decision,
    estimatedTokens: estimator.estimated_tokens,
  };
}
