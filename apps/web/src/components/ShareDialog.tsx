import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import type { NotebookShare } from '@notebook/shared';

interface Props {
  notebookId: string;
  onClose: () => void;
}

/**
 * Sharing dialog. Two states:
 *  - not shared: «Поделиться» button → POST /share → switches to
 *    the "shared" view with copy-to-clipboard.
 *  - shared: shows the URL, a copy button, and a «Закрыть доступ»
 *    button which DELETEs the share and clears the state.
 *
 * The URL we display comes straight from the API (which knows about
 * PUBLIC_BASE_URL). Users always copy the absolute URL the API
 * produced — no client-side string mangling.
 */
export function ShareDialog({ notebookId, onClose }: Props) {
  const qc = useQueryClient();
  const shareQ = useQuery({
    queryKey: ['share', notebookId],
    queryFn: () => api.getShare(notebookId),
  });
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enable() {
    setError(null);
    try {
      await api.enableShare(notebookId);
      await qc.invalidateQueries({ queryKey: ['share', notebookId] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function revoke() {
    setError(null);
    try {
      await api.revokeShare(notebookId);
      setCopied(false);
      await qc.invalidateQueries({ queryKey: ['share', notebookId] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function copy(url: string) {
    setError(null);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      setError(`Не удалось скопировать: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const state: NotebookShare | undefined = shareQ.data;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-label="Share notebook"
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-2xl border bg-surface shadow-soft"
        style={{ borderColor: 'rgb(var(--nb-border))' }}
      >
        <header
          className="flex items-center justify-between border-b px-5 py-3"
          style={{ borderColor: 'rgb(var(--nb-border))' }}
        >
          <div>
            <h2 className="text-base font-semibold">Поделиться ноутбуком</h2>
            <p className="text-xs text-muted">
              Read-only ссылка. Без чата и без добавления источников.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="btn-icon"
            title="Закрыть"
            aria-label="Закрыть"
          >
            ✕
          </button>
        </header>

        <div className="space-y-4 px-5 py-4">
          {shareQ.isLoading && (
            <p className="text-sm text-muted">Загружаю состояние…</p>
          )}

          {state && !state.enabled && (
            <div className="space-y-3">
              <p className="text-sm text-muted">
                Публичная ссылка даёт доступ к заголовкам источников,
                их саммари и preview артефактов. Чат и содержимое
                чанков не показываются.
              </p>
              <button
                type="button"
                onClick={enable}
                className="btn btn-primary w-full"
                data-testid="share-enable"
              >
                Создать ссылку
              </button>
            </div>
          )}

          {state && state.enabled && state.shareUrl && (
            <div className="space-y-3">
              <p className="text-xs text-muted">
                Включено с {formatTime(state.shareEnabledAt)}. Любой, у кого
                есть ссылка, увидит read-only snapshot.
              </p>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  className="input flex-1 font-mono text-xs"
                  value={state.shareUrl}
                  onFocus={(e) => e.currentTarget.select()}
                  data-testid="share-url"
                />
                <button
                  type="button"
                  onClick={() => copy(state.shareUrl!)}
                  className="btn btn-secondary shrink-0"
                  data-testid="share-copy"
                >
                  {copied ? 'Скопировано' : 'Копировать'}
                </button>
              </div>
              <button
                type="button"
                onClick={revoke}
                className="btn btn-secondary w-full"
                data-testid="share-revoke"
              >
                Закрыть доступ
              </button>
              <p className="text-[11px] text-muted">
                После закрытия ссылка перестанет работать. Можно создать
                новую — со свежим токеном.
              </p>
            </div>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex justify-end pt-2">
            <button type="button" onClick={onClose} className="btn btn-secondary">
              Готово
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
