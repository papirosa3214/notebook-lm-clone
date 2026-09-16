import { useEffect, useState } from 'react';

type Health = { ok: boolean; ragflow: string; service: string; version: string };

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [datasets, setDatasets] = useState<Array<{ id: string; name: string; document_count: number; chunk_count: number }>>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const h = await fetch('/api/health').then((r) => r.json());
        setHealth(h);
        const d = await fetch('/api/ragflow/datasets').then((r) => r.json());
        setDatasets(d.datasets ?? []);
      } catch (e) {
        setError(String(e));
      }
    })();
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 720, margin: '40px auto', padding: 24 }}>
      <h1>NotebookLM Clone — MVP</h1>
      <p>Этап 0: bootstrap готов. Дальше — источники, чат, артефакты.</p>

      <section style={{ marginTop: 24, padding: 16, border: '1px solid #ddd', borderRadius: 8 }}>
        <h2>API health</h2>
        {error && <p style={{ color: 'crimson' }}>error: {error}</p>}
        {health ? (
          <pre style={{ background: '#f5f5f5', padding: 12, borderRadius: 6 }}>
{JSON.stringify(health, null, 2)}
          </pre>
        ) : (
          <p>проверяю...</p>
        )}
      </section>

      <section style={{ marginTop: 24, padding: 16, border: '1px solid #ddd', borderRadius: 8 }}>
        <h2>Ragflow datasets на .110</h2>
        {datasets.length === 0 ? (
          <p>нет датасетов (или API ещё не ответил)</p>
        ) : (
          <ul>
            {datasets.map((d) => (
              <li key={d.id}>
                <strong>{d.name}</strong> — {d.document_count} docs, {d.chunk_count} chunks
                <br />
                <code style={{ fontSize: 12, color: '#666' }}>{d.id}</code>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
