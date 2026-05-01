import type { Config } from '../config.js';
import type { LLMProvider, AgentModelSpec, ModelSpec } from './types.js';
import { createAnthropicProvider } from './anthropic-provider.js';
import { createOpenAIProvider }   from './openai-provider.js';
import { createGoogleProvider }   from './google-provider.js';

// Cache provider instances
const _providers = new Map<string, LLMProvider>();

export function getProvider(name: string, config: Config): LLMProvider {
  if (_providers.has(name)) return _providers.get(name)!;

  const providerCfg = config.ai.providers?.[name];
  let provider: LLMProvider;

  switch (name) {
    case 'anthropic': {
      const key     = providerCfg?.api_key ?? config.ai.api_key ?? '';
      const baseUrl = providerCfg?.base_url ?? config.ai.base_url;
      provider = createAnthropicProvider(key, baseUrl);
      break;
    }
    case 'openai': {
      if (!providerCfg?.api_key) throw new Error('No api_key for openai provider in pantheon.yaml');
      provider = createOpenAIProvider(providerCfg.api_key, providerCfg.base_url);
      break;
    }
    case 'google': {
      if (!providerCfg?.api_key) throw new Error('No api_key for google provider in pantheon.yaml');
      provider = createGoogleProvider(providerCfg.api_key);
      break;
    }
    case 'litellm': {
      // LiteLLM exposes an OpenAI-compatible API
      if (!providerCfg?.base_url) throw new Error('No base_url for litellm provider in pantheon.yaml');
      provider = createOpenAIProvider(providerCfg.api_key ?? 'litellm', providerCfg.base_url);
      break;
    }
    default:
      throw new Error(`Unknown provider "${name}". Supported: anthropic, openai, google, litellm`);
  }

  _providers.set(name, provider);
  return provider;
}

export function resetProviders(): void {
  _providers.clear();
}

// Parse "provider:model", "model", or "cross-check:p1:m1,p2:m2"
export function parseAgentModelSpec(raw: string, defaultProvider: string): AgentModelSpec {
  if (raw.startsWith('cross-check:')) {
    const targets = raw.slice('cross-check:'.length).split(',').map(part => parseModelSpec(part.trim(), defaultProvider));
    return { kind: 'cross-check', specs: targets };
  }
  return { kind: 'single', spec: parseModelSpec(raw, defaultProvider) };
}

function parseModelSpec(raw: string, defaultProvider: string): ModelSpec {
  const colonIdx = raw.indexOf(':');
  if (colonIdx === -1) return { provider: defaultProvider, model: raw };
  return { provider: raw.slice(0, colonIdx), model: raw.slice(colonIdx + 1) };
}

// Resolve which provider + model to use for a given agent
export function resolveAgentModel(
  agentName: string,
  tier: string,
  config: Config,
): AgentModelSpec {
  const defaultProvider = config.ai.default_provider ?? config.ai.provider ?? 'anthropic';

  // Check per-agent override
  const agentOverride = config.ai.agent_models?.[agentName];
  if (agentOverride) return parseAgentModelSpec(agentOverride, defaultProvider);

  // Fall back to tier defaults
  const { models } = config.ai;
  let model: string;
  if (tier === 'router-tier')          model = models.router;
  else if (agentName === 'btw-agent')  model = models.btw;
  else if (tier === 'core-tier')       model = models.core;
  else                                  model = models.specialist;

  return { kind: 'single', spec: { provider: defaultProvider, model } };
}
