import React from 'react';
import { render } from 'ink';
import { QueueView } from '../ui/QueueView.js';
import { orchestratorUrl } from '../config.js';
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
  const pos  = entry.position !== null ? `[${String(entry.position).padStart(2)}]` : '   ';
  const id   = entry.id.slice(0, 8);
  const task = entry.task.length > 50 ? entry.task.slice(0, 47) + '…' : entry.task;
  return `${icon} ${pos} ${id}  ${entry.agentName.padEnd(20)} ${task}`;
}

export async function cmdQueue(opts: { project?: string; watch?: boolean }) {
  if (opts.watch) {
    const { waitUntilExit } = render(
      React.createElement(QueueView, { projectId: opts.project, pollMs: 2000 })
    );
    await waitUntilExit();
    return;
  }

  try {
    const [result, workerStatus] = await Promise.all([
      post<{ rows: QueueEntry[] }>(orchestratorUrl('/queue'), { projectId: opts.project }),
      get<{ running: boolean }>(orchestratorUrl('/worker/status')),
    ]);

    console.log('Pantheon Queue' + (opts.project ? ` — project: ${opts.project}` : ''));
    console.log('─'.repeat(80));

    const rows = result.rows.sort((a, b) => (a.position ?? 999) - (b.position ?? 999));
    if (rows.length === 0) {
      console.log('  (empty)');
    } else {
      for (const r of rows) {
        console.log(fmt(r));
        if (r.status === 'error' && r.errorMessage) {
          console.log(`    ↳ ${r.errorMessage}`);
        }
      }
    }

    console.log('─'.repeat(80));
    console.log(`Worker: ${workerStatus.running ? '▶ running' : '■ stopped'}`);
  } catch (err) {
    console.error('Error:', String(err));
  }
}

export async function cmdWorkerStart(opts: { project?: string }) {
  const result = await post<{ started: boolean; reason?: string }>(
    orchestratorUrl('/worker/start'),
    { projectId: opts.project }
  );
  console.log(result.started ? 'Worker started.' : `Worker not started: ${result.reason}`);
}

export async function cmdWorkerStop() {
  await post(orchestratorUrl('/worker/stop'));
  console.log('Worker stop requested.');
}
