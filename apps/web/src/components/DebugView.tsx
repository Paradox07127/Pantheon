import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from 'react';
import {
  ChevronRight,
  Code,
  Component,
  Copy,
  FileCode,
  SquareDashed,
  SquareDashedMousePointer,
  X,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import {
  drillIn,
  pickAt,
  sendDebugItems,
  type DebugItem,
  type DebugLevel,
  type DebugPick,
} from '../data/debug-view';
import { t } from '../i18n';
import { holdRootFlag } from '../lib/root-flag';
import { keyText } from '../lib/shortcuts';
import './debug-view.css';

/** Whether the window's debug view is on. */
export const useDebugView = create<{ open: boolean }>(() => ({ open: false }));
export const toggleDebugView = () => useDebugView.setState((s) => ({ open: !s.open }));
const leave = () => useDebugView.setState({ open: false });

type Rect = DebugPick['rect'];
interface Hover {
  pick: DebugPick;
  /** The element under the pointer, which a drill goes in towards. */
  target: Element;
}

const LEVELS: readonly DebugLevel[] = ['region', 'component', 'element'];
const LEVEL_ICONS = { region: SquareDashed, component: Component, element: Code };

function levelName(level: DebugLevel): string {
  if (level === 'region')
    return t({ id: 'components.debugView.level.region', defaultMessage: 'Region' });
  if (level === 'component')
    return t({ id: 'components.debugView.level.component', defaultMessage: 'Component' });
  return t({ id: 'components.debugView.level.element', defaultMessage: 'Element' });
}

// Functions, so each name is read in the language loaded by then.
const REGION_NAMES: Record<string, () => string> = {
  'app.sidebar': () => t({ id: 'components.debugView.region.sidebar', defaultMessage: 'Sidebar' }),
  'board.publish-bar': () =>
    t({ id: 'components.debugView.region.publishBar', defaultMessage: 'Publish bar' }),
  'board.summary': () =>
    t({ id: 'components.debugView.region.summary', defaultMessage: 'Summary strip' }),
  'board.milestone': () =>
    t({ id: 'components.debugView.region.milestone', defaultMessage: 'Current milestone' }),
  'board.progress': () =>
    t({ id: 'components.debugView.region.progress', defaultMessage: 'Progress' }),
  'board.lead': () => t({ id: 'components.debugView.region.lead', defaultMessage: 'Lead panel' }),
  'board.task-groups': () =>
    t({ id: 'components.debugView.region.taskGroups', defaultMessage: 'Task groups' }),
  'board.flow': () =>
    t({ id: 'components.debugView.region.flow', defaultMessage: 'Flow chart panel' }),
  'sessions.list': () =>
    t({ id: 'components.debugView.region.sessionList', defaultMessage: 'Session list' }),
  'sessions.transcript': () =>
    t({ id: 'components.debugView.region.transcript', defaultMessage: 'Transcript' }),
  'sessions.composer': () =>
    t({ id: 'components.debugView.region.composer', defaultMessage: 'Composer' }),
  'sessions.inspector': () =>
    t({ id: 'components.debugView.region.inspector', defaultMessage: 'Session panels' }),
};

/** A region pick's name, otherwise the last step of its path. */
const nameOf = (pick: DebugPick): string =>
  pick.level === 'region' && pick.region
    ? (REGION_NAMES[pick.region]?.() ?? pick.region)
    : (pick.path.at(-1) ?? pick.element.tagName.toLowerCase());

/** The file of a data-pt-src location, without its line and column. */
const fileOf = (source: string) => source.replace(/:\d+:\d+$/, '');
/** The file name and line of a data-pt-src location. */
const shortSource = (source: string) => source.split('/').at(-1)!.replace(/:\d+$/, '');

// The tag is 20px high and sits 4px above the outline, which sits 4px out from the element.
const TAG_ROOM = 28;
const OUTSET = 4;

const placed = ({ x, y, width, height }: Rect): CSSProperties => ({
  left: x - OUTSET,
  top: y - OUTSET,
  width: width + 2 * OUTSET,
  height: height + 2 * OUTSET,
});

const tagPlaced = ({ x, y }: Rect): CSSProperties => ({
  left: x - OUTSET,
  // Inside the outline's top when there is no room above it.
  top: y >= TAG_ROOM ? y - TAG_ROOM : y,
});

const boxOf = (element: Element): Rect => {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
};

/** The rects of the marked regions that show. */
const outlines = (): Rect[] =>
  [...document.querySelectorAll('[data-debug-region]')]
    .map(boxOf)
    .filter((r) => r.width > 0 && r.height > 0);

const typing = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
};

