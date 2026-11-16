import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { Check, GripVertical, Pencil, Plus, RefreshCw } from 'lucide-react';
import type { Visual } from '@pantheon/domain';
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
  useRefreshing,
  type VisualRead,
  type VisualSize,
  type VisualWidth,
} from '../../data/visuals';
import { t } from '../../i18n';
import type { ChangeLayout } from './BoardScreen';
import {
  canvasOrder,
  moveBefore,
  saveCanvasOrder,
  setHeight,
  setHidden,
  setSpan,
  stepKey,
  useCanvasOrder,
  visualOf,
  type PanelHeight,
  type PanelPlace,
  type PanelSpan,
} from './panel-layout';
import './canvas.css';

/** The canvas view's pinned visuals, layout editing and refresh, shared by its bar and its grid. */
export interface CanvasState {
  projectId: string | null;
  read: VisualRead<Visual[]>;
  editing: boolean;
  setEditing: (editing: boolean) => void;
  /** The pinned visuals whose session is still there to draw them again. */
  refreshable: readonly Visual[];
  /** Ids of the visuals waiting on a redraw. */
  refreshing: ReadonlySet<string>;
  /** Ids of the visuals whose redraw ended without drawing them again. */
  failed: ReadonlySet<string>;
  /** The refresh of every visual while it runs. */
  progress: { done: number; total: number } | null;
  refreshAll: () => void;
  error: string | null;
}

const NO_VISUALS: Visual[] = [];
const SIZES: VisualSize[] = ['S', 'M', 'L'];
const WIDTHS: VisualWidth[] = [4, 6, 8, 12];
const PANEL_SIZES: PanelHeight[] = ['auto', ...SIZES];
const PANEL_SPANS: PanelSpan[] = [6, 12];
// A visual pinned without a width spans half the grid.
const VISUAL_SPAN: VisualWidth = 6;

/** The canvas state of the project whose canvas shows; null while another view shows. */
export function useCanvas(projectId: string | null): CanvasState {
  const read = usePinnedVisuals(projectId);
  const visuals = read.data ?? NO_VISUALS;
  const refreshing = useRefreshing(read.data);
  const failed = useRedrawFailed(read.data);
  const [editing, setEditing] = useState(false);
  const [batch, setBatch] = useState<readonly string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shownProject, setShownProject] = useState(projectId);
  if (shownProject !== projectId) {
    setShownProject(projectId);
    setEditing(false);
    setBatch(null);
    setError(null);
  }
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
    projectId,
    read,
    editing,
    setEditing,
    refreshable,
    refreshing,
    failed,
    progress: batch && done < batch.length ? { done, total: batch.length } : null,
    refreshAll,
    error,
  };
}

/** The bar's canvas controls: refresh every visual and edit the layout, or finish editing. */
export function CanvasBar({ canvas, empty }: { canvas: CanvasState; empty: boolean }) {
  if (canvas.editing)
    return (
      <button type="button" className="btn pri" onClick={() => canvas.setEditing(false)}>
        <Check className="ic-sm" aria-hidden="true" />
        {t({ id: 'board.canvas.done', defaultMessage: 'Done' })}
      </button>
    );
  const { progress } = canvas;
  const cannotRefresh = empty || !!progress || !canvas.refreshable.length;
  const cannotEdit = empty || !!progress;
  const refresh = progress
    ? t(
        { id: 'board.canvas.refreshing', defaultMessage: 'Refreshing {done} / {total}' },
        { done: progress.done, total: progress.total },
      )
    : t({ id: 'board.canvas.refreshAll', defaultMessage: 'Refresh all' });
  const editLayout = t({ id: 'board.canvas.editLayout', defaultMessage: 'Edit layout' });
  return (
    <>
      <button
        type="button"
        className="btn"
        aria-disabled={cannotRefresh || undefined}
        aria-busy={!!progress || undefined}
        aria-label={refresh}
        title={refresh}
        onClick={cannotRefresh ? undefined : canvas.refreshAll}
      >
        <RefreshCw className="ic-sm" aria-hidden="true" />
        <span className="tb-lbl">{refresh}</span>
      </button>
      <button
        type="button"
        className="btn"
        aria-disabled={cannotEdit || undefined}
        aria-label={editLayout}
        title={editLayout}
        onClick={cannotEdit ? undefined : () => canvas.setEditing(true)}
      >
        <Pencil className="ic-sm" aria-hidden="true" />
        <span className="tb-lbl">{editLayout}</span>
      </button>
    </>
  );
}

