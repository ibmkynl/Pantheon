import React from 'react';
import { render } from 'ink';
import { RunView } from '../ui/RunView.js';
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
  // Direct agent invocation (bypasses router)
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

  // Router tier: understand + classify first
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

  // btw-agent: single synchronous LLM call, no live view needed
  if (route.routeTo === 'btw-agent') {
    console.log('\n⟳  Answering…\n');
    try {
      const result = await post<{ output: string; agentsRun: number }>(
        orchestratorUrl('/pipeline'),
        { prompt: task, projectId: route.projectId }
      );
      console.log('─'.repeat(60));
      console.log(result.output);
      console.log('─'.repeat(60));
      console.log(`✓  Done  |  project: ${route.projectId}`);
    } catch (err) {
      console.error('Error:', String(err));
      process.exit(1);
    }
    return;
  }

  // Full task pipeline: show live RunView with SSE events
  let finalOutput = '';
  let finalAgents = 0;
  let runError    = '';

  const { waitUntilExit } = render(
    React.createElement(RunView, {
      projectId: route.projectId,
      task,
      onDone: (output, agentsRun) => { finalOutput = output; finalAgents = agentsRun; },
      onError: (err) => { runError = err; },
    })
  );

  await waitUntilExit();

  if (runError) {
    console.error('\n✗ Error:', runError);
    process.exit(1);
  }

  console.log('\n' + '─'.repeat(60));
  if (finalOutput) console.log(finalOutput);
  console.log('─'.repeat(60));
  console.log(`✓  Done — ${finalAgents} agents ran  |  project: ${route.projectId}`);
  console.log(`   Files:  pantheon queue --project ${route.projectId}`);
  console.log(`   Logs:   pantheon logs  --project ${route.projectId}`);
}

function printResult(result: RunResult) {
  console.log('─'.repeat(60));
  if (result.output) console.log(result.output);
  console.log('─'.repeat(60));
  console.log(`✓  Done — ${result.iterations} iterations, ${result.toolCallCount} tool calls`);
}
