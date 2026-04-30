import { Command } from 'commander';
import { cmdRun } from './commands/run.js';
import { cmdQueue, cmdWorkerStart, cmdWorkerStop } from './commands/queue.js';
import { cmdStatus } from './commands/status.js';
import { cmdLogs } from './commands/logs.js';
import { cmdBudgetSet, cmdBudgetStatus } from './commands/budget.js';
import { cmdAgentsList } from './commands/agents.js';

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

program.parse();
