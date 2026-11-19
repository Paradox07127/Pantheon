import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { Check, GripVertical, Pencil, RefreshCw } from 'lucide-react';
import type { Visual } from '@pantheon/domain';
import { EmptyState } from '../../components/EmptyState';
import { Skeleton } from '../../components/Skeleton';
import { VisualCard } from '../../components/visual/VisualCard';
import {
  arrangeVisuals,
  pinVisual,
  refreshVisual,
  refreshVisuals,
  unpinVisual,
  usePinnedVisuals,
  useRedrawFailed,
  useRedrawStarts,
  useRefreshing,
  type VisualRead,
  type VisualSize,
  type VisualWidth,
} from '../../data/visuals';
import { t } from '../../i18n';
import { moveBefore, stepKey } from '../board/panel-layout';
import './memory-diagrams.css';

/** The project's pinned visuals, their redraws and the layout editing. */
export interface DiagramsState {
  read: VisualRead<Visual[]>;
  editing: boolean;
  setEditing: (editing: boolean) => void;
  /** The pinned visuals whose session is still there to draw them again. */
  refreshable: readonly Visual[];
  /** Ids of the visuals waiting on a redraw. */
  refreshing: ReadonlySet<string>;
  /** When each redraw's turn was sent, by visual id. */
  started: ReadonlyMap<string, number>;
  /** Ids of the visuals whose redraw ended without drawing them again. */
  failed: ReadonlySet<string>;
  /** The redraw of every visual while it runs. */
  progress: { done: number; total: number } | null;
  refreshAll: () => void;
  error: string | null;
}

const NO_VISUALS: Visual[] = [];
const SIZES: VisualSize[] = ['S', 'M', 'L'];
const WIDTHS: VisualWidth[] = [4, 6, 8, 12];
// A visual pinned without a width spans half the grid.
const VISUAL_SPAN: VisualWidth = 6;

export function useDiagrams(projectId: string): DiagramsState {
  const read = usePinnedVisuals(projectId);
  const visuals = read.data ?? NO_VISUALS;
  const refreshing = useRefreshing(read.data);
  const failed = useRedrawFailed(read.data);
  const started = useRedrawStarts();
  const [editing, setEditing] = useState(false);
  const [batch, setBatch] = useState<readonly string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(projectId);
  current.current = projectId;
  const refreshable = useMemo(() => visuals.filter((v) => v.session_id !== null), [visuals]);
  const done = batch?.filter((id) => !refreshing.has(id)).length ?? 0;
  if (batch && done === batch.length) setBatch(null);
  const refreshAll = () => {
    if (batch || !refreshable.length) return;
    setBatch(refreshable.map((v) => v.id));
    setError(null);
    void refreshVisuals(refreshable).then((failed) => {
      if (current.current === projectId) setError(failed);
    });
  };
  return {
    read,
    editing,
    setEditing,
    refreshable,
    refreshing,
    started,
    failed,
    progress: batch && done < batch.length ? { done, total: batch.length } : null,
    refreshAll,
    error,
  };
}

const sameOrder = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/** The section's controls: redraw every visual and edit the layout, or finish editing. */
function DiagramsTools({ diagrams, empty }: { diagrams: DiagramsState; empty: boolean }) {
  if (diagrams.editing)
    return (
      <button type="button" className="btn pri sm" onClick={() => diagrams.setEditing(false)}>
        <Check className="ic-sm" aria-hidden="true" />
        {t({ id: 'memory.diagrams.done', defaultMessage: 'Done' })}
      </button>
    );
  const { progress } = diagrams;
  const cannotRefresh = empty || !!progress || !diagrams.refreshable.length;
  const cannotEdit = empty || !!progress;
  return (
    <>
      <button
        type="button"
        className="btn sm"
        aria-disabled={cannotRefresh || undefined}
        aria-busy={!!progress || undefined}
        onClick={cannotRefresh ? undefined : diagrams.refreshAll}
      >
        <RefreshCw className="ic-sm" aria-hidden="true" />
        {progress
          ? t(
              { id: 'memory.diagrams.refreshing', defaultMessage: 'Redrawing {done} / {total}' },
              { done: progress.done, total: progress.total },
            )
          : t(
              {
                id: 'memory.diagrams.redrawAll',
                defaultMessage: 'Redraw all ({count, plural, one {# turn} other {# turns}})',
              },
              { count: diagrams.refreshable.length },
            )}
      </button>
      <button
        type="button"
        className="btn sm"
        aria-disabled={cannotEdit || undefined}
        onClick={cannotEdit ? undefined : () => diagrams.setEditing(true)}
      >
        <Pencil className="ic-sm" aria-hidden="true" />
        {t({ id: 'memory.diagrams.editLayout', defaultMessage: 'Edit layout' })}
      </button>
    </>
  );
}

