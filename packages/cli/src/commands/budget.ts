import { orchestratorUrl } from '../config.js';
import { post } from '../http.js';

interface BudgetInfo {
  allowed:     boolean;
  remaining:   number | null;
  used:        number;
  limit:       number | null;
  percentUsed: number;
}

export async function cmdBudgetSet(limit: string, opts: { project?: string }) {
  const limitTokens = parseInt(limit, 10);
  if (isNaN(limitTokens) || limitTokens < 1) {
    console.error('Error: limit must be a positive integer');
    process.exit(1);
  }
  await post(orchestratorUrl('/budget/set'), { limitTokens, projectId: opts.project });
  console.log(`Budget set to ${limitTokens.toLocaleString()} tokens.`);
}

export async function cmdBudgetStatus(opts: { project?: string }) {
  const result = await post<BudgetInfo>(orchestratorUrl('/budget'), { projectId: opts.project });

  console.log('\nToken Budget');
  console.log('─'.repeat(40));

  if (result.limit === null) {
    console.log('No budget set (unlimited).');
    console.log(`Used: ${result.used.toLocaleString()} tokens`);
  } else {
    const bar = '█'.repeat(Math.floor(result.percentUsed / 5)) +
                '░'.repeat(20 - Math.floor(result.percentUsed / 5));
    console.log(`[${bar}] ${result.percentUsed}%`);
    console.log(`Used:      ${result.used.toLocaleString()} / ${result.limit.toLocaleString()} tokens`);
    console.log(`Remaining: ${(result.remaining ?? 0).toLocaleString()} tokens`);
    console.log(`Status:    ${result.allowed ? '✓ OK' : '✗ Budget exceeded'}`);
  }
  console.log('');
}
