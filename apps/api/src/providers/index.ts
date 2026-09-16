import type { LLMProvider, ProviderId } from '@notebook/shared/providers';
import { OllamaProvider } from './ollama.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';

const registry: Record<ProviderId, LLMProvider> = {
  ollama: new OllamaProvider(),
  anthropic: new AnthropicProvider(),
  openai: new OpenAIProvider(),
};

export function getProvider(id: ProviderId): LLMProvider {
  const p = registry[id];
  if (!p) throw new Error(`unknown provider: ${id}`);
  return p;
}

export function listProviders(): ProviderId[] {
  return Object.keys(registry) as ProviderId[];
}
