import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { post } from '../http.js';
import { orchestratorUrl } from '../config.js';

interface LogRow {
  id:        number;
  projectId: string;
  message:   string;
  level:     string;
  agentName: string | null;
  createdAt: string;
}

const LEVEL_COLOR: Record<string, string> = {
  info:  'cyan',
  warn:  'yellow',
  error: 'red',
  debug: 'gray',
};

interface LogsViewProps {
  projectId?: string;
  limit?:     number;
  pollMs?:    number;
}

export function LogsView({ projectId, limit = 50, pollMs = 2000 }: LogsViewProps) {
  const { exit } = useApp();
  const [rows, setRows] = useState<LogRow[]>([]);
  const [err, setErr]   = useState<string | null>(null);

  useInput((input) => {
    if (input === 'q' || input === '\x03') exit();
  });

  useEffect(() => {
    const load = async () => {
      try {
        const res = await post<{ rows: LogRow[] }>(orchestratorUrl('/logs'), { projectId, limit });
        setRows(res.rows.reverse());
        setErr(null);
      } catch (e) {
        setErr(String(e));
      }
    };
    void load();
    const t = setInterval(() => { void load(); }, pollMs);
    return () => clearInterval(t);
  }, [projectId, limit, pollMs]);

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="blue">Pantheon Logs</Text>
        {projectId && <Text color="gray"> — {projectId}</Text>}
      </Box>

      {err && <Text color="red">⚠  {err}</Text>}

      {rows.length === 0 ? (
        <Text color="gray">(no logs)</Text>
      ) : (
        rows.map(r => (
          <Box key={r.id}>
            <Text color="gray">{r.createdAt.slice(11, 19)} </Text>
            <Text color={LEVEL_COLOR[r.level] ?? 'white'}>{r.level.toUpperCase().padEnd(5)} </Text>
            {r.agentName && <Text color="gray">[{r.agentName}] </Text>}
            <Text>{r.message}</Text>
          </Box>
        ))
      )}

      <Box marginTop={1}>
        <Text color="gray">[q] quit  (auto-refreshes every {pollMs / 1000}s)</Text>
      </Box>
    </Box>
  );
}
