import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { create } from 'zustand';
import type { TurnView } from '../../data/transcript';
import { t } from '../../i18n';
import { reducedMotion } from '../../lib/motion';
import { findMatches, type FindMatch } from './thread-model';

interface ThreadFindState {
  /** The session whose thread shows the search bar; null while it is closed. */
  sessionId: string | null;
  /** What opened the bar; it takes focus back when the bar closes. */
  opener: HTMLElement | null;
  /** How many times the bar was asked for; each ask puts the caret in its field. */
  asked: number;
  show: (sessionId: string, opener: HTMLElement | null) => void;
  close: () => void;
}

export const useThreadFind = create<ThreadFindState>()((set) => ({
  sessionId: null,
  opener: null,
  asked: 0,
  show: (sessionId, opener) => set((s) => ({ sessionId, opener, asked: s.asked + 1 })),
  close: () => set({ sessionId: null, opener: null }),
}));

const ALL = 'ss-find';
const NOW = 'ss-find-now';

/**
 * Marks every match in the drawn thread and returns the current one. A turn's text blocks carry
 * `data-find`; a block's text nodes are searched as one text, so a match may run across them.
 */
function paint(root: HTMLElement, query: string, match: FindMatch | null): Range | null {
  const registry = globalThis.CSS?.highlights;
  const needle = query.toLowerCase();
  const all: Range[] = [];
  let now: Range | null = null;
  if (registry && needle.trim())
    for (const turn of root.querySelectorAll<HTMLElement>('[data-turn]'))
      for (const block of turn.querySelectorAll<HTMLElement>('[data-find]')) {
        const nodes: Node[] = [];
        const starts: number[] = [];
        const ends: number[] = [];
        let hay = '';
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          nodes.push(node);
          starts.push(hay.length);
          hay += (node.textContent ?? '').toLowerCase();
          ends.push(hay.length);
        }
        /** The text node and offset of a place in the block's text; an end stays in the node it closes. */
        const point = (at: number, end: boolean): [Node, number] => {
          const i = ends.findIndex((e) => (end ? at <= e : at < e));
          return [nodes[i]!, at - starts[i]!];
        };
        let nth = 0;
        for (
          let at = hay.indexOf(needle);
          at !== -1;
          at = hay.indexOf(needle, at + needle.length)
        ) {
          const range = document.createRange();
          range.setStart(...point(at, false));
          range.setEnd(...point(at + needle.length, true));
          all.push(range);
          if (
            match &&
            match.turn === turn.dataset.turn &&
            match.block === block.dataset.find &&
            match.nth === nth
          )
            now = range;
          nth++;
        }
      }
  if (registry) {
    registry.set(ALL, new Highlight(...all));
    if (now) registry.set(NOW, new Highlight(now));
    else registry.delete(NOW);
  }
  return now;
}

/**
 * Scrolls the current match to the middle of the thread; a match the thread does not draw, such as
 * one in folded work, scrolls to its turn.
 */
function reveal(root: HTMLElement, now: Range | null, match: FindMatch | null) {
  const behavior = reducedMotion() ? 'auto' : 'smooth';
  if (now) {
    const box = root.getBoundingClientRect();
    const at = now.getBoundingClientRect();
    root.scrollTo({
      top: root.scrollTop + at.top - box.top - (root.clientHeight - at.height) / 2,
      behavior,
    });
  } else if (match)
    root
      .querySelector(`[data-turn="${CSS.escape(match.turn)}"]`)
      ?.scrollIntoView({ block: 'center', behavior });
}

/** The search bar over the thread: the user's messages and the agent's replies the client holds. */
export function ThreadFind(props: {
  turns: readonly TurnView[];
  scroller: RefObject<HTMLDivElement | null>;
}) {
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const matches = useMemo(() => findMatches(props.turns, query), [props.turns, query]);
  const current = matches.length ? Math.min(at, matches.length - 1) : -1;
  const match = matches[current] ?? null;
  useEffect(() => {
    const root = props.scroller.current;
    if (!root) return;
    reveal(root, paint(root, query, match), match);
    // Text streams in, turns are drawn as they near the screen and folded work opens under the marks.
    const drawn = new MutationObserver(() => paint(root, query, match));
    drawn.observe(root, { childList: true, subtree: true, characterData: true });
    return () => drawn.disconnect();
  }, [query, match?.turn, match?.block, match?.nth]);
  const field = useRef<HTMLInputElement>(null);
  const askedNow = () => useThreadFind.getState().asked;
  const asked = useSyncExternalStore(useThreadFind.subscribe, askedNow, askedNow);
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, [asked]);
  useEffect(
    () => () => {
      globalThis.CSS?.highlights?.delete(ALL);
      globalThis.CSS?.highlights?.delete(NOW);
    },
    [],
  );
  const close = () => {
    const { opener } = useThreadFind.getState();
    useThreadFind.getState().close();
    opener?.focus();
  };
  const step = (by: number) => {
    if (matches.length) setAt((current + by + matches.length) % matches.length);
  };
  return (
    <div
      className="ss-find"
      role="search"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        // The thread's own Escape interrupts the running turn.
        e.preventDefault();
        e.stopPropagation();
        close();
      }}
    >
      <Search className="ic-sm" aria-hidden="true" />
      <input
        ref={field}
        className="ss-findi"
        value={query}
        aria-label={t({ id: 'sessions.thread.find', defaultMessage: 'Search in session' })}
        onChange={(e) => {
          setQuery(e.target.value);
          setAt(0);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          step(e.shiftKey ? -1 : 1);
        }}
      />
      <span className="ss-findn" aria-live="polite">
        {matches.length
          ? t(
              { id: 'sessions.thread.findCount', defaultMessage: '{current} of {total}' },
              { current: current + 1, total: matches.length },
            )
          : query.trim()
            ? t({ id: 'sessions.thread.findNone', defaultMessage: 'No matches' })
            : ''}
      </span>
      <button
        type="button"
        className="ib"
        aria-label={t({ id: 'sessions.thread.findPrevious', defaultMessage: 'Previous match' })}
        disabled={!matches.length}
        onClick={() => step(-1)}
      >
        <ChevronUp aria-hidden="true" />
      </button>
      <button
        type="button"
        className="ib"
        aria-label={t({ id: 'sessions.thread.findNext', defaultMessage: 'Next match' })}
        disabled={!matches.length}
        onClick={() => step(1)}
      >
        <ChevronDown aria-hidden="true" />
      </button>
      <button
        type="button"
        className="ib"
        aria-label={t({ id: 'sessions.thread.findClose', defaultMessage: 'Close search' })}
        onClick={close}
      >
        <X aria-hidden="true" />
      </button>
    </div>
  );
}