const copy = (text: string) => void navigator.clipboard.writeText(text);

/** What the view stops from reaching the app beneath it. */
const FROZEN = [
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'contextmenu',
  'keydown',
  'keyup',
] as const;

/** A PNG of the rect with the layer hidden, or null without the desktop bridge. */
async function capture(layer: HTMLElement, rect: Rect): Promise<string | null> {
  const bridge = window.pantheon;
  if (!bridge) return null;
  layer.style.visibility = 'hidden';
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  const shot = await bridge.captureRegion(rect);
  layer.style.visibility = '';
  return shot.ok ? shot.value : null;
}

/** The debug view over the window while it is on. */
export function DebugView() {
  const open = useDebugView((s) => s.open);
  // On body: .app is fixed, so a layer inside it stays under the menus portaled to body.
  return open ? createPortal(<DebugLayer />, document.body) : null;
}

function tagText(pick: DebugPick) {
  if (pick.level === 'region')
    return (
      <>
        <span className="dbv-tag-n">{nameOf(pick)}</span>
        {pick.source && <span className="dbv-tag-f">{fileOf(pick.source)}</span>}
      </>
    );
  const steps = pick.path.length ? pick.path : [nameOf(pick)];
  return steps.map((step, i) => (
    <Fragment key={i}>
      {i > 0 && <ChevronRight aria-hidden="true" />}
      <span className={i === steps.length - 1 ? 'dbv-tag-n' : undefined}>{step}</span>
    </Fragment>
  ));
}

