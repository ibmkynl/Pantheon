import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const DEFAULT_TEMPLATE = `ai:
  default_provider: "{{PROVIDER}}"

  providers:
    {{PROVIDER}}:
      api_key: "{{KEY}}"

  models:
    router:     "claude-haiku-4-5-20251001"
    core:       "claude-sonnet-4-6"
    specialist: "claude-opus-4-7"
    btw:        "claude-haiku-4-5-20251001"

mcp:
  port: 3100
  host: "localhost"

orchestrator:
  port: 3101
  host: "localhost"

limits:
  max_tokens_per_session: 500000
  max_revision_loops: 2
  max_parallel_specialists: 3
`;

const PROVIDER_HINTS: Record<string, { name: string; keyPrefix: string; signupUrl: string }> = {
  anthropic: { name: 'Anthropic',     keyPrefix: 'sk-ant-',  signupUrl: 'https://console.anthropic.com/settings/keys' },
  openai:    { name: 'OpenAI',        keyPrefix: 'sk-',      signupUrl: 'https://platform.openai.com/api-keys' },
  google:    { name: 'Google Gemini', keyPrefix: 'AIza',     signupUrl: 'https://aistudio.google.com/apikey' },
};

function pantheonHome(): string {
  return process.env['PANTHEON_HOME'] || path.join(os.homedir(), '.pantheon');
}

function configPath(): string {
  if (process.env['PANTHEON_CONFIG']) return process.env['PANTHEON_CONFIG'];
  const cwdLocal = path.resolve(process.cwd(), 'pantheon.yaml');
  if (fs.existsSync(cwdLocal)) return cwdLocal;
  return path.join(pantheonHome(), 'pantheon.yaml');
}

function hasUsableKey(p: string): boolean {
  if (!fs.existsSync(p)) return false;
  const text = fs.readFileSync(p, 'utf-8');
  if (text.includes('YOUR_API_KEY_HERE')) return false;
  if (text.includes('"sk-ant-..."') || text.includes('"sk-openai-..."') || text.includes('"AIza..."')) return false;
  return /api_key:\s*"[^"]+"/.test(text);
}

export async function ensureSetup(): Promise<boolean> {
  const cfgPath = configPath();
  if (hasUsableKey(cfgPath)) return true;
  return runSetupWizard(cfgPath, false);
}

export async function runSetup(): Promise<boolean> {
  const cfgPath = configPath();
  return runSetupWizard(cfgPath, true);
}

async function runSetupWizard(cfgPath: string, force: boolean): Promise<boolean> {
  const existing = hasUsableKey(cfgPath);

  process.stdout.write('\n  Pantheon — Provider Setup\n');
  process.stdout.write('  ─────────────────────────\n\n');
  if (existing && force) {
    process.stdout.write(`  Current config: ${cfgPath}\n`);
    process.stdout.write('  Choose a provider to update:\n\n');
  } else {
    process.stdout.write('  No API key configured yet. Let\'s set one up.\n\n');
    process.stdout.write('  Choose a provider:\n');
  }
  process.stdout.write('    1) Anthropic   (Claude)  — console.anthropic.com/settings/keys\n');
  process.stdout.write('    2) OpenAI      (GPT)     — platform.openai.com/api-keys\n');
  process.stdout.write('    3) Google      (Gemini)  — aistudio.google.com/apikey\n');
  process.stdout.write('    4) Skip        (edit config manually)\n\n');

  const rl = readline.createInterface({ input, output });
  try {
    const choice = (await rl.question('  Selection [1]: ')).trim() || '1';
    const provider =
      choice === '2' ? 'openai' :
      choice === '3' ? 'google' :
      choice === '4' ? null    :
                       'anthropic';

    if (!provider) {
      const cfgDir = path.dirname(cfgPath);
      fs.mkdirSync(cfgDir, { recursive: true });
      if (!fs.existsSync(cfgPath)) {
        const stub = DEFAULT_TEMPLATE.replace(/{{PROVIDER}}/g, 'anthropic').replace('{{KEY}}', 'YOUR_API_KEY_HERE');
        fs.writeFileSync(cfgPath, stub);
      }
      process.stdout.write(`\n  Edit ${cfgPath} to add your API key, then run 'pantheon' again.\n\n`);
      return false;
    }

    const hint = PROVIDER_HINTS[provider]!;
    const key = (await rl.question(`  Paste your ${hint.name} API key: `)).trim();

    if (!key || !key.startsWith(hint.keyPrefix)) {
      process.stdout.write(`\n  That doesn't look like a ${hint.name} key (expected prefix "${hint.keyPrefix}"). Try again.\n\n`);
      return false;
    }
    if (provider === 'openai' && key.startsWith('sk-ant-')) {
      process.stdout.write(`\n  That looks like an Anthropic key, not OpenAI. Pick option 1 instead.\n\n`);
      return false;
    }

    const cfgDir = path.dirname(cfgPath);
    fs.mkdirSync(cfgDir, { recursive: true });
    const yaml = DEFAULT_TEMPLATE.replace(/{{PROVIDER}}/g, provider).replace('{{KEY}}', key);
    fs.writeFileSync(cfgPath, yaml, { mode: 0o600 });

    process.stdout.write(`\n  ✓ Saved to ${cfgPath}\n`);
    if (!force) process.stdout.write('  Starting Pantheon…\n\n');
    return true;
  } finally {
    rl.close();
  }
}
