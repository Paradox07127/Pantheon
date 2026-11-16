import { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { VisualContent } from '@pantheon/domain';
import { currentLocale } from '../../i18n';
import './table-visual.css';

export type TableSpec = Extract<VisualContent, { kind: 'table' }>['spec'];
type Column = TableSpec['columns'][number];
type Row = TableSpec['rows'][number];
type Sort = NonNullable<TableSpec['sort']>;
type Value = string | number | null;

const cellOf = (row: Row, key: string): Value => row[key] ?? null;

const time = (value: string | number) => new Date(value).getTime();

function compare(type: Column['type'], a: string | number, b: string | number): number {
  if (type === 'number') return Number(a) - Number(b);
  if (type === 'date') return time(a) - time(b);
  return String(a).localeCompare(String(b), currentLocale());
}

/** The rows in this order; a missing value goes last either way. */
function sortRows(rows: readonly Row[], columns: readonly Column[], sort: Sort | null): Row[] {
  const column = sort && columns.find((c) => c.key === sort.key);
  if (!sort || !column) return [...rows];
  const sign = sort.direction === 'asc' ? 1 : -1;
  return [...rows].sort((x, y) => {
    const a = cellOf(x, sort.key);
    const b = cellOf(y, sort.key);
    if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
    return sign * compare(column.type, a, b);
  });
}

const CELL_CLASS: Record<Column['type'], string> = {
  text: 'vis-td',
  number: 'vis-td vis-num',
  date: 'vis-td vis-date',
};

const TRACK: Record<Column['type'], string> = {
  text: 'minmax(0, 2fr)',
  number: 'minmax(64px, 1fr)',
  date: 'minmax(96px, 1fr)',
};

/**
 * A table sorted from its header: up, down, then back to the spec's own order. Its body scrolls
 * under the header inside the card.
 */
export function TableVisual({ spec }: { spec: TableSpec }) {
  // The sort picked in the header, over the spec's own; it stays in the interface.
  const [picked, setPicked] = useState<Sort | null>(null);
  const sort = picked ?? spec.sort ?? null;
  const rows = useMemo(() => sortRows(spec.rows, spec.columns, sort), [spec, sort]);
  const locale = currentLocale();
  const text = useMemo(() => {
    const number = new Intl.NumberFormat(locale);
    const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
    // A day without a time parses as UTC midnight, which is the day before west of UTC.
    const day = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
    return (type: Column['type'], value: Value): string => {
      if (value === null) return '';
      if (type === 'number' && typeof value === 'number') return number.format(value);
      if (type === 'date' && !Number.isNaN(time(value)))
        return (String(value).length === 10 ? day : date).format(time(value));
      return String(value);
    };
  }, [locale]);
  const columns = { gridTemplateColumns: spec.columns.map((c) => TRACK[c.type]).join(' ') };
  const next = (key: string) =>
    setPicked(
      picked?.key !== key
        ? { key, direction: 'asc' }
        : picked.direction === 'asc'
          ? { key, direction: 'desc' }
          : null,
    );
  return (
    <div className="vis-tb" role="table">
      <div className="vis-tr vis-th" role="row" style={columns}>
        {spec.columns.map((c) => (
          <span
            key={c.key}
            role="columnheader"
            aria-sort={
              sort?.key !== c.key ? 'none' : sort.direction === 'asc' ? 'ascending' : 'descending'
            }
            data-type={c.type}
          >
            <button type="button" onClick={() => next(c.key)}>
              {c.title}
              <ChevronDown aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
      {rows.map((row, i) => (
        <div key={i} className="vis-tr" role="row" style={columns}>
          {spec.columns.map((c) => (
            <span key={c.key} className={CELL_CLASS[c.type]} role="cell">
              {text(c.type, cellOf(row, c.key))}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
