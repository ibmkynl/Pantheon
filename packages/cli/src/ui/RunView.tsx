import React, { useState, useEffect } from 'react';
import { Box, Text, useApp } from 'ink';
import { orchestratorUrl } from '../config.js';

interface SseEvent {
  type:      string;
  agentName: string;
  message:   string;
  timestamp: string;
}

const EVENT_ICON: Record<string, string> = {
  'agent.complete': '✓',
  'agent.error':   '✗',
  'agent.start':   '▶',
};

const EVENT_COLOR: Record<string, string> = {
  'agent.complete': 'green',
  'agent.error':   'red',
  'agent.start':   'cyan',
};

interface RunViewProps {
  projectId: string;
  task:      string;
  onDone:    (output: string, agentsRun: number) => void;
  onError:   (err: string) => void;
}

export function RunView({ projectId, task, onDone, onError }: RunViewProps) {
  const { exit } = useApp();
  const [events, setEvents] = useState<SseEvent[]>([]);
  const [frame, setFrame]   = useState(0);
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  useEffect(() => {
    const t = setInterval(() => setFrame(f => (f + 1) % frames.length), 80);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let aborted = false;

    const connect = async () => {
      try {
        const res = await fetch(orchestratorUrl('/events'), {
          headers: { Accept: 'text/event-stream' },
        });
        if (!res.body) return;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';

        while (!aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const evt = JSON.parse(line.slice(6)) as SseEvent;
              setEvents(prev => [...prev.slice(-30), evt]);
            } catch { /* skip malformed */ }
          }
        }
      } catch { /* SSE optional — pipeline still runs */ }
    };

    void connect();
    return () => { aborted = true; };
  }, []);

  useEffect(() => {
    const run = async () => {
      try {
        const { post } = await import('../http.js');
        const result = await post<{ output: string; agentsRun: number; projectId: string }>(
          orchestratorUrl('/pipeline'),
          { prompt: task, projectId }
        );
        onDone(result.output, result.agentsRun);
      } catch (e) {
        onError(String(e));
      }
      exit();
    };
    void run();
  }, []);

  const taskShort = task.length > 60 ? task.slice(0, 57) + '…' : task;

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text color="cyan">{frames[frame]} </Text>
        <Text bold>Running pipeline</Text>
        <Text color="gray"> — {projectId}</Text>
      </Box>

      <Box marginBottom={1}>
        <Text color="gray">Task: {taskShort}</Text>
      </Box>

      {events.length > 0 && (
        <Box flexDirection="column">
          <Text color="gray" dimColor>─────────────────────────────────────────</Text>
          {events.slice(-12).map((e, i) => (
            <Box key={i}>
              <Text color={EVENT_COLOR[e.type] ?? 'white'}>
                {EVENT_ICON[e.type] ?? '·'}{' '}
              </Text>
              <Text color="gray">[{e.agentName}] </Text>
              <Text>{e.message}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
