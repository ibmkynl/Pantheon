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
    process.stdout.write(`\nAgent: ${agentName}\nTask:  ${task}\n\nRun? [y/N] `);

    const answer = await new Promise<string>(resolve => {
      if (!process.stdin.isTTY) {
        // Non-interactive — default deny to prevent accidental runs
        resolve('n');
        return;
      }
      let buf = '';
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      const onData = (ch: string) => {
        buf += ch;
        if ('\r\n'.includes(ch) || 'yn'.includes(ch.toLowerCase())) {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(buf.trim().toLowerCase());
        }
      };
      process.stdin.on('data', onData);
    });

    if (answer !== 'y') {
      console.log('Aborted.');
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
