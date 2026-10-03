import { useMemo, useState } from 'react';
import type { DataTable } from '@notebook/shared';

interface Props {
  /**
   * Either a parsed DataTable (preferred) or a JSON string (legacy /
   * shared view). The component parses lazily and shows an empty-state
   * placeholder on failure.
   */
  data: DataTable | string;
}

type SortDir = 'asc' | 'desc';

/**
 * Render a Studio-generated DataTable with two interactions:
 *
 *  - Click a column header to sort by that column. Click again to
 *    flip the direction.
 *  - Type into the search box to filter rows by case-insensitive
 *    substring across all cells.
 *
 * No virtualisation: DataTable is capped at 500 rows server-side
 * and the UI degrades gracefully via `overflow-x-auto` on the table
 * container so wide tables scroll horizontally on narrow screens.
 */
export function DataTableView({ data }: Props) {
  const table = useMemo<DataTable | null>(() => {
    if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data) as unknown;
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'columns' in parsed &&
          'rows' in parsed &&
          Array.isArray((parsed as { columns: unknown }).columns) &&
          Array.isArray((parsed as { rows: unknown }).rows)
        ) {
          return parsed as DataTable;
        }
        return null;
      } catch {
        return null;
      }
    }
    return data;
  }, [data]);

  const [filter, setFilter] = useState('');
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  if (!table || table.columns.length === 0) {
    return (
      <div
        className="rounded-2xl border bg-canvas p-6 text-sm text-muted"
        style={{ borderColor: 'rgb(var(--nb-border))' }}
        data-testid="data-table-empty"
      >
        Таблица пуста или повреждена.
      </div>
    );
  }

  const normalisedFilter = filter.trim().toLocaleLowerCase('ru-RU');

  const filteredRows = useMemo(() => {
    if (!normalisedFilter) return table.rows;
    return table.rows.filter((row) => {
      for (const col of table.columns) {
        const v = row[col];
        if (typeof v === 'string' && v.toLocaleLowerCase('ru-RU').includes(normalisedFilter)) {
          return true;
        }
      }
      return false;
    });
  }, [table.rows, table.columns, normalisedFilter]);

  const sortedRows = useMemo(() => {
    if (!sortCol) return filteredRows;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filteredRows].sort((a, b) => {
      const av = a[sortCol] ?? '';
      const bv = b[sortCol] ?? '';
      if (av === bv) return 0;
      return av < bv ? -1 * dir : 1 * dir;
    });
  }, [filteredRows, sortCol, sortDir]);

  function onHeaderClick(col: string) {
    if (sortCol === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  }

  return (
    <div className="space-y-3" data-testid="data-table-view">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          {table.title && (
            <h3 className="text-base font-semibold">{table.title}</h3>
          )}
          <p className="text-xs text-muted">
            {table.columns.length} {pluralColumn(table.columns.length)} ·{' '}
            {filteredRows.length} из {table.rows.length} строк
            {sortCol && (
              <>
                {' · '}
                <button
                  type="button"
                  onClick={() => {
                    setSortCol(null);
                    setSortDir('asc');
                  }}
                  className="text-accent hover:underline"
                >
                  сбросить сортировку
                </button>
              </>
            )}
          </p>
        </div>
        <input
          type="search"
          className="input w-full max-w-xs text-sm"
          placeholder="Фильтр по содержимому…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          data-testid="data-table-filter"
        />
      </header>

      <div className="overflow-x-auto rounded-2xl border"
        style={{ borderColor: 'rgb(var(--nb-border))' }}
      >
        <table className="w-full text-sm" data-testid="data-table">
          <thead>
            <tr className="bg-surface-tint text-left">
              {table.columns.map((col) => (
                <th
                  key={col}
                  className="cursor-pointer select-none whitespace-nowrap px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted hover:text-ink"
                  onClick={() => onHeaderClick(col)}
                  data-testid={`data-table-th-${col}`}
                  aria-sort={sortCol === col ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  <span className="inline-flex items-center gap-1">
                    {col}
                    {sortCol === col && (
                      <span aria-hidden>{sortDir === 'asc' ? '▲' : '▼'}</span>
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.length === 0 ? (
              <tr>
                <td
                  colSpan={table.columns.length}
                  className="px-3 py-6 text-center text-sm text-muted"
                >
                  Нет строк, удовлетворяющих фильтру.
                </td>
              </tr>
            ) : (
              sortedRows.map((row, i) => (
                <tr
                  key={i}
                  className="border-t"
                  style={{ borderColor: 'rgb(var(--nb-border))' }}
                >
                  {table.columns.map((col) => (
                    <td
                      key={col}
                      className="whitespace-pre-wrap px-3 py-2 align-top text-ink"
                    >
                      {row[col] ?? ''}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function pluralColumn(n: number): string {
  // русское склонение: 1 столбец, 2-4 столбца, 5+ столбцов
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'столбец';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'столбца';
  return 'столбцов';
}
