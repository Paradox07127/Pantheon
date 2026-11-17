import { Toast } from '@base-ui/react/toast';
import { Check, CircleDot, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { appErrors } from '../data/app-errors';
import { useNow } from '../data/needs-you';
import { t } from '../i18n';
import { useShell } from '../store';
import { DiffCounts } from './DiffCounts';
import './toast.css';
import './notice-card.css';

/** The app's one toast queue; `Toasts` shows it. */
export const toastManager = Toast.createToastManager();

/** A result of what the user did, a failure, or something only the user can settle. */
export type ToastKind = 'result' | 'failure' | 'needs';

// Zero keeps the toast until it is handled.
const TIMEOUTS: Record<ToastKind, number> = { result: 5000, failure: 10_000, needs: 0 };

export interface ToastOptions {
  title: string;
  /** One button, such as undo; pressing it also closes the toast. */
  action?: { label: string; run: () => void };
  kind?: ToastKind;
  /** Runs once the toast is gone, however it went. */
  onClose?: () => void;
  /** False keeps a failure without action from offering to ask the debug agent about it. */
  askAgent?: boolean;
}

/** A button on a notice card; pressing it also closes the card. */
export interface NoticeAction {
  label: string;
  run: () => void;
  /** The step the card asks for, drawn in ink. */
  primary?: boolean;
}

interface NoticeCardOptions {
  /** Names the card for `closeNotice`; a card shown again under the same id replaces it. */
  id?: string;
  /** In bold: the session's name, or a heading for several sessions. */
  heading: string;
  /** What happened, after the heading, such as "waiting for approval". */
  event?: string;
  /** A command, drawn as code. */
  command?: string;
  /** One line of text, such as the question asked or how many checks failed. */
  summary?: string;
  actions?: NoticeAction[];
  /** Where the card leads: an open button on a card that needs the user, the whole card on a result. */
  open?: () => void;
}

/** Something only the user can settle; it stays until the user acts or the caller closes it. */
export interface NeedsNoticeOptions extends NoticeCardOptions {
  /** When the wait began, in milliseconds since the epoch. */
  since?: number;
}

/** How a turn, a review or a merge came out; a failure stays twice as long. */
export interface ResultNoticeOptions extends NoticeCardOptions {
  tone: 'done' | 'review' | 'failed';
  diff?: { additions: number; deletions: number };
}

type NoticeCard =
  ({ tier: 'needs' } & NeedsNoticeOptions) | ({ tier: 'result' } & ResultNoticeOptions);

type ToastItem = Toast.Root.ToastObject<{ count: number; card?: NoticeCard }>;

// The newest toast without an action, which the same notice coming again joins.
let last: { key: string; id: string; count: number } | null = null;

/** Shows a short notice, held while the pointer or focus is on it. */
export function toast({
  title,
  action,
  kind = 'result',
  onClose,
  askAgent = true,
}: ToastOptions): string {
  const key = `${kind}:${title}`;
  const count = !action && last?.key === key ? last.count + 1 : 1;
  // A failure toast follows the failure it reports, so an entry this fresh is that failure.
  const newest = appErrors().at(-1);
  const error = newest && Date.now() - Date.parse(newest.at) <= 2000 ? newest : undefined;
  const button =
    action ??
    (kind === 'failure' && askAgent
      ? {
          label: t({ id: 'components.toast.askAgent', defaultMessage: 'Ask agent' }),
          // Loaded on demand: the debug report reaches modules that themselves show toasts.
          run: () =>
            void import('../data/ask-debug').then((m) =>
              m.askDebugAgent({ title, ...(error ? { error } : {}) }),
            ),
        }
      : undefined);
  // The button stays pressable while the toast fades out.
  let ran = false;
  const id: string = toastManager.add({
    ...(count > 1 ? { id: last!.id } : {}),
    title,
    type: kind,
    timeout: TIMEOUTS[kind],
    priority: kind === 'needs' ? 'high' : 'low',
    data: { count },
    onClose: () => {
      if (last?.id === id) last = null;
      onClose?.();
    },
    ...(button
      ? {
          actionProps: {
            children: button.label,
            onClick: () => {
              toastManager.close(id);
              if (ran) return;
              ran = true;
              button.run();
            },
          },
        }
      : {}),
  });
  last = action ? null : { key, id, count };
  return id;
}

/** Turns a toast's action off while `held`, such as an undo while another write runs. */
export function holdToastAction(id: string, held: boolean): void {
  toastManager.update(id, (shown) => ({ actionProps: { ...shown.actionProps, disabled: held } }));
}

function addCard(card: NoticeCard, kind: ToastKind): string {
  return toastManager.add({
    ...(card.id ? { id: card.id } : {}),
    title: card.heading,
    type: kind,
    timeout: TIMEOUTS[kind],
    priority: kind === 'needs' ? 'high' : 'low',
    data: { count: 1, card },
  });
}

/** Shows a card that needs the user and returns its id. */
export function noticeNeeds(options: NeedsNoticeOptions): string {
  return addCard({ tier: 'needs', ...options }, 'needs');
}

/** Shows a result card and returns its id. */
export function noticeResult(options: ResultNoticeOptions): string {
  return addCard({ tier: 'result', ...options }, options.tone === 'failed' ? 'failure' : 'result');
}

/** Takes a card away, as when the user settled it somewhere else. */
export function closeNotice(id: string): void {
  toastManager.close(id);
}

const MARKS: Record<ToastKind, typeof Check> = { result: Check, failure: X, needs: CircleDot };

function NoticeWaited({ since }: { since: number }) {
  const minutes = Math.floor((useNow(30_000) - since) / 60_000);
  return minutes < 1 ? null : (
    <span className="nc-wait">
      {t(
        { id: 'components.noticeCard.waited', defaultMessage: 'waited {minutes} min' },
        { minutes },
      )}
    </span>
  );
}

const closeButton = () => (
  <Toast.Close
    className="ib toast-x"
    aria-label={t({ id: 'components.toast.close', defaultMessage: 'Dismiss' })}
  >
    <X aria-hidden="true" />
  </Toast.Close>
);

// A plain function rather than a component, so the card's parts render with the list.
function noticeCard(item: ToastItem, card: NoticeCard, life: ReactNode) {
  const closing = (go: () => void) => () => {
    // The card stays pressable while it fades out.
    if (item.transitionStatus === 'ending') return;
    toastManager.close(item.id);
    go();
  };
  const open = card.open && closing(card.open);
  const actions = card.actions ?? [];
  const openButton = card.tier === 'needs' && open;
  return (
    <Toast.Root key={item.id} toast={item} className="toast nc">
      {card.tier === 'result' && open && (
        <button
          type="button"
          className="nc-hit"
          aria-label={t(
            { id: 'components.noticeCard.openTitle', defaultMessage: 'Open {title}' },
            { title: card.heading },
          )}
          onClick={open}
        />
      )}
      <span
        className="nc-mark"
        data-mark={card.tier === 'needs' ? 'wait' : card.tone}
        aria-hidden="true"
      />
      <div className="nc-row">
        <Toast.Title className="nc-title">
          <span className="nc-name">{card.heading}</span>
          {card.event && (
            <>
              {' '}
              <span className="nc-event">{card.event}</span>
            </>
          )}
        </Toast.Title>
        {card.tier === 'needs' && card.since !== undefined && <NoticeWaited since={card.since} />}
        {closeButton()}
      </div>
      {card.tier === 'needs' ? (
        <>
          {card.command && <code className="nc-cmd">{card.command}</code>}
          {card.summary && <p className="nc-text">{card.summary}</p>}
        </>
      ) : (
        <>
          {(card.command || card.summary) && (
            <p className="nc-line">
              {card.command && <code className="nc-code">{card.command}</code>}
              {card.summary && <span className="nc-note">{card.summary}</span>}
            </p>
          )}
          {card.diff && (
            <span className="nc-diff">
              <DiffCounts additions={card.diff.additions} deletions={card.diff.deletions} />
            </span>
          )}
        </>
      )}
      {(actions.length > 0 || openButton) && (
        <div className="nc-acts">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className={action.primary ? 'btn sm pri' : 'btn sm'}
              onClick={closing(action.run)}
            >
              {action.label}
            </button>
          ))}
          {openButton && (
            <button
              type="button"
              className={actions.length > 0 ? 'btn sm ghost nc-open' : 'btn sm'}
              onClick={open}
            >
              {t({ id: 'components.noticeCard.open', defaultMessage: 'Open' })}
            </button>
          )}
        </div>
      )}
      {life}
    </Toast.Root>
  );
}

