import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChartColumn, Table2 } from 'lucide-react';
import { t } from '../i18n';
import { EmptyState } from './EmptyState';
import './chart-parts.css';

export function Empty({ text }: { text: string }) {
  return <EmptyState inline title={text} />;
}

/** Tracks an element's content box; pass the setter as the element's ref. */
export function useSize() {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [setEl, size] as const;
}

export interface TipRow {
  label: string;
  value: string;
  swatch?: ReactNode;
}
export interface TipContent {
  head?: string;
  rows: TipRow[];
}

function FloatTip({
  id,
  x,
  y,
  content,
}: {
  id: string;
  x: number;
  y: number;
  content: TipContent;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x + 14, top: y + 14 });
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    let left = x + 14;
    let top = y + 14;
    if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
    if (top + r.height > window.innerHeight - 8) top = y - r.height - 14;
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [x, y, content]);
  return createPortal(
    <div ref={ref} id={id} className="bp-tip" role="tooltip" style={pos}>
      {content.head && <div className="h">{content.head}</div>}
      {content.rows.map((row, i) => (
        <div className="r" key={i}>
          {row.swatch}
          <span className="k">{row.label}</span>
          <span className="v">{row.value}</span>
        </div>
      ))}
    </div>,
    document.body,
  );
}

let tipSeq = 0;

/** Pass `owner` to `show` so the trigger can point `aria-describedby` at the tip via `describedBy`. */
export function useFloatTip() {
  // Not useId: chart tests drive this hook without a React renderer.
  const [id] = useState(() => `bp-tip-${++tipSeq}`);
  const [tip, setTip] = useState<{
    x: number;
    y: number;
    content: TipContent;
    owner?: string;
  } | null>(null);
  const show = useCallback(
    (e: { clientX: number; clientY: number }, content: TipContent, owner?: string) =>
      setTip({ x: e.clientX, y: e.clientY, content, owner }),
    [],
  );
  const hide = useCallback(() => setTip(null), []);
  const shown = tip !== null;
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTip(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown]);
  return {
    node: tip ? <FloatTip id={id} x={tip.x} y={tip.y} content={tip.content} /> : null,
    show,
    hide,
    describedBy: (owner: string) => (tip?.owner === owner ? id : undefined),
  };
}

export function ViewToggle({ table, onToggle }: { table: boolean; onToggle: () => void }) {
  return (
    <button
      className="bp-ib"
      type="button"
      aria-pressed={table}
      aria-label={
        table
          ? t({ id: 'board.charts.chartView', defaultMessage: 'Chart view' })
          : t({ id: 'board.charts.tableView', defaultMessage: 'Table view' })
      }
      onClick={onToggle}
    >
      {table ? <ChartColumn aria-hidden="true" /> : <Table2 aria-hidden="true" />}
    </button>
  );
}
