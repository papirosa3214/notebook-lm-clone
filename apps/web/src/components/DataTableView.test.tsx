// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DataTableView } from './DataTableView';
import type { DataTable } from '@notebook/shared';

const TABLE: DataTable = {
  title: 'Сравнение',
  columns: ['Протокол', 'Год', 'Назначение'],
  rows: [
    { Протокол: 'A2A', Год: '2025', Назначение: 'межагентное' },
    { Протокол: 'MCP', Год: '2024', Назначение: 'инструменты' },
    { Протокол: 'ANP', Год: '2024', Назначение: 'межагентное' },
  ],
};

afterEach(cleanup);

describe('DataTableView', () => {
  it('renders the title, column headers, and all rows by default', () => {
    render(<DataTableView data={TABLE} />);
    const view = screen.getByTestId('data-table-view');
    expect(within(view).getByText('Сравнение')).toBeInTheDocument();
    expect(within(view).getByText('Протокол')).toBeInTheDocument();
    expect(within(view).getByText('Год')).toBeInTheDocument();
    expect(within(view).getByText('Назначение')).toBeInTheDocument();
    // 3 data rows + 1 header row.
    const trs = view.querySelectorAll('tbody tr');
    expect(trs).toHaveLength(3);
    expect(trs[0]!.textContent).toContain('A2A');
    expect(trs[2]!.textContent).toContain('ANP');
  });

  it('sorts by column when header is clicked; flips direction on second click', () => {
    render(<DataTableView data={TABLE} />);
    const view = screen.getByTestId('data-table-view');
    const protoHeader = within(view).getByTestId('data-table-th-Протокол');
    fireEvent.click(protoHeader);
    let trs = view.querySelectorAll('tbody tr');
    // ascending: A2A, ANP, MCP
    expect(trs[0]!.textContent).toContain('A2A');
    expect(trs[1]!.textContent).toContain('ANP');
    expect(trs[2]!.textContent).toContain('MCP');
    expect(protoHeader.getAttribute('aria-sort')).toBe('ascending');
    // Click again → descending
    fireEvent.click(protoHeader);
    trs = view.querySelectorAll('tbody tr');
    expect(trs[0]!.textContent).toContain('MCP');
    expect(trs[2]!.textContent).toContain('A2A');
    expect(protoHeader.getAttribute('aria-sort')).toBe('descending');
  });

  it('filters rows by case-insensitive substring across all cells', () => {
    render(<DataTableView data={TABLE} />);
    const view = screen.getByTestId('data-table-view');
    const filter = within(view).getByTestId('data-table-filter');
    fireEvent.change(filter, { target: { value: 'межагентное' } });
    const trs = view.querySelectorAll('tbody tr');
    expect(trs).toHaveLength(2);
    expect(trs[0]!.textContent).toContain('A2A');
    expect(trs[1]!.textContent).toContain('ANP');
  });

  it('shows an empty-state row when no rows match the filter', () => {
    render(<DataTableView data={TABLE} />);
    const view = screen.getByTestId('data-table-view');
    const filter = within(view).getByTestId('data-table-filter');
    fireEvent.change(filter, { target: { value: 'нет-такого-токена' } });
    const trs = view.querySelectorAll('tbody tr');
    expect(trs).toHaveLength(1);
    expect(trs[0]!.textContent).toContain('Нет строк');
  });

  it('parses a JSON-string body (legacy / shared view)', () => {
    render(<DataTableView data={JSON.stringify(TABLE)} />);
    const view = screen.getByTestId('data-table-view');
    expect(within(view).getByText('A2A')).toBeInTheDocument();
  });

  it('shows an empty placeholder for invalid JSON', () => {
    render(<DataTableView data="not a json" />);
    expect(screen.getByTestId('data-table-empty')).toBeInTheDocument();
  });

  it('clears the sort when the "сбросить сортировку" link is clicked', () => {
    render(<DataTableView data={TABLE} />);
    const view = screen.getByTestId('data-table-view');
    fireEvent.click(within(view).getByTestId('data-table-th-Протокол'));
    expect(within(view).getByTestId('data-table-th-Протокол').getAttribute('aria-sort')).toBe('ascending');
    // The "сбросить сортировку" button appears once a sort is active.
    const reset = within(view).getByText('сбросить сортировку');
    fireEvent.click(reset);
    expect(within(view).getByTestId('data-table-th-Протокол').getAttribute('aria-sort')).toBe('none');
  });
});
