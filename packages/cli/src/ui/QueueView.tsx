import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { post, get } from '../http.js';
import { orchestratorUrl } from '../config.js';

interface QueueEntry {
  id:          string;
  agentName:   string;
  domain:      string;
  status:      string;
  position:    number | null;
  task:        string;
  errorMessage?: string | null;
  startedAt?:   string | null;
  completedAt?: string | null;
}

const STATUS_COLOR: Record<string, string> = {
  queued:    'gray',
  running:   'cyan',
  done:      'green',
  error:     'red',
  cancelled: 'gray',
};

const STATUS_ICON: Record<string, string> = {
  queued:    '○',
  running:   '▶',
  done:      '✓',
  error:     '✗',
  cancelled: '⊘',
};

function Spinner({ active }: { active: boolean }) {
  const [frame, setFrame] = useState(0);
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setFrame(f => (f + 1) % frames.length), 80);
    return () => clearInterval(t);
  }, [active]);
  return <Text color="cyan">{active ? frames[frame] : ' '}</Text>;
}

interface QueueViewProps {
  projectId?: string;
  pollMs?:    number;
}

export function QueueView({ projectId, pollMs = 2000 }: QueueViewProps) {
  const { exit } = useApp();
  const [rows, setRows]         = useState<QueueEntry[]>([]);
  const [workerOn, setWorkerOn] = useState(false);
  const [error, setError]       = useState<string | null>(null);

  useInput((input) => {
    if (input === 'q' || input === '\x03') exit();
  });

  useEffect(() => {
    const load = async () => {
      try {
        const [qRes, wRes] = await Promise.all([
          post<{ rows: QueueEntry[] }>(orchestratorUrl('/queue'), { projectId }),
          get<{ running: boolean }>(orchestratorUrl('/worker/status')),
        ]);
        setRows(qRes.rows.sort((a, b) => (a.position ?? 999) - (b.position ?? 999)));
        setWorkerOn(wRes.running);
        setError(null);
      } catch (err) {
        setError(String(err));
      }
    };

    void load();
    const t = setInterval(() => { void load(); }, pollMs);
    return () => clearInterval(t);
  }, [projectId, pollMs]);

  const running = rows.filter(r => r.status === 'running').length;
  const done    = rows.filter(r => r.status === 'done').length;
  const queued  = rows.filter(r => r.status === 'queued').length;
  const errors  = rows.filter(r => r.status === 'error').length;

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="blue">Pantheon Queue</Text>
        {projectId && <Text color="gray"> — {projectId}</Text>}
        <Box marginLeft={2}>
          <Spinner active={running > 0 || workerOn} />
        </Box>
      </Box>

      {error && (
        <Box marginBottom={1}>
          <Text color="red">⚠  {error}</Text>
        </Box>
      )}

      {rows.length === 0 ? (
        <Text color="gray">(empty)</Text>
      ) : (
        rows.map(row => (
          <Box key={row.id} flexDirection="column" marginBottom={row.status === 'error' ? 1 : 0}>
            <Box>
              <Text color={STATUS_COLOR[row.status] ?? 'white'}>
                {STATUS_ICON[row.status] ?? '?'}{' '}
              </Text>
              <Text color="gray">[{String(row.position ?? '–').padStart(2)}]  </Text>
              <Text bold color="white">{row.agentName.padEnd(22)}</Text>
              <Text color="gray">
                {row.task.length > 48 ? row.task.slice(0, 45) + '…' : row.task}
              </Text>
            </Box>
            {row.status === 'error' && row.errorMessage && (
              <Box marginLeft={4}>
                <Text color="red">↳ {row.errorMessage}</Text>
              </Box>
            )}
          </Box>
        ))
      )}

      <Box marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
        <Text color="green">✓ {done} done  </Text>
        <Text color="cyan">▶ {running} running  </Text>
        <Text color="gray">○ {queued} queued  </Text>
        {errors > 0 && <Text color="red">✗ {errors} error  </Text>}
        <Text color="gray">  Worker: {workerOn ? <Text color="cyan">on</Text> : 'off'}</Text>
        <Text color="gray">  [q] quit</Text>
      </Box>
    </Box>
  );
}
