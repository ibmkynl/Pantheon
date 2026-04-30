import { orchestratorUrl, mcpUrl } from '../config.js';
import { get } from '../http.js';

interface HealthResult {
  label:  string;
  ok:     boolean;
  detail: string;
}

async function check(label: string, url: string): Promise<HealthResult> {
  try {
    const res = await get<Record<string, unknown>>(url);
    const detail = res['tools'] != null
      ? `tools=${res['tools']}`
      : res['status'] ?? 'ok';
    return { label, ok: true, detail: String(detail) };
  } catch (err) {
    return { label, ok: false, detail: String(err) };
  }
}

export async function cmdValidate() {
  console.log('\nPantheon — validation\n' + '─'.repeat(50));

  const results = await Promise.all([
    check('MCP server',   mcpUrl('/health')),
    check('Orchestrator', orchestratorUrl('/health')),
  ]);

  let allOk = true;
  for (const r of results) {
    const icon = r.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    console.log(`  ${icon}  ${r.label.padEnd(20)} ${r.detail}`);
    if (!r.ok) allOk = false;
  }

  console.log('─'.repeat(50));
  if (allOk) {
    console.log('\x1b[32m✓ All checks passed\x1b[0m\n');
  } else {
    console.log('\x1b[31m✗ Some checks failed — ensure both servers are running\x1b[0m\n');
    process.exit(1);
  }
}
