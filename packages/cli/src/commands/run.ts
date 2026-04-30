import { orchestratorUrl } from '../config.js';
import { post } from '../http.js';

interface RunResult {
  output:        string;
  iterations:    number;
  toolCallCount: number;
}

interface RouteResult {
  projectId:       string;
  classification:  string;
  routeTo:         string;
  tokenDecision:   string;
  estimatedTokens: number;
  understood: {
    intent:      string;
    type:        string;
    tech_stack:  string[];
    ambiguities: string[];
  };
}

interface PipelineResult {
  projectId:      string;
  classification: string;
  routeTo:        string;
  output:         string;
  agentsRun:      number;
}

async function confirm(msg: string): Promise<boolean> {
  process.stdout.write(msg);
  if (!process.stdin.isTTY) return false;

  return new Promise(resolve => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (ch: string) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', onData);
      process.stdout.write('\n');
      resolve(ch.toLowerCase() === 'y');
    };
    process.stdin.on('data', onData);
  });
}

export async function cmdRun(
  task: string,
  opts: { agent?: string; project?: string; yes?: boolean }
) {
  // If a specific agent is requested, bypass the router
  if (opts.agent && opts.agent !== 'orchestrator') {
    if (!opts.yes) {
      const ok = await confirm(`\nAgent: ${opts.agent}\nTask:  ${task}\n\nRun? [y/N] `);
      if (!ok) { console.log('Aborted.'); return; }
    }
    console.log(`\n⟳  Running ${opts.agent}…\n`);
    const result = await post<RunResult>(orchestratorUrl('/run'), {
      agentName: opts.agent,
      task,
      projectId: opts.project,
    });
    printResult(result);
    return;
  }

  // Default: run the router tier first to understand + classify the request
  console.log('\n⟳  Analysing request…\n');
  let route: RouteResult;
  try {
    route = await post<RouteResult>(orchestratorUrl('/route'), {
      prompt:    task,
      projectId: opts.project,
    });
  } catch (err) {
    console.error('Error contacting orchestrator:', String(err));
    process.exit(1);
  }

  console.log(`Intent:     ${route.understood.intent}`);
  console.log(`Type:       ${route.classification}`);
  if (route.understood.tech_stack.length) {
    console.log(`Stack:      ${route.understood.tech_stack.join(', ')}`);
  }
  if (route.understood.ambiguities.length) {
    console.log(`⚠ Unclear:  ${route.understood.ambiguities.join('; ')}`);
  }
  console.log(`Route:      ${route.routeTo}`);
  console.log(`Est tokens: ~${route.estimatedTokens.toLocaleString()}`);

  if (route.tokenDecision === 'blocked') {
    console.error('\n✗ Token budget exceeded. Run `pantheon budget set <n>` to increase it.');
    process.exit(1);
  }

  if (!opts.yes) {
    const ok = await confirm('\nProceed? [y/N] ');
    if (!ok) { console.log('Aborted.'); return; }
  }

  // Run the full pipeline (orchestrator will decompose + queue + run specialists)
  console.log(`\n⟳  Running pipeline (project: ${route.projectId})…\n`);
  try {
    const result = await post<PipelineResult>(orchestratorUrl('/pipeline'), {
      prompt:    task,
      projectId: route.projectId,
    });
    console.log('─'.repeat(60));
    console.log(result.output);
    console.log('─'.repeat(60));
    console.log(`✓  Done — ${result.agentsRun} agents ran  |  project: ${result.projectId}`);
    console.log(`   Files:  pantheon queue --project ${result.projectId}`);
    console.log(`   Logs:   pantheon logs  --project ${result.projectId}`);
  } catch (err) {
    console.error('Error:', String(err));
    process.exit(1);
  }
}

function printResult(result: RunResult) {
  console.log('─'.repeat(60));
  if (result.output) console.log(result.output);
  console.log('─'.repeat(60));
  console.log(`✓  Done — ${result.iterations} iterations, ${result.toolCallCount} tool calls`);
}