/** A board panel on the canvas: its layout place and its node, failure boundary included. */
export interface CanvasPanel {
  place: PanelPlace;
  title: string;
  node: ReactNode;
}

export interface CanvasViewProps {
  /** Absent without a project, when the layout stays as it is. */
  projectId?: string;
  /** The canvas panels in layout order, hidden ones included. */
  panels: readonly CanvasPanel[];
  /** The board read holds nothing in its range, so the panels stay out. */
  boardEmpty: boolean;
  onLayout: ChangeLayout;
  /** Opens a session to ask an agent for a drawing. */
  onDraw: () => void;
  /** Shown above the laid out cards. */
  tasks?: ReactNode;
  /** Shown after the cards, such as the task drawer. */
  children?: ReactNode;
}

/** The canvas view: its grid, and its controls in the board bar's `bar` element once that is in. */
export function CanvasView({ bar, ...props }: CanvasViewProps & { bar: HTMLElement | null }) {
  const canvas = useCanvas(props.projectId ?? null);
  const empty =
    (props.boardEmpty || props.panels.every((p) => p.place.hidden)) && !canvas.read.data?.length;
  return (
    <>
      {bar && createPortal(<CanvasBar canvas={canvas} empty={empty} />, bar)}
      <CanvasGrid canvas={canvas} {...props} />
    </>
  );
}

