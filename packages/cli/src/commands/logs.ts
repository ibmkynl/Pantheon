import React from 'react';
import { render } from 'ink';
import { LogsView } from '../ui/LogsView.js';
import { orchestratorUrl } from '../config.js';
import { post } from '../http.js';

interface LogRow {
  id:        number;
  projectId: string;
  message:   string;
  level:     string;
  agentName: string | null;
  createdAt: string;
}

const LEVEL_PREFIX: Record<string, string> = {
  info:  '\x1b[36mINFO\x1b[0m ',
  warn:  '\x1b[33mWARN\x1b[0m ',
  error: '\x1b[31mERRO\x1b[0m ',
  debug: '\x1b[90mDEBG\x1b[0m ',
};

export async function cmdLogs(opts: { project?: string; limit?: number; follow?: boolean }) {
  if (opts.follow) {
    const { waitUntilExit } = render(
      React.createElement(LogsView, {
        projectId: opts.project,
        limit:     opts.limit ?? 50,
        pollMs:    2000,
      })
    );
    await waitUntilExit();
    return;
  }

  try {
    const result = await post<{ rows: LogRow[] }>(orchestratorUrl('/logs'), {
      projectId: opts.project,
      limit:     opts.limit ?? 50,
    });

    for (const r of result.rows.reverse()) {
      const ts     = r.createdAt.slice(11, 19);
      const prefix = LEVEL_PREFIX[r.level] ?? r.level;
      const agent  = r.agentName ? `\x1b[90m[${r.agentName}]\x1b[0m ` : '';
      console.log(`${ts} ${prefix}${agent}${r.message}`);
    }
  } catch (err) {
    console.error('Error:', String(err));
  }
}
