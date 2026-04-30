import { orchestratorUrl, mcpUrl } from '../config.js';
import { post, get } from '../http.js';

interface QueueEntry {
  id:          string;
  agentName:   string;
  domain:      string;
  task:        string;
  status:      string;
  position:    number | null;
  createdAt:   string;
  startedAt:   string | null;
  completedAt: string | null;
  errorMessage?: string | null;
}

const STATUS_ICON: Record<string, string> = {
  queued:    '○',
  running:   '▶',
  done:      '✓',
  error:     '✗',
  cancelled: '⊘',
};

function fmt(entry: QueueEntry): string {
  const icon = STATUS_ICON[entry.status] ?? '?';
  const pos  = entry.position !== null ? `[${entry.position}]` : '   ';
  const id   = entry.id.slice(0, 8);
  const task = entry.task.length > 50 ? entry.task.slice(0, 47) + '…' : entry.task;
  return `${icon} ${pos} ${id}  ${entry.agentName.padEnd(20)} ${task}`;
}

export async function cmdQueue(opts: { project?: string; watch?: boolean }) {
  // Use raw MCP JSON-RPC via http is complex — simpler: expose queue endpoint from orchestrator
  // For now we call the MCP server directly via its streamable transport REST endpoint
  // The queue data lives in SQLite and is exposed through agent.queue_status MCP tool
  // We'll hit the orchestrator's future /queue endpoint; for Phase 2 we query via the MCP tool

  const show = async () => {
    try {
      // POST to orchestrator to proxy the MCP call
      const result = await post<{ rows: QueueEntry[] }>(orchestratorUrl('/queue'), {
        projectId: opts.project,
      });

      console.clear();
      console.log('Pantheon Queue' + (opts.project ? ` — project: ${opts.project}` : ''));
      console.log('─'.repeat(80));

      const rows = result.rows;
      if (rows.length === 0) {
        console.log('  (empty)');
      } else {
        for (const r of rows.sort((a, b) => (a.position ?? 999) - (b.position ?? 999))) {
          console.log(fmt(r));
          if (r.status === 'error' && r.errorMessage) {
            console.log(`  Error: ${r.errorMessage}`);
          }
        }
      }

      const workerStatus = await get<{ running: boolean }>(orchestratorUrl('/worker/status'));
      console.log('─'.repeat(80));
      console.log(`Worker: ${workerStatus.running ? '▶ running' : '■ stopped'}`);
    } catch (err) {
      console.error('Error:', String(err));
    }
  };

  await show();

  if (opts.watch) {
    const interval = setInterval(() => { void show(); }, 2000);
    process.on('SIGINT', () => { clearInterval(interval); process.exit(0); });
    await new Promise(() => { /* run until ctrl-c */ });
  }
}

export async function cmdWorkerStart(opts: { project?: string }) {
  const result = await post<{ started: boolean; reason?: string }>(
    orchestratorUrl('/worker/start'),
    { projectId: opts.project }
  );
  if (result.started) {
    console.log('Worker started.');
  } else {
    console.log(`Worker not started: ${result.reason}`);
  }
}

export async function cmdWorkerStop() {
  await post(orchestratorUrl('/worker/stop'));
  console.log('Worker stop requested.');
}