/** The toasts, newest first, after a button for the older ones waiting behind the shown three. */
export function ToastItems({ toasts }: { toasts: ToastItem[] }) {
  const waiting = toasts.filter((item) => item.limited && item.transitionStatus !== 'ending');
  return (
    <>
      {waiting.length > 0 && (
        <button
          type="button"
          className="btn sm toast-more"
          onClick={() => useShell.getState().openSessionGroup('inbox')}
        >
          {t(
            { id: 'overlays.toast.more', defaultMessage: '{count} more' },
            { count: waiting.length },
          )}
        </button>
      )}
      {toasts.map((item) => {
        const life = item.timeout ? (
          <span
            className="toast-life"
            style={{ animationDuration: `${item.timeout}ms` }}
            aria-hidden="true"
          />
        ) : null;
        if (item.data?.card) return noticeCard(item, item.data.card, life);
        const kind = (item.type ?? 'result') as ToastKind;
        const Mark = MARKS[kind];
        const count = item.data?.count ?? 1;
        return (
          <Toast.Root key={item.id} toast={item} className="toast">
            <Toast.Content className="toast-body">
              <Mark className="toast-mark" data-kind={kind} aria-hidden="true" />
              <Toast.Title className="toast-title" />
              {count > 1 && (
                <span className="toast-n">
                  {t(
                    {
                      id: 'overlays.toast.count',
                      defaultMessage: '{count, plural, one {# time} other {# times}}',
                    },
                    { count },
                  )}
                </span>
              )}
              <Toast.Action className={kind === 'needs' ? 'btn sm pri' : 'btn sm'} />
              {closeButton()}
            </Toast.Content>
            {life}
          </Toast.Root>
        );
      })}
    </>
  );
}

function ToastList() {
  return <ToastItems toasts={Toast.useToastManager().toasts as ToastItem[]} />;
}

/** Sets `--toast-reserve` to the stack's height, which the surfaces under it leave free at their end. */
function reserve(viewport: HTMLDivElement | null) {
  if (!viewport) return;
  const root = document.documentElement.style;
  const observer = new ResizeObserver(() =>
    root.setProperty('--toast-reserve', `${viewport.offsetHeight}px`),
  );
  observer.observe(viewport);
  return () => {
    observer.disconnect();
    root.removeProperty('--toast-reserve');
  };
}

/** The toast stack in the window's corner, at most three deep. */
export function Toasts() {
  return (
    <Toast.Provider toastManager={toastManager} limit={3} timeout={TIMEOUTS.result}>
      <Toast.Portal>
        <Toast.Viewport
          ref={reserve}
          className="toast-vp"
          aria-label={t({ id: 'components.toast.region', defaultMessage: 'Notifications' })}
        >
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}
