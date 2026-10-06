import { config } from '../config.js';
import type { ChatStreamEvent, LLMProvider, ProviderChatRequest } from '@notebook/shared/providers';

/**
 * MiniMax provider.
 *
 * Использует Anthropic-совместимое API проксирование (`https://api.minimax.io/anthropic`).
 * Протокол потока — такой же SSE, как у Anthropic (`event: content_block_delta` →
 * `data.delta.text`, `event: message_stop` → конец). Поэтому класс почти копия
 * AnthropicProvider, отличия только в URL, идентификаторе и моделях.
 *
 * Ключ берётся из env `MINIMAX_API_KEY`. Если не задан — провайдер бросает
 * ошибку при первом вызове chat() (так же, как Anthropic/OpenAI).
 */
export class MiniMaxProvider implements LLMProvider {
  readonly id = 'minimax' as const;
  // MiniMax-M3 — флагман (см. ~/bin/claude-minimax).
  readonly defaultModel = 'MiniMax-M3';

  async listModels(): Promise<string[]> {
    return [
      'MiniMax-M3',
      'MiniMax-M2.7',
      'MiniMax-M2.7-highspeed',
    ];
  }

  async *chat(req: ProviderChatRequest): AsyncIterable<ChatStreamEvent> {
    if (!config.MINIMAX_API_KEY) {
      throw new Error('MINIMAX_API_KEY not set');
    }
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

    // MINIMAX_BASE_URL по умолчанию уже включает `/anthropic`, добавляем только `/v1/messages`.
    const url = `${config.MINIMAX_BASE_URL.replace(/\/$/, '')}/v1/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.MINIMAX_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body,
    });
    if (!res.ok || !res.body) {
      throw new Error(`minimax http ${res.status}: ${await res.text()}`);
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
        const dataLines = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim());
        if (!dataLines.length) continue;
        const dataStr = dataLines.join('\n');
        try {
          const data = JSON.parse(dataStr);
          if (eventMatch?.[1] === 'content_block_delta') {
            // MiniMax может вернуть thinking-блок первым; нам нужен только текст.
            const text = data.delta?.text;
            if (text) yield { text };
          } else if (eventMatch?.[1] === 'message_stop') {
            yield { done: true };
            return;
          }
        } catch {
          // skip malformed event — MiniMax может слать неожиданные пустые события
        }
      }
    }
  }
}