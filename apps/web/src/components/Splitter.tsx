import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

const STEP = 8;
const BIG_STEP = 32;

export interface SplitterProps {
  label: string;
  /** The pane's width in px. */
  value: number;
  min: number;
  max: number;
  /** The pane's edge the splitter sits on; a right edge widens the pane as it moves right, a top edge sizes its height. */
  edge: 'left' | 'right' | 'top';
  /** The width asked for: unclamped while dragging, clamped from the keyboard. */
  onSize: (width: number) => void;
  /** The drag ended or a key moved the splitter; the time to store the width. */
  onCommit: () => void;
  /** Enter folds the pane or brings it back. */
  onToggle?: () => void;
  /** A double click goes back to the default width. */
  onReset: () => void;
}

/** The draggable, focusable edge of a pane (APG window splitter). */
export function Splitter(props: SplitterProps) {
  const latest = useRef(props);
  latest.current = props;
  // A pane that folds mid-drag unmounts its splitter; the rest of that drag is ignored.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [dragging, setDragging] = useState(false);
  const toward = props.edge === 'right' ? 1 : -1;
  const across = props.edge === 'top';
  const along = (e: { clientX: number; clientY: number }) => (across ? e.clientY : e.clientX);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // Preventing the default also keeps the press from focusing the separator.
    e.currentTarget.focus();
    const from = along(e);
    const start = props.value;
    const move = (m: PointerEvent) => {
      if (alive.current) latest.current.onSize(start + toward * (along(m) - from));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (alive.current) setDragging(false);
      latest.current.onCommit();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    setDragging(true);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      props.onToggle?.();
      return;
    }
    const [back, forth] = across ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
    if (e.key !== back && e.key !== forth) return;
    e.preventDefault();
    const by = (e.shiftKey ? BIG_STEP : STEP) * (e.key === forth ? 1 : -1) * toward;
    props.onSize(Math.min(props.max, Math.max(props.min, props.value + by)));
    props.onCommit();
  };

  return (
    <div
      className="split"
      role="separator"
      tabIndex={0}
      aria-orientation={across ? 'horizontal' : 'vertical'}
      aria-label={props.label}
      aria-valuenow={Math.round(props.value)}
      aria-valuemin={props.min}
      aria-valuemax={Math.round(props.max)}
      data-edge={props.edge}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => props.onReset()}
    />
  );
}
