import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { post, get } from '../http.js';
import { orchestratorUrl, mcpUrl } from '../config.js';
import { StatusBar } from './StatusBar.js';

// ─── Types ───────────────────────────────────────────────────────────────────

type MessageRole = 'user' | 'assistant' | 'system' | 'event' | 'error';

interface Message {
  id:         string;
  role:       MessageRole;
  content:    string;
  agentName?: string;
}

interface SseEvent {
  type:       string;
  agentName:  string;
  message:    string;
  timestamp:  string;
}

interface QueueEntry {
  id:        string;
  agentName: string;
  status:    string;
  position:  number | null;
  task:      string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ROLE_COLOR: Record<MessageRole, string> = {
  user:      'cyan',
  assistant: 'white',
  system:    'gray',
  event:     'yellow',
  error:     'red',
};

const ROLE_PREFIX: Record<MessageRole, string> = {
  user:      'You',
  assistant: 'Pantheon',
  system:    '●',
  event:     '·',
  error:     '✗',
};

const STATUS_ICON: Record<string, string> = {
  queued:  '○', running: '▶', done: '✓', error: '✗', cancelled: '⊘',
};

const HELP_TEXT = `
Available slash commands:
  /help            Show this help
  /clear           Clear the conversation
  /queue           Show the agent queue for current project
  /agents          List all registered agents
  /status          Check MCP + orchestrator health
  /budget          Show token budget
  /project         Show current project ID
  /forge <name> <desc>  Create a new agent via Prometheus
  /exit  or  Ctrl+C     Quit
`.trim();

// ─── Text input ───────────────────────────────────────────────────────────────

function InputLine({
  value,
  processing,
}: {
  value:      string;
  processing: boolean;
}) {
  const [frame, setFrame] = useState(0);
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  useEffect(() => {
    if (!processing) return;
    const t = setInterval(() => setFrame(f => (f + 1) % frames.length), 80);
    return () => clearInterval(t);
  }, [processing]);

  return (
    <Box>
      <Text color="cyan" bold>{'> '}</Text>
      {processing ? (
        <Text color="yellow">{frames[frame]} processing…</Text>
      ) : (
        <Text>{value}<Text backgroundColor="white" color="black">{' '}</Text></Text>
      )}
    </Box>
  );
}

// ─── Single message row ────────────────────────────────────────────────────────

function MessageRow({ msg }: { msg: Message }) {
  const prefix = ROLE_PREFIX[msg.role];
  const color  = ROLE_COLOR[msg.role];

  if (msg.role === 'event') {
    return (
      <Box>
        <Text color="yellow">  · </Text>
        {msg.agentName && <Text color="gray">[{msg.agentName}] </Text>}
        <Text color="gray">{msg.content}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={color} bold>{prefix}</Text>
      {msg.content.split('\n').map((line, i) => (
        <Text key={i} color={color === 'white' ? undefined : color as 'gray' | 'red' | 'cyan'}>
          {line}
        </Text>
      ))}
    </Box>
  );
}

// ─── Main Shell ───────────────────────────────────────────────────────────────

export function Shell() {
  const { exit }         = useApp();
  const { stdout }       = useStdout();
  const rows             = stdout.rows ?? 24;
  const contentRows      = Math.max(rows - 5, 8); // leave room for input + status bar

  const [messages,     setMessages]     = useState<Message[]>([
    { id: '0', role: 'system', content: 'Pantheon ready. Type a message or /help for commands. Press Ctrl+C to quit.' },
  ]);
  const [input,        setInput]        = useState('');
  const [processing,   setProcessing]   = useState(false);
  const [projectId,    setProjectId]    = useState<string | null>(null);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyIdx,   setHistoryIdx]   = useState(-1);
  const [workerOn,     setWorkerOn]     = useState(false);
  const [budgetUsed,   setBudgetUsed]   = useState(0);
  const [budgetLimit,  setBudgetLimit]  = useState(0);

  const addMsg = useCallback((role: MessageRole, content: string, agentName?: string) => {
    const id = crypto.randomUUID();
    setMessages(prev => [...prev, { id, role, content, agentName }]);
  }, []);

  // Poll worker status + budget every 3s
  useEffect(() => {
    const poll = async () => {
      try {
        const [ws, bs] = await Promise.all([
          get<{ running: boolean }>(orchestratorUrl('/worker/status')),
          post<{ usedTokens?: number; limitTokens?: number }>(
            orchestratorUrl('/budget'), { projectId: projectId ?? undefined }
          ),
        ]);
        setWorkerOn(ws.running);
        setBudgetUsed(bs.usedTokens ?? 0);
        setBudgetLimit(bs.limitTokens ?? 0);
      } catch { /* servers might not be running */ }
    };
    void poll();
    const t = setInterval(() => { void poll(); }, 3000);
    return () => clearInterval(t);
  }, [projectId]);

  // Subscribe to SSE events while processing
  useEffect(() => {
    if (!processing || !projectId) return;
    let aborted = false;

    const connect = async () => {
      try {
        const res = await fetch(orchestratorUrl('/events'), {
          headers: { Accept: 'text/event-stream' },
        });
        if (!res.body) return;
        const reader  = res.body.getReader();
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
              setMessages(prev => [...prev, {
                id:        crypto.randomUUID(),
                role:      'event',
                content:   evt.message,
                agentName: evt.agentName,
              }]);
            } catch { /* skip malformed */ }
          }
        }
      } catch { /* SSE optional */ }
    };

