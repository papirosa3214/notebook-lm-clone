import { config } from '../config.js';
import type { ChatStreamEvent, LLMProvider, ProviderChatRequest } from '@notebook/shared/providers';

export class OllamaProvider implements LLMProvider {
  readonly id = 'ollama' as const;
  readonly defaultModel = 'qwen3.6-27b-iq4-16k:latest';

  async listModels(): Promise<string[]> {
    const res = await fetch(`${config.OLLAMA_BASE_URL}/api/tags`);
    if (!res.ok) return [this.defaultModel];
    const body = (await res.json()) as { models: Array<{ name: string }> };
    return body.models?.map((m) => m.name) ?? [];
  }

  async *chat(req: ProviderChatRequest): AsyncIterable<ChatStreamEvent> {
    // Map to Ollama chat API; system prompt goes in as a system message
    const messages = req.messages.map((m) => ({ role: m.role, content: m.content }));
    const body = JSON.stringify({
      model: req.model,
      messages,
      stream: true,
      // Disable "thinking" chain on qwen3.x models — without it qwen3.6-27b
      // spends ~25s of internal reasoning before any visible token. See
      // /Users/max/.hermes/memory for the user's rule about this.
      think: false,
      options: {
        temperature: req.temperature ?? 0.2,
        num_predict: req.maxTokens ?? 1024,
      },
    });
    const res = await fetch(`${config.OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (!res.ok || !res.body) {
      throw new Error(`ollama http ${res.status}: ${await res.text()}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          const text = obj.message?.content;
          if (text) yield { text };
          if (obj.done) {
            yield { done: true };
            return;
          }
        } catch {
          // skip malformed chunk
        }
      }
    }
  }
}