const sameOrder = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/** The canvas grid: the board panels and the pinned visuals in one order, laid out on 12 columns. */
export function CanvasGrid({
  projectId,
  canvas,
  panels,
  boardEmpty,
  onLayout,
  onDraw,
  tasks,
  children,
}: CanvasViewProps & { canvas: CanvasState }) {
  const { editing } = canvas;
  const stored = useCanvasOrder(projectId);
  // The pinned order sent last, shown until the read returns it.
  const [arranging, setArranging] = useState<readonly string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [shownProject, setShownProject] = useState(projectId);
  if (shownProject !== projectId) {
    setShownProject(projectId);
    setArranging(null);
    setError(null);
    setDragging(null);
  }
  const grips = useRef(new Map<string, HTMLButtonElement>());
  const refocus = useRef<string | null>(null);
  // A card moved from the keyboard keeps the focus on its handle.
  useEffect(() => {
    if (refocus.current) grips.current.get(refocus.current)?.focus();
    refocus.current = null;
  });
  const visuals = canvas.read.data ?? NO_VISUALS;
  const pinned = visuals.map((v) => v.id);
  const pending =
    arranging &&
    !sameOrder(arranging, pinned) &&
    arranging.length === pinned.length &&
    arranging.every((id) => pinned.includes(id));
  if (arranging && !pending) setArranging(null);
  const ids = pending ? arranging : pinned;
  const order = canvasOrder(
    stored,
    panels.map((p) => p.place.key),
    ids,
  );
  const shown = order.filter((key) => {
    if (visualOf(key) !== null) return true;
    const panel = panels.find((p) => p.place.key === key)!;
    return !panel.place.hidden && !boardEmpty;
  });

  const write = (sent: Promise<string | null>) => {
    setError(null);
    void sent.then((failed) => failed && setError(failed));
  };
  const commit = (next: string[]) => {
    if (!projectId) return;
    saveCanvasOrder(projectId, next);
    const nextIds = next.map(visualOf).filter((id) => id !== null);
    if (sameOrder(nextIds, ids)) return;
    setArranging(nextIds);
    setError(null);
    void arrangeVisuals(projectId, nextIds).then((failed) => {
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

  const editRow = <W extends number>(
    key: string,
    title: string,
    size: PanelHeight,
    sizes: readonly PanelHeight[],
    onSize: (size: PanelHeight) => void,
    onRemove: () => void,
    width: { value: W; options: readonly W[]; onChange: (width: W) => void },
  ) => (
    <div className="cv-edit">
      <button
        type="button"
        className="ib cv-grip"
        draggable
        aria-label={t({ id: 'board.canvas.drag', defaultMessage: 'Move {title}' }, { title })}
        aria-keyshortcuts="ArrowUp ArrowDown"
        ref={(button) => {
          if (button) grips.current.set(key, button);
          else grips.current.delete(key);
        }}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', key);
          const cell = e.currentTarget.closest('.cv-cell');
          if (cell) e.dataTransfer.setDragImage(cell, 16, 16);
          setDragging(key);
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
          refocus.current = key;
          commit(stepKey(order, shown, key, step));
        }}
      >
        <GripVertical aria-hidden="true" />
      </button>
      <span className="cv-edit-end">
        <RadioGroup<PanelHeight>
          className="seg"
          aria-label={t({ id: 'board.canvas.size', defaultMessage: 'Size' })}
          value={size}
          onValueChange={onSize}
        >
          {sizes.map((s) => (
            <Radio.Root key={s} value={s}>
              {s === 'auto' ? t({ id: 'board.layout.auto', defaultMessage: 'Auto' }) : s}
            </Radio.Root>
          ))}
        </RadioGroup>
        <RadioGroup<W>
          className="seg"
          aria-label={t({ id: 'board.canvas.width', defaultMessage: 'Width' })}
          value={width.value}
          onValueChange={width.onChange}
        >
          {width.options.map((w) => (
            <Radio.Root key={w} value={w}>
              {w}
            </Radio.Root>
          ))}
        </RadioGroup>
        <button type="button" className="btn ghost sm" onClick={onRemove}>
          {t({ id: 'board.canvas.remove', defaultMessage: 'Remove' })}
        </button>
      </span>
    </div>
  );

  const cell = (key: string) => {
    const visualId = visualOf(key);
    const visual = visualId === null ? undefined : visuals.find((v) => v.id === visualId)!;
    const panel = visual ? undefined : panels.find((p) => p.place.key === key)!;
    const span = panel ? panel.place.span : (visual!.pin!.width ?? VISUAL_SPAN);
    const height = panel?.place.height;
    return (
      <div
        key={key}
        className={`bd-s${span} cv-cell`}
        data-h={height && height !== 'auto' ? height : undefined}
        data-dragging={dragging === key || undefined}
        {...dropTarget(key)}
      >
        {editing &&
          (visual
            ? editRow(
                key,
                visual.title,
                visual.pin!.size,
                SIZES,
                (size) => size !== 'auto' && write(pinVisual(visual.id, size)),
                () => write(unpinVisual(visual.id)),
                {
                  value: visual.pin!.width ?? VISUAL_SPAN,
                  options: WIDTHS,
                  onChange: (width) => write(pinVisual(visual.id, visual.pin!.size, width)),
                },
              )
            : editRow(
                key,
                panel!.title,
                panel!.place.height,
                PANEL_SIZES,
                (size) => onLayout((l) => setHeight(l, key, size)),
                () => onLayout((l) => setHidden(l, key, true)),
                {
                  value: panel!.place.span,
                  options: PANEL_SPANS,
                  onChange: (span) => onLayout((l) => setSpan(l, key, span)),
                },
              ))}
        {visual ? (
          <VisualCard
            visual={visual}
            size={visual.pin!.size}
            onRefresh={
              visual.session_id ? () => void refreshVisual(visual).then(setError) : undefined
            }
            refreshing={canvas.refreshing.has(visual.id)}
            failed={canvas.failed.has(visual.id)}
          />
        ) : (
          panel!.node
        )}
      </div>
    );
  };

  const failure = error ?? canvas.error ?? canvas.read.error;
  const empty = !shown.length && !canvas.read.loading && !canvas.read.error;
  return (
    <div
      className="bd-grid cv-grid"
      data-editing={editing || undefined}
      aria-busy={canvas.read.loading || undefined}
    >
      {editing && (
        <div className="cv-guides" aria-hidden="true">
          {Array.from({ length: 12 }, (_, i) => (
            <i key={i} />
          ))}
        </div>
      )}
      {failure && (
        <p className="cv-err" role="alert">
          {failure}
        </p>
      )}
      {tasks}
      {shown.map(cell)}
      {!shown.length && canvas.read.loading && (
        <div className="bd-s12">
          <Skeleton style={{ height: 160 }} />
        </div>
      )}
      {empty && (
        <div className="cv-empty">
          <p>
            {t({ id: 'board.canvas.empty', defaultMessage: 'Nothing is drawn on the canvas yet' })}
          </p>
          <button type="button" className="btn pri" onClick={onDraw}>
            <Plus className="ic-sm" aria-hidden="true" />
            {t({ id: 'board.canvas.draw', defaultMessage: 'Ask an agent to draw one' })}
          </button>
        </div>
      )}
      {editing && (
        <div className="cv-slot" aria-hidden="true" {...dropTarget(null)}>
          {Array.from({ length: 12 }, (_, i) => (
            <i key={i} />
          ))}
        </div>
      )}
      {children}
    </div>
  );
}
