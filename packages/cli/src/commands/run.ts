import { orchestratorUrl } from '../config.js';
import { post } from '../http.js';

interface RunResult {
  output:        string;
  iterations:    number;
  toolCallCount: number;
}

export async function cmdRun(
  task: string,
  opts: { agent?: string; project?: string; yes?: boolean }
) {
  const agentName = opts.agent ?? 'orchestrator';

  if (!opts.yes) {
    process.stdout.write(
      `\nAgent: ${agentName}\nTask:  ${task}\n\nRun? [y/N] `
    );
    const answer = await new Promise<string>(resolve => {
      let buf = '';
      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (ch: string) => {
        buf += ch;
        if (ch === '\r' || ch === '\n' || ch === 'y' || ch === 'n' || ch === 'N') {
          process.stdin.setRawMode?.(false);
          process.stdin.pause();
          resolve(buf.trim().toLowerCase());
        }
      });
    });
    if (answer !== 'y') {
      console.log('\nAborted.');
      return;
    }
  }

  console.log(`\n⟳  Running ${agentName}…\n`);

  try {
    const result = await post<RunResult>(orchestratorUrl('/run'), {
      agentName,
      task,
      projectId: opts.project,
    });

    console.log('─'.repeat(60));
    console.log(result.output);
    console.log('─'.repeat(60));
    console.log(`✓  Done — ${result.iterations} iterations, ${result.toolCallCount} tool calls`);
  } catch (err) {
    console.error('Error:', String(err));
    process.exit(1);
  }
}
