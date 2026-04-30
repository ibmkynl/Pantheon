import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getConfig } from '../config.js';

let _client: Client | null = null;

async function connect(): Promise<Client> {
  const config = getConfig();
  const url    = new URL(`http://${config.mcp.host}:${config.mcp.port}/mcp`);
  const transport = new StreamableHTTPClientTransport(url);
  const client    = new Client({ name: 'pantheon-orchestrator', version: '0.1.0' });
  await client.connect(transport);
  return client;
}

export async function getMcpClient(): Promise<Client> {
  if (_client) return _client;
  _client = await connect();
  return _client;
}

export async function closeMcpClient(): Promise<void> {
  if (_client) {
    try { await _client.close(); } catch { /* ignore */ }
    _client = null;
  }
}

// Resets the singleton so the next call to getMcpClient() reconnects.
// Called by the worker when a tool call fails with a connection error.
export function resetMcpClient(): void {
  _client = null;
}
