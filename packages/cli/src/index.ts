import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import { cmdRun } from './commands/run.js';
import { cmdQueue, cmdWorkerStart, cmdWorkerStop } from './commands/queue.js';
import { cmdStatus } from './commands/status.js';
import { cmdLogs } from './commands/logs.js';
import { cmdBudgetSet, cmdBudgetStatus } from './commands/budget.js';
import { cmdAgentsList } from './commands/agents.js';
import { cmdValidate } from './commands/validate.js';
import { cmdForge } from './commands/forge.js';
import { Shell } from './ui/Shell.js';
import { ensureServers } from './lib/bootstrap.js';
import { ensureSetup, runSetup } from './lib/setup.js';

// ── Interactive shell (no subcommand given) ────────────────────────────────
if (process.argv.length <= 2) {
  // First-run setup: ensures ~/.pantheon/pantheon.yaml exists with a real API key
  const ready = await ensureSetup();
  if (!ready) process.exit(1);

  // Auto-spawn MCP server + orchestrator if not already running
  await ensureServers();

  const { waitUntilExit } = render(React.createElement(Shell));
  await waitUntilExit();
  process.exit(0);
}

// ── Commander subcommands ──────────────────────────────────────────────────
const program = new Command();

program
  .name('pantheon')
  .description('Pantheon — self-extending agentic OS')
  .version('0.1.0');

// pantheon run "..." [--agent go-dev] [--project proj-id] [--yes]
program
  .command('run <task>')
  .description('Run an agent on a task')
  .option('-a, --agent <name>', 'agent to run (default: orchestrator)', 'orchestrator')
  .option('-p, --project <id>', 'project ID')
  .option('-y, --yes', 'skip confirmation prompt')
  .action((task: string, opts) => { void cmdRun(task, opts); });

// pantheon queue [--project id] [--watch]
program
  .command('queue')
  .description('Show the agent queue')
  .option('-p, --project <id>', 'filter by project')
  .option('-w, --watch', 'refresh every 2 seconds')
  .action(opts => { void cmdQueue(opts); });

// pantheon worker start / stop
const worker = program.command('worker').description('Manage the queue worker');
worker
  .command('start')
  .description('Start the queue worker')
  .option('-p, --project <id>', 'project scope')
  .action(opts => { void cmdWorkerStart(opts); });
worker
  .command('stop')
  .description('Stop the queue worker')
  .action(() => { void cmdWorkerStop(); });

// pantheon status
program
  .command('status')
  .description('Show MCP server and orchestrator status')
  .action(() => { void cmdStatus(); });

// pantheon logs [--project id] [--limit n] [--follow]
program
  .command('logs')
  .description('Show project logs')
  .option('-p, --project <id>', 'filter by project')
  .option('-n, --limit <n>', 'number of entries', '50')
  .option('-f, --follow', 'tail mode (refresh every 2s)')
  .action(opts => { void cmdLogs({ ...opts, limit: parseInt(opts.limit, 10) }); });

// pantheon budget set <n> / pantheon budget status
const budget = program.command('budget').description('Manage token budget');
budget
  .command('set <limit>')
  .description('Set token budget cap')
  .option('-p, --project <id>', 'project scope')
  .action((limit: string, opts) => { void cmdBudgetSet(limit, opts); });
budget
  .command('status')
  .description('Show current token usage')
  .option('-p, --project <id>', 'project scope')
  .action(opts => { void cmdBudgetStatus(opts); });

// pantheon agents list
const agents = program.command('agents').description('Manage agents');
agents
  .command('list')
  .description('List all registered agents')
  .action(() => cmdAgentsList());

// pantheon validate
program
  .command('validate')
  .description('Check that MCP server and orchestrator are healthy')
  .action(() => { void cmdValidate(); });

// pantheon setup
program
  .command('setup')
  .description('Configure or change your AI provider and API key')
  .action(async () => {
    const ok = await runSetup();
    process.exit(ok ? 0 : 1);
  });

// pantheon forge [--name] [--tier] [--description]
program
  .command('forge')
  .description('Interactively create a new agent via Prometheus')
  .option('-n, --name <name>', 'agent name (snake-case)')
  .option('-t, --tier <tier>', 'tier: specialist-tier | core-tier | router-tier')
  .option('-d, --description <desc>', 'what the agent should do')
  .action(opts => { void cmdForge(opts); });

program.parse();
