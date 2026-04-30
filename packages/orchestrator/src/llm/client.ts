import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from '../config.js';

let _client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (_client) return _client;
  const config = getConfig();
  _client = new Anthropic({
    apiKey:  config.ai.api_key,
    baseURL: config.ai.base_url,
  });
  return _client;
}
