import { createInterface } from 'node:readline';
import { orchestratorUrl } from '../config.js';
import { post } from '../http.js';

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, answer => resolve(answer.trim())));
}

const TIER_OPTIONS = ['specialist-tier', 'core-tier', 'router-tier'] as const;
type Tier = typeof TIER_OPTIONS[number];

export async function cmdForge(opts: { name?: string; tier?: string; description?: string }) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log('\nPantheon Forge — create a new agent\n' + '─'.repeat(50));

    const name = opts.name
      ?? await prompt(rl, 'Agent name (snake-case, e.g. "data-analyst"): ');

    if (!/^[a-z0-9-]+$/.test(name)) {
      console.error('✗ Agent name must be lowercase alphanumeric + hyphens only.');
      process.exit(1);
    }

    let tier: Tier = 'specialist-tier';
    if (opts.tier) {
      if (!TIER_OPTIONS.includes(opts.tier as Tier)) {
        console.error(`✗ Invalid tier "${opts.tier}". Choose: ${TIER_OPTIONS.join(', ')}`);
        process.exit(1);
      }
      tier = opts.tier as Tier;
    } else {
      const tierInput = await prompt(
        rl,
        `Tier [specialist-tier / core-tier / router-tier] (default: specialist-tier): `
      );
      if (tierInput && TIER_OPTIONS.includes(tierInput as Tier)) {
        tier = tierInput as Tier;
      }
    }

    const description = opts.description
      ?? await prompt(rl, 'Describe what this agent does (be specific):\n> ');

    if (description.length < 10) {
      console.error('✗ Description too short. Please describe the agent in at least 10 characters.');
      process.exit(1);
    }

    console.log(`\n⟳  Forging agent "${name}" (${tier}) via Prometheus…\n`);

    const result = await post<{ name: string; tier: string; output: string }>(
      orchestratorUrl('/forge'),
      { name, tier, description }
    );

    console.log('─'.repeat(50));
    console.log(`✓  Agent created: agents/${result.tier}/${result.name}.md`);
    console.log('─'.repeat(50));
    if (result.output) {
      console.log('\nPrometheus output:\n');
      console.log(result.output);
    }
    console.log(`\nRun it with: pantheon run --agent ${result.name} "your task"`);
    console.log(`List all agents: pantheon agents list\n`);
  } catch (err) {
    console.error('Error:', String(err));
    process.exit(1);
  } finally {
    rl.close();
  }
}
