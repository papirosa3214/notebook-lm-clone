import { config } from '../config.js';
import type { ChatStreamEvent, LLMProvider, ProviderChatRequest } from '@notebook/shared/providers';

export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic' as const;
  readonly defaultModel = 'claude-sonnet-4-5';

  async listModels(): Promise<string[]> {
    return [
      'claude-sonnet-4-5',
      'claude-opus-4-1',
      'claude-haiku-4-5',
    ];
  }

  async *chat(req: ProviderChatRequest): AsyncIterable<ChatStreamEvent> {
    if (!config.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not set');
    }
    // Extract system message (Anthropic takes it as a separate field)
    const systemMsg = req.messages.find((m) => m.role === 'system');
    const restMessages = req.messages.filter((m) => m.role !== 'system');

    const body = JSON.stringify({
      model: req.model,
      max_tokens: req.maxTokens ?? 1024,
      temperature: req.temperature ?? 0.2,
      system: systemMsg?.content,
      messages: restMessages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    });
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body,
    });
    if (!res.ok || !res.body) {
      throw new Error(`anthropic http ${res.status}: ${await res.text()}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let ev: number;
      while ((ev = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, ev);
        buf = buf.slice(ev + 2);
        const eventMatch = block.match(/^event:\s*(\S+)/m);
        const dataLines = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
        if (!dataLines.length) continue;
        const dataStr = dataLines.join('\n');
        try {
          const data = JSON.parse(dataStr);
          if (eventMatch?.[1] === 'content_block_delta') {
            const text = data.delta?.text;
            if (text) yield { text };
          } else if (eventMatch?.[1] === 'message_stop') {
            yield { done: true };
            return;
          }
        } catch {
          // skip
        }
      }
    }
  }
}
