import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getConfig } from '../config.js';

let _client: Client | null = null;

export async function getMcpClient(): Promise<Client> {
  if (_client) return _client;

  const config = getConfig();
  const url = new URL(`http://${config.mcp.host}:${config.mcp.port}/mcp`);
  const transport = new StreamableHTTPClientTransport(url);

  _client = new Client({ name: 'pantheon-orchestrator', version: '0.1.0' });
  await _client.connect(transport);
  return _client;
}

export async function closeMcpClient(): Promise<void> {
  if (_client) {
    await _client.close();
    _client = null;
  }
}