    void connect();
    return () => { aborted = true; };
  }, [processing, projectId]);

  // ── Slash command handler ─────────────────────────────────────────────────

  const handleSlash = useCallback(async (cmd: string) => {
    const [name, ...args] = cmd.slice(1).split(' ');

    switch (name) {
      case 'help':
        addMsg('system', HELP_TEXT);
        break;

      case 'clear':
        setMessages([{ id: crypto.randomUUID(), role: 'system', content: 'Conversation cleared.' }]);
        break;

      case 'exit':
        exit();
        break;

      case 'project':
        addMsg('system', projectId ? `Current project: ${projectId}` : 'No active project.');
        break;

      case 'status': {
        try {
          const [mcp, orch] = await Promise.all([
            get<{ status: string; tools: number }>(mcpUrl('/health')),
            get<{ status: string }>(orchestratorUrl('/health')),
          ]);
          addMsg('system', `MCP: ${mcp.status} (${mcp.tools} tools)   Orchestrator: ${orch.status}`);
        } catch (e) {
          addMsg('error', `Status check failed: ${String(e)}`);
        }
        break;
      }

      case 'agents': {
        // Use the same listAgents logic
        try {
          addMsg('system', 'Agent tiers: router-tier · core-tier · specialist-tier\nRun `pantheon agents list` for full list.');
        } catch { /* */ }
        break;
      }

      case 'queue': {
        if (!projectId) { addMsg('system', 'No active project. Run a task first.'); break; }
        try {
          const res = await post<{ rows: QueueEntry[] }>(orchestratorUrl('/queue'), { projectId });
          if (res.rows.length === 0) { addMsg('system', 'Queue is empty.'); break; }
          const lines = res.rows
            .sort((a, b) => (a.position ?? 999) - (b.position ?? 999))
            .map(r => `${STATUS_ICON[r.status] ?? '?'} [${r.position ?? '-'}] ${r.agentName.padEnd(20)} ${r.task.slice(0, 40)}`);
          addMsg('system', lines.join('\n'));
        } catch (e) {
          addMsg('error', String(e));
        }
        break;
      }

      case 'budget': {
        try {
          const res = await post<{ usedTokens?: number; limitTokens?: number }>(
            orchestratorUrl('/budget'), { projectId: projectId ?? undefined }
          );
          const used  = res.usedTokens ?? 0;
          const limit = res.limitTokens ?? 0;
          addMsg('system', `Token budget: ${used.toLocaleString()} / ${limit > 0 ? limit.toLocaleString() : 'unlimited'} used`);
        } catch (e) {
          addMsg('error', String(e));
        }
        break;
      }

      case 'forge': {
        const [agentName, ...descWords] = args;
        if (!agentName || descWords.length === 0) {
          addMsg('system', 'Usage: /forge <name> <description>');
          break;
        }
        const description = descWords.join(' ');
        setProcessing(true);
        addMsg('system', `Forging agent "${agentName}" via Prometheus…`);
        try {
          const res = await post<{ name: string; tier: string; output: string }>(
            orchestratorUrl('/forge'), { name: agentName, tier: 'specialist-tier', description }
          );
          addMsg('assistant', `✓ Created agents/${res.tier}/${res.name}.md\n\n${res.output}`);
        } catch (e) {
          addMsg('error', String(e));
        } finally {
          setProcessing(false);
        }
        break;
      }

      default:
        addMsg('error', `Unknown command: /${name}. Type /help for available commands.`);
    }
  }, [addMsg, exit, projectId]);

  // ── Submit regular message ────────────────────────────────────────────────

  const submit = useCallback(async (text: string) => {
    if (!text.trim()) return;

    setInputHistory(h => [text, ...h.slice(0, 49)]);
    setHistoryIdx(-1);
    setInput('');

    if (text.startsWith('/')) {
      await handleSlash(text);
      return;
    }

    addMsg('user', text);
    setProcessing(true);

    try {
      // Route the message first to decide path
      const route = await post<{
        projectId:      string;
        routeTo:        string;
        classification: string;
        tokenDecision:  string;
      }>(orchestratorUrl('/route'), { prompt: text, projectId: projectId ?? undefined });

      setProjectId(route.projectId);

      if (route.tokenDecision === 'blocked') {
        addMsg('error', 'Token budget exceeded. Use /budget to check usage.');
        return;
      }

      if (route.routeTo === 'btw-agent') {
        // Stream the response token by token
        const streamingId = crypto.randomUUID();
        setMessages(prev => [...prev, { id: streamingId, role: 'assistant', content: '' }]);

        const res = await fetch(orchestratorUrl('/stream'), {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body:    JSON.stringify({ prompt: text, projectId: route.projectId }),
        });

        if (!res.body) throw new Error('No stream body');
        const reader  = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const chunk = JSON.parse(line.slice(6)) as { type: string; text?: string };
              if (chunk.type === 'token' && chunk.text) {
                setMessages(prev => prev.map(m =>
                  m.id === streamingId ? { ...m, content: m.content + chunk.text } : m
                ));
              }
            } catch { /* skip */ }
          }
        }
      } else {
        // Full pipeline — show live events, wait for completion
        const result = await post<{
          projectId: string;
          routeTo:   string;
          output:    string;
          agentsRun: number;
        }>(orchestratorUrl('/pipeline'), { prompt: text, projectId: route.projectId });

        const footer = `\n\n─\n${result.agentsRun} agents ran  ·  project: ${result.projectId}\nType /queue to inspect the queue`;
        addMsg('assistant', result.output + footer);
      }
    } catch (e) {
      addMsg('error', `Error: ${String(e)}`);
    } finally {
      setProcessing(false);
    }
  }, [addMsg, handleSlash, projectId]);

  // ── Keyboard input ────────────────────────────────────────────────────────

  useInput((char, key) => {
    if (processing) return;

    if (key.ctrl && char === 'c') { exit(); return; }
    if (key.return) { void submit(input); return; }

    if (key.backspace || key.delete) {
      setInput(v => v.slice(0, -1));
      return;
    }

    if (key.upArrow) {
      setHistoryIdx(i => {
        const next = Math.min(i + 1, inputHistory.length - 1);
        if (inputHistory[next] !== undefined) setInput(inputHistory[next]!);
        return next;
      });
      return;
    }

    if (key.downArrow) {
      setHistoryIdx(i => {
        const next = i - 1;
        if (next < 0) { setInput(''); return -1; }
        if (inputHistory[next] !== undefined) setInput(inputHistory[next]!);
        return next;
      });
      return;
    }

    if (!key.ctrl && !key.meta && !key.escape && char) {
      setInput(v => v + char);
    }
  });

  // ── Render ────────────────────────────────────────────────────────────────

  // Show only the last N messages that fit in the terminal
  const visible = messages.slice(-contentRows);

  return (
    <Box flexDirection="column" height={rows}>
      {/* Header */}
      <Box borderStyle="single" borderColor="blue" paddingX={1} marginBottom={1}>
        <Text bold color="blue">Pantheon</Text>
        {projectId && <Text color="gray">  project: {projectId}</Text>}
      </Box>

      {/* Messages */}
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {visible.map(m => <MessageRow key={m.id} msg={m} />)}
      </Box>

      {/* Input */}
      <Box paddingX={1} marginTop={1}>
        <InputLine value={input} processing={processing} />
      </Box>

      {/* Status bar */}
      <StatusBar
        workerOn={workerOn}
        budgetUsed={budgetUsed}
        budgetLimit={budgetLimit}
        projectId={projectId}
      />
    </Box>
  );
}
