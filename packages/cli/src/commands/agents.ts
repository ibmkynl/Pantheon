import fs from 'node:fs';
import path from 'node:path';

function findRepoRoot(): string {
  let dir = process.cwd();
  while (true) {
    if (fs.existsSync(path.join(dir, 'pantheon.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Cannot find repo root');
    dir = parent;
  }
}

const TIERS = ['router-tier', 'core-tier', 'specialist-tier'] as const;

interface AgentInfo {
  name:  string;
  tier:  string;
  path:  string;
}

function listAgents(): AgentInfo[] {
  const root   = findRepoRoot();
  const agents: AgentInfo[] = [];

  for (const tier of TIERS) {
    const dir = path.join(root, 'agents', tier);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      agents.push({ name: file.replace('.md', ''), tier, path: path.join(dir, file) });
    }
  }

  return agents;
}

export function cmdAgentsList() {
  const agents = listAgents();

  if (agents.length === 0) {
    console.log('No agents found in agents/ directory.');
    return;
  }

  const byTier = agents.reduce<Record<string, AgentInfo[]>>((acc, a) => {
    (acc[a.tier] ??= []).push(a);
    return acc;
  }, {});

  for (const tier of TIERS) {
    const list = byTier[tier];
    if (!list?.length) continue;
    console.log(`\n${tier}`);
    console.log('─'.repeat(40));
    for (const a of list) {
      console.log(`  ${a.name}`);
    }
  }
  console.log('');
}