/** The pinned visuals in pinned order on 12 columns; while editing each can move, resize or leave. */
export function DiagramsGrid({
  projectId,
  diagrams,
}: {
  projectId: string;
  diagrams: DiagramsState;
}) {
  const { editing } = diagrams;
  // The pinned order sent last, shown until the read returns it.
  const [arranging, setArranging] = useState<readonly string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const grips = useRef(new Map<string, HTMLButtonElement>());
  const refocus = useRef<string | null>(null);
  const headingId = useId();
  // A card moved from the keyboard keeps the focus on its handle.
  useEffect(() => {
    if (refocus.current) grips.current.get(refocus.current)?.focus();
    refocus.current = null;
  });
  const visuals = diagrams.read.data ?? NO_VISUALS;
  const pinned = visuals.map((v) => v.id);
  const pending =
    arranging &&
    !sameOrder(arranging, pinned) &&
    arranging.length === pinned.length &&
    arranging.every((id) => pinned.includes(id));
  if (arranging && !pending) setArranging(null);
  const order = pending ? arranging : pinned;

  const write = (sent: Promise<string | null>) => {
    setError(null);
    void sent.then((failed) => failed && setError(failed));
  };
  const commit = (next: string[]) => {
    if (sameOrder(next, order)) return;
    setArranging(next);
    setError(null);
    void arrangeVisuals(projectId, next).then((failed) => {
      if (!failed) return;
      setArranging(null);
      setError(failed);
    });
  };
  const drop = (before: string | null) => {
    if (dragging && dragging !== before) commit(moveBefore(order, dragging, before));
    setDragging(null);
  };
  const dropTarget = (before: string | null) =>
    editing && dragging
      ? {
          onDragOver: (e: { preventDefault: () => void }) => e.preventDefault(),
          onDrop: (e: { preventDefault: () => void }) => {
            e.preventDefault();
            drop(before);
          },
        }
      : {};

  const editRow = (visual: Visual) => (
    <div className="mdg-edit">
      <button
        type="button"
        className="ib mdg-grip"
        draggable
        aria-label={t(
          { id: 'memory.diagrams.drag', defaultMessage: 'Move {title}' },
          { title: visual.title },
        )}
        aria-keyshortcuts="ArrowUp ArrowDown"
        ref={(button) => {
          if (button) grips.current.set(visual.id, button);
          else grips.current.delete(visual.id);
        }}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', visual.id);
          const cell = e.currentTarget.closest('.mdg-cell');
          if (cell) e.dataTransfer.setDragImage(cell, 16, 16);
          setDragging(visual.id);
        }}
        onDragEnd={() => setDragging(null)}
        onKeyDown={(e) => {
          const step =
            e.key === 'ArrowUp' || e.key === 'ArrowLeft'
              ? -1
              : e.key === 'ArrowDown' || e.key === 'ArrowRight'
                ? 1
                : 0;
          if (!step) return;
          e.preventDefault();
          refocus.current = visual.id;
          commit(stepKey(order, order, visual.id, step));
        }}
      >
        <GripVertical aria-hidden="true" />
      </button>
      <span className="mdg-edit-end">
        <RadioGroup<VisualSize>
          className="seg"
          aria-label={t({ id: 'memory.diagrams.size', defaultMessage: 'Size' })}
          value={visual.pin!.size}
          onValueChange={(size) => write(pinVisual(visual.id, size))}
        >
          {SIZES.map((s) => (
            <Radio.Root key={s} value={s}>
              {s}
            </Radio.Root>
          ))}
        </RadioGroup>
        <RadioGroup<VisualWidth>
          className="seg"
          aria-label={t({ id: 'memory.diagrams.width', defaultMessage: 'Width' })}
          value={visual.pin!.width ?? VISUAL_SPAN}
          onValueChange={(width) => write(pinVisual(visual.id, visual.pin!.size, width))}
        >
          {WIDTHS.map((w) => (
            <Radio.Root key={w} value={w}>
              {w}
            </Radio.Root>
          ))}
        </RadioGroup>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => write(unpinVisual(visual.id))}
        >
          {t({ id: 'memory.diagrams.unpin', defaultMessage: 'Unpin' })}
        </button>
      </span>
    </div>
  );

  const cell = (id: string) => {
    const visual = visuals.find((v) => v.id === id)!;
    return (
      <div
        key={id}
        className="mdg-cell"
        data-w={visual.pin!.width ?? VISUAL_SPAN}
        data-dragging={dragging === id || undefined}
        {...dropTarget(id)}
      >
        {editing && editRow(visual)}
        <VisualCard
          visual={visual}
          size={visual.pin!.size}
          onRefresh={() => void refreshVisual(visual).then(setError)}
          redrawable={visual.session_id !== null}
          refreshing={diagrams.refreshing.has(visual.id)}
          redrawSince={diagrams.started.get(visual.id) ?? null}
          failed={diagrams.failed.has(visual.id)}
        />
      </div>
    );
  };

  const failure = error ?? diagrams.error ?? diagrams.read.error;
  const empty = !visuals.length;
  return (
    <section
      className="mdg"
      aria-labelledby={headingId}
      aria-busy={diagrams.read.loading || undefined}
    >
      <div className="mdg-head">
        <h2 id={headingId}>
          {t({ id: 'memory.diagrams.pinned', defaultMessage: 'Pinned diagrams' })}
        </h2>
        {diagrams.read.data && <span className="mdg-n">{visuals.length}</span>}
        <span className="mdg-tools">
          <DiagramsTools diagrams={diagrams} empty={empty} />
        </span>
      </div>
      {failure && (
        <p className="mdg-err" role="alert">
          {failure}
        </p>
      )}
      <div className="mdg-grid" data-editing={editing || undefined}>
        {order.map(cell)}
        {editing && <div className="mdg-slot" aria-hidden="true" {...dropTarget(null)} />}
      </div>
      {empty && diagrams.read.loading && <Skeleton style={{ height: 160 }} />}
      {empty && !diagrams.read.loading && !diagrams.read.error && (
        <EmptyState
          inline
          title={t({ id: 'memory.diagrams.empty', defaultMessage: 'No pinned diagrams yet' })}
        />
      )}
    </section>
  );
}

/** The memory's diagrams tab: the visuals agents drew and the user pinned. */
export function DiagramsPage({ projectId }: { projectId: string }) {
  const diagrams = useDiagrams(projectId);
  return <DiagramsGrid projectId={projectId} diagrams={diagrams} />;
}
