import { config } from '../config.js';
import type { ChatStreamEvent, LLMProvider, ProviderChatRequest } from '@notebook/shared/providers';

export class OpenAIProvider implements LLMProvider {
  readonly id = 'openai' as const;
  readonly defaultModel = 'gpt-4o';

  async listModels(): Promise<string[]> {
    return ['gpt-4o', 'gpt-4o-mini', 'gpt-5', 'o1', 'o1-mini'];
  }

  async *chat(req: ProviderChatRequest): AsyncIterable<ChatStreamEvent> {
    if (!config.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY not set');
    }
    const body = JSON.stringify({
      model: req.model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: req.temperature ?? 0.2,
      max_tokens: req.maxTokens ?? 1024,
      stream: true,
    });
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.OPENAI_API_KEY}`,
      },
      body,
    });
    if (!res.ok || !res.body) {
      throw new Error(`openai http ${res.status}: ${await res.text()}`);
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
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          yield { done: true };
          return;
        }
        try {
          const obj = JSON.parse(data);
          const text = obj.choices?.[0]?.delta?.content;
          if (text) yield { text };
        } catch {
          // skip
        }
      }
    }
  }
}
