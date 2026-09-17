import { config } from '../config.js';
import type { ChatStreamEvent, LLMProvider, ProviderChatRequest } from '@notebook/shared/providers';

export class OllamaProvider implements LLMProvider {
  readonly id = 'ollama' as const;
  readonly defaultModel = 'coder30b-abl:latest';

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
      // Keep the model in VRAM between requests so the next chat/summary
      // turn isn't a 10-20s cold load from disk. Default Ollama keep_alive
      // is 5m; bump to 30m so a coffee break doesn't drop the model.
      keep_alive: '30m',
      options: {
        temperature: req.temperature ?? 0.2,
        num_predict: req.maxTokens ?? 1024,
        // coder30b-abl advertises a 262144-token native context. Without a
        // cap the KV cache alone would consume ~25 GB at fp16 (head_count 32,
        // head_count_kv 4, key_length 128, 48 layers → 96 KB/token). But
        // Ollama 0.32.4+ auto-quantises KV to Q8 (general.quantization_version=2),
        // so 16k KV costs ~0.8 GB instead of ~1.5 GB. The full chat model is
        // 12.98 GB and bge-m3-embed is 0.88 GB — together ~14.7 GB, fits
        // comfortably in 16 GB with headroom. 16k is plenty for retrieval-
        // augmented chat + summary in this app.
        num_ctx: 16384,
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