function DebugLayer() {
  const root = useRef<HTMLDivElement>(null);
  const hit = useRef<HTMLDivElement>(null);
  const [level, setLevel] = useState<DebugLevel>('region');
  const [hover, setHover] = useState<Hover | null>(null);
  const [regions, setRegions] = useState<Rect[]>([]);
  const [items, setItems] = useState<DebugItem[]>([]);
  const [chosen, setChosen] = useState<DebugPick | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [request, setRequest] = useState('');
  // Set when the toolbar's Send opens the inspector to ask for the request.
  const [describing, setDescribing] = useState(false);
  const shown = items.find((item) => item.pick === chosen) ?? items.at(-1);
  const inspected = inspecting ? shown : undefined;

  // While the view is open the page under it stays hit-testable and still (debug-view.css).
  useLayoutEffect(() => holdRootFlag('debug-view'), []);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    hit.current!.focus();
    setRegions(outlines());
    return () => before?.focus();
  }, []);

  const pick = async () => {
    if (!hover) return;
    const { pick } = hover;
    setDescribing(false);
    const same = items.find((item) => item.pick.element === pick.element);
    if (same) {
      setChosen(same.pick);
      setInspecting(true);
      return;
    }
    const image = await capture(root.current!, pick.rect);
    setItems((list) => [...list, { pick, note: '', image }]);
    setChosen(pick);
    setInspecting(true);
  };
  const choose = (next: DebugLevel) => {
    setLevel(next);
    if (hover) setHover({ ...hover, pick: pickAt(hover.target, next) });
  };
  const closeInspector = () => {
    setInspecting(false);
    hit.current!.focus();
  };
  const send = async () => {
    if (await sendDebugItems(items, request.trim())) leave();
  };
  const sendFromBar = () => {
    if (request.trim()) void send();
    else {
      setDescribing(true);
      setInspecting(true);
    }
  };
  const setNote = (pick: DebugPick, note: string) =>
    setItems((list) => list.map((item) => (item.pick === pick ? { ...item, note } : item)));
  const remove = (pick: DebugPick) => setItems((list) => list.filter((item) => item.pick !== pick));

  const onKey = useRef<(e: KeyboardEvent) => void>(null);
  onKey.current = (e) => {
    if (e.defaultPrevented) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (inspected) closeInspector();
      else leave();
      return;
    }
    if (!hover || typing(e.target)) return;
    if (e.key === 'Alt' && !e.repeat) {
      e.preventDefault();
      const next = drillIn(hover.pick, hover.target);
      setLevel(next.level);
      setHover({ ...hover, pick: next });
    }
    // Enter on a control of the toolbar or the inspector is that control's.
    if (
      e.key === 'Enter' &&
      !(root.current!.contains(e.target as Node) && e.target !== hit.current)
    ) {
      e.preventDefault();
      void pick();
    }
  };
  // Runs first on the window: the view handles its keys and picks here, and stops the rest short of the app.
  const onFrozen = useRef<(e: Event) => void>(null);
  onFrozen.current = (e) => {
    if (e.type === 'keydown') onKey.current!(e as KeyboardEvent);
    if (e.type === 'click' && e.target === hit.current) void pick();
    const own = e.target !== hit.current && root.current!.contains(e.target as Node);
    if (own && !e.defaultPrevented) return;
    // Tab moves on from the page into the toolbar and the inspector.
    const key = e as KeyboardEvent;
    if (e.target === hit.current && key.key === 'Tab' && !key.shiftKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  useEffect(() => {
    const listener = (e: Event) => onFrozen.current!(e);
    for (const type of FROZEN) window.addEventListener(type, listener, true);
    return () => {
      for (const type of FROZEN) window.removeEventListener(type, listener, true);
    };
  }, []);

  const onMove = (e: PointerEvent) => {
    const target = document
      .elementsFromPoint(e.clientX, e.clientY)
      .find((el) => !root.current!.contains(el));
    if (target === hover?.target) return;
    setRegions(outlines());
    setHover(target ? { pick: pickAt(target, level), target } : null);
  };

  const region =
    hover && hover.pick.level !== 'region' ? hover.target.closest('[data-debug-region]') : null;
  const title = t({ id: 'components.debugView.title', defaultMessage: 'Debug view' });
  const sendLabel = t({ id: 'components.debugView.send', defaultMessage: 'Send' });
  return (
    <div ref={root} className="dbv" data-inspecting={inspected ? '' : undefined}>
      <div
        ref={hit}
        className="dbv-hit"
        role="application"
        aria-label={t({ id: 'components.debugView.page', defaultMessage: 'Page to inspect' })}
        tabIndex={-1}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      />
      {regions.map((rect, i) => (
        <span key={i} className="dbv-out" style={placed(rect)} aria-hidden="true" />
      ))}
      {region && (
        <span
          className="dbv-box"
          data-state="drill"
          style={placed(boxOf(region))}
          aria-hidden="true"
        />
      )}
      {items.map((item, i) => (
        <span
          key={i}
          className="dbv-box"
          data-state="picked"
          style={placed(item.pick.rect)}
          aria-hidden="true"
        >
          <span className="dbv-n">{i + 1}</span>
        </span>
      ))}
      {hover && (
        <span
          className="dbv-box"
          data-state="hover"
          style={placed(hover.pick.rect)}
          aria-hidden="true"
        />
      )}
      <div
        className="dbv-tag"
        role="status"
        data-path={hover && hover.pick.level !== 'region' ? '' : undefined}
        style={hover ? tagPlaced(hover.pick.rect) : undefined}
      >
        {hover && tagText(hover.pick)}
      </div>
      <div className="dbv-bar" role="toolbar" aria-label={title}>
        <span className="dbv-title">
          <SquareDashedMousePointer aria-hidden="true" />
          {title}
        </span>
        <span className="dbv-sep" aria-hidden="true" />
        <div
          className="dbv-lv"
          role="group"
          aria-label={t({ id: 'components.debugView.levels', defaultMessage: 'Inspect level' })}
        >
          {LEVELS.map((each) => (
            <button
              key={each}
              type="button"
              aria-pressed={level === each}
              onClick={() => choose(each)}
            >
              {levelName(each)}
            </button>
          ))}
        </div>
        <span className="dbv-sep" aria-hidden="true" />
        <span className="dbv-count">
          {t(
            { id: 'components.debugView.picked', defaultMessage: 'Picked {count}' },
            { count: items.length },
          )}
        </span>
        {!inspected && (
          <button
            type="button"
            className="btn pri"
            disabled={items.length === 0}
            onClick={sendFromBar}
          >
            {sendLabel}
          </button>
        )}
        <span className="dbv-keys" aria-hidden="true">
          <span>
            <span className="kbd">{keyText('Alt')}</span>
            {t({ id: 'components.debugView.drill', defaultMessage: 'Drill in' })}
          </span>
          <span>
            <span className="kbd">{keyText('Enter')}</span>
            {t({ id: 'components.debugView.pick', defaultMessage: 'Pick' })}
          </span>
          <span>
            <span className="kbd">{keyText('Escape')}</span>
            {t({ id: 'components.debugView.exit', defaultMessage: 'Exit' })}
          </span>
        </span>
      </div>
      {inspected && (
        <Inspector
          items={items}
          shown={inspected}
          sendLabel={sendLabel}
          request={request}
          describing={describing}
          onRequest={setRequest}
          onChoose={setChosen}
          onNote={setNote}
          onRemove={remove}
          onClear={() => setItems([])}
          onClose={closeInspector}
          onSend={() => void send()}
        />
      )}
    </div>
  );
}

function LevelIcon({ level }: { level: DebugLevel }) {
  const Icon = LEVEL_ICONS[level];
  return <Icon className="dbv-ic" aria-hidden="true" />;
}

function Inspector(props: {
  items: readonly DebugItem[];
  shown: DebugItem;
  sendLabel: string;
  request: string;
  describing: boolean;
  onRequest: (request: string) => void;
  onChoose: (pick: DebugPick) => void;
  onNote: (pick: DebugPick, note: string) => void;
  onRemove: (pick: DebugPick) => void;
  onClear: () => void;
  onClose: () => void;
  onSend: () => void;
}) {
  const { items, shown } = props;
  const batch = items.length > 1;
  const { pick } = shown;
  const name = nameOf(pick);
  const requestLabel = t({
    id: 'components.debugView.request',
    defaultMessage: 'What do you want changed or fixed?',
  });
  return (
    <aside
      className="dbv-ins"
      aria-label={t({ id: 'components.debugView.inspector', defaultMessage: 'Inspector' })}
    >
      <div className="dbv-ih">
        {batch ? (
          <>
            <span className="dbv-it">
              {t({ id: 'components.debugView.pending', defaultMessage: 'To send' })}
            </span>
            <span className="dbv-ct">{items.length}</span>
            <button type="button" className="btn sm ghost dbv-end" onClick={props.onClear}>
              {t({ id: 'components.debugView.clear', defaultMessage: 'Clear' })}
            </button>
          </>
        ) : (
          <>
            <LevelIcon level={pick.level} />
            <span className="dbv-it">{name}</span>
            {pick.region && <span className="dbv-sub">{pick.region}</span>}
          </>
        )}
        <button
          type="button"
          className={batch ? 'ib' : 'ib dbv-end'}
          aria-label={t({ id: 'components.debugView.close', defaultMessage: 'Close inspector' })}
          onClick={props.onClose}
        >
          <X aria-hidden="true" />
        </button>
      </div>
      <div className="dbv-ib">
        {batch && (
          <ul className="dbv-list">
            {items.map((item, i) => {
              const itemName = nameOf(item.pick);
              return (
                <li key={i} className="dbv-pend" data-on={item === shown || undefined}>
                  <div className="dbv-ph">
                    <button
                      type="button"
                      className="dbv-pb"
                      aria-pressed={item === shown}
                      onClick={() => props.onChoose(item.pick)}
                    >
                      <span className="dbv-n">{i + 1}</span>
                      <LevelIcon level={item.pick.level} />
                      <span className="dbv-it">{itemName}</span>
                      {item.pick.source && (
                        <span className="dbv-sub">{shortSource(item.pick.source)}</span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="ib"
                      aria-label={t(
                        { id: 'components.debugView.remove', defaultMessage: 'Remove {name}' },
                        { name: itemName },
                      )}
                      onClick={() => props.onRemove(item.pick)}
                    >
                      <X aria-hidden="true" />
                    </button>
                  </div>
                  <input
                    className="dbv-note"
                    aria-label={t(
                      {
                        id: 'components.debugView.noteFor',
                        defaultMessage: 'What is wrong with {name}',
                      },
                      { name: itemName },
                    )}
                    value={item.note}
                    onChange={(e) => props.onNote(item.pick, e.target.value)}
                  />
                </li>
              );
            })}
          </ul>
        )}
        <Detail key={items.indexOf(shown)} item={shown} batch={batch} />
      </div>
      <div className="dbv-if">
        {!batch && (
          <textarea
            className="dbv-note"
            rows={3}
            aria-label={t({ id: 'components.debugView.note', defaultMessage: 'What is wrong' })}
            placeholder={t({
              id: 'components.debugView.notePlaceholder',
              defaultMessage: 'What is wrong here',
            })}
            value={shown.note}
            onChange={(e) => props.onNote(pick, e.target.value)}
          />
        )}
        <textarea
          className="dbv-note"
          rows={3}
          aria-label={requestLabel}
          placeholder={requestLabel}
          autoFocus={props.describing}
          value={props.request}
          onChange={(e) => props.onRequest(e.target.value)}
        />
        <div className="dbv-send">
          <span className="dbv-to">
            {t({ id: 'components.debugView.target', defaultMessage: 'Debug session' })}
          </span>
          <button
            type="button"
            className="btn pri"
            disabled={!props.request.trim()}
            onClick={props.onSend}
          >
            {batch
              ? t(
                  {
                    id: 'components.debugView.sendCount',
                    defaultMessage: '{count, plural, one {Send # item} other {Send # items}}',
                  },
                  { count: items.length },
                )
              : props.sendLabel}
          </button>
        </div>
      </div>
    </aside>
  );
}

/** What the inspector knows of one pick; in a batch only its input data starts open. */
function Detail({ item, batch }: { item: DebugItem; batch: boolean }) {
  const { pick } = item;
  const name = nameOf(pick);
  return (
    <>
      <section className="dbv-sec">
        {batch && (
          <div className="dbv-row">
            <LevelIcon level={pick.level} />
            <span className="dbv-it">{name}</span>
            {pick.region && <span className="dbv-sub">{pick.region}</span>}
          </div>
        )}
        {pick.source && (
          <div className="dbv-row">
            <FileCode className="dbv-ic" aria-hidden="true" />
            <span className="dbv-src">
              {pick.source.split('/').map((part, i) => (
                <Fragment key={i}>
                  {i > 0 && (
                    <>
                      /<wbr />
                    </>
                  )}
                  {part}
                </Fragment>
              ))}
            </span>
            <button
              type="button"
              className="ib"
              aria-label={t({
                id: 'components.debugView.copySource',
                defaultMessage: 'Copy source location',
              })}
              onClick={() => copy(pick.source!)}
            >
              <Copy aria-hidden="true" />
            </button>
          </div>
        )}
      </section>
      <details className="dbv-sec" open={!batch}>
        <summary>
          <ChevronRight className="dbv-chev" aria-hidden="true" />
          {t({ id: 'components.debugView.stack', defaultMessage: 'Component stack' })}
          <span className="dbv-ct">{pick.stack.length}</span>
        </summary>
        <ol className="dbv-stack">
          {pick.stack.map((component, i) => (
            <li key={i}>{component}</li>
          ))}
        </ol>
      </details>
      {item.image && (
        <details className="dbv-sec" open={!batch}>
          <summary>
            <ChevronRight className="dbv-chev" aria-hidden="true" />
            {t({ id: 'components.debugView.screenshot', defaultMessage: 'Screenshot' })}
          </summary>
          <img
            className="dbv-shot"
            src={item.image}
            alt={t(
              { id: 'components.debugView.screenshotOf', defaultMessage: 'Screenshot of {name}' },
              { name },
            )}
          />
        </details>
      )}
      {pick.props && (
        <details className="dbv-sec" open>
          <summary>
            <ChevronRight className="dbv-chev" aria-hidden="true" />
            {t({ id: 'components.debugView.props', defaultMessage: 'Input data' })}
          </summary>
          <div className="dbv-code">
            <pre className="dbv-pre">{pick.props}</pre>
            <button
              type="button"
              className="ib dbv-copy"
              aria-label={t({
                id: 'components.debugView.copyProps',
                defaultMessage: 'Copy input data',
              })}
              onClick={() => copy(pick.props!)}
            >
              <Copy aria-hidden="true" />
            </button>
          </div>
        </details>
      )}
    </>
  );
}
