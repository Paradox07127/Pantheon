import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { Box, Braces, Component, FileText, SquareFunction, Type, Zap } from 'lucide-react';
import { create } from 'zustand';
import {
  command,
  USER_PRINCIPAL_ID,
  type BridgeResult,
  type Command,
  type WorkbenchSession,
} from '@pantheon/protocol';
import { runtimeName, runtimeTraits } from '../../components/RuntimeGlyph';
import { KeyHint } from '../../components/Shortcuts';
import { Tip } from '../../components/Tip';
import { toast } from '../../components/Toast';
import { useBoard } from '../../data/board';
import { runCommand } from '../../data/commands';
import { searchSymbols, type CodeSymbol } from '../../data/code-refs';
import {
  draftKey,
  EMPTY_DRAFT,
  githubRefKey,
  useDrafts,
  whenUploaded,
  type DraftMessage,
  type GithubRef,
  type SkillRef,
} from '../../data/drafts';
import { useFeedback, withFeedback, type FeedbackItem } from '../../data/feedback';
import { getLook } from '../../data/layout';
import { failureText, reasonText, type Availability } from '../../data/needs-you';
import { searchFiles, useSkills } from '../../data/runtime-models';
import { supports, useRuntimeStatus } from '../../data/runtime-status';
import { resolveComment } from '../../data/session-comments';
import { compactSession } from '../../data/session-compact';
import { getSessionDisplay } from '../../data/session-display';
import { composeState, sessionPurpose, type Session } from '../../data/transcript';
import { t } from '../../i18n';
import {
  keyText,
  onMac,
  shortcutKeys,
  shortcutMatches,
  type ShortcutId,
} from '../../lib/shortcuts';
import { ipcFailed, markSend, NO_BRIDGE } from './attachments';
import { applyCompletion, completionAt, matchSkills, removeCompletion } from './completion';
import './completion.css';

export type { SkillRef };

/**
 * The `refs` a turn's input carries for the sessions, pull requests and issues it refers to;
 * nothing for none.
 */
export function refsInput(
  refs: readonly WorkbenchSession[] | undefined,
  github?: readonly GithubRef[],
) {
  const all = [
    ...(refs ?? []).map((r) => ({ kind: 'session' as const, id: r.id })),
    ...(github ?? []).map((r) => ({ kind: r.kind, number: r.number })),
  ];
  return all.length ? { refs: all } : {};
}

/** Whether the text holds `$name` as a whole token, not as the start of a longer name. */
const namesSkill = (text: string, name: string): boolean =>
  new RegExp(`\\$${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_-])`, 'u').test(
    text,
  );

/** The skills picked for the next message, kept in the draft under key. */
export function usePickedSkills(key: string) {
  // `$name` stands for the skill of that name picked last.
  const add = (skill: SkillRef) =>
    useDrafts.getState().update(key, (draft) => ({
      skills: [...draft.skills.filter((s) => s.name !== skill.name), skill],
    }));
  // A skill whose `$name` the user deleted from the message is not sent.
  const inText = (text: string) =>
    (useDrafts.getState().drafts[key] ?? EMPTY_DRAFT).skills.filter((s) =>
      namesSkill(text, s.name),
    );
  return { add, inText };
}

export interface CompletionItem {
  key: string;
  label: string;
  mono: boolean;
  insert: string;
  skill: SkillRef | null;
  /** The caption of the group the option is under; a command's or skill's only with no query typed. */
  group?: string;
  /** What picking the option does instead of inserting it: a chip on the box, or a review. */
  action?: 'reference' | 'review';
  /** What the command does, or where the symbol is, on the right of its row. */
  hint?: string;
  /** The code symbol's kind, drawn as its icon. */
  symbol?: string;
}

/** Pantheon's own commands: compact is sent as typed, review runs when picked. */
const COMMANDS = [{ name: 'compact' }, { name: 'review' }];

const commandHint = (name: string) =>
  name === 'compact'
    ? t({ id: 'sessions.completion.compactHint', defaultMessage: 'Compact the context' })
    : t({ id: 'sessions.completion.reviewHint', defaultMessage: 'Review this change' });

/** `/compact` and what follows it as one line of instructions; null for other text. */
function compactText(text: string): string | null {
  const match = /^\/compact(?:\s([\s\S]*))?$/.exec(text.trim());
  return match ? (match[1] ?? '').replace(/\s+/g, ' ').trim() : null;
}

/** Asks the other vendor to review the session's change, as the review panel's request does. */
async function requestReview(session_id: string, runtime: string) {
  const reviewer = runtimeTraits(runtime).reviewer;
  const result = await runCommand(
    'review.request',
    { session_id, runtimes: [reviewer] },
    null,
  ).catch(ipcFailed);
  if (result.ok)
    toast({
      title: t(
        { id: 'sessions.completion.reviewAsked', defaultMessage: 'Asked {runtime} to review' },
        { runtime: runtimeName(reviewer) },
      ),
    });
  else toast({ title: failureText(result.error), kind: 'failure' });
}

/** Marks the stored comment a sent message carried as sent; a refusal shows as a failure toast. */
export async function commentSent(comment: { id: string; revision: number }) {
  const result = await resolveComment(comment, 'sent').catch(ipcFailed);
  if (!result.ok) toast({ title: failureText(result.error), kind: 'failure' });
}

const MAX_OPTIONS = 8;
const SEARCH_DELAY_MS = 150;
const NO_PATHS: { for: string | null; list: readonly string[] } = { for: null, list: [] };
const NO_SYMBOLS: { for: string | null; list: readonly CodeSymbol[] } = { for: null, list: [] };
let completionLists = 0;

const SYMBOL_ICON: Record<string, typeof FileText> = {
  function: SquareFunction,
  class: Box,
  struct: Box,
  interface: Component,
  trait: Component,
  type: Type,
  enum: Type,
};

/**
 * `@` completes a file path or a code symbol, a leading `/` a command or skill. Arrows move, Enter
 * or Tab picks and Esc closes while options show; `onKeyDown` says whether it took the key.
 */
export function useCompletion(props: {
  project_id: string;
  session_id: string | null;
  runtime: string;
  /** The runtime whose skills complete, when it is not the session's own. */
  skillsOf?: string;
  text: string;
  onText: (text: string) => void;
  onSkill: (skill: SkillRef) => void;
  box: RefObject<HTMLTextAreaElement | null>;
  /** The session's runtime compacts its context on request. */
  compactable?: boolean;
}) {
  const { project_id, session_id, runtime, text } = props;
  const skillRuntime = props.skillsOf ?? runtime;
  const skills = useSkills(project_id, skillRuntime);
  const [id] = useState(() => `completion-${++completionLists}`);
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState<{ key: string | null; index: number }>({
    key: null,
    index: 0,
  });
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [paths, setPaths] = useState(NO_PATHS);
  const [symbols, setSymbols] = useState(NO_SYMBOLS);
  const moveTo = useRef<number | null>(null);
  const at = caret === null ? null : completionAt(text, Math.min(caret, text.length));
  const key = at ? `${at.kind}${at.start}:${at.query}` : null;
  const query = at?.kind === '@' ? at.query : null;
  // Found paths count only for the search they answer.
  const search = query === null ? null : `${project_id}\n${session_id ?? ''}\n${query}`;

  useEffect(() => {
    if (query === null) {
      setPaths(NO_PATHS);
      setSymbols(NO_SYMBOLS);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      void searchFiles(project_id, session_id, query).then((result) => {
        if (current)
          setPaths({ for: search, list: result.ok ? result.value.slice(0, MAX_OPTIONS) : [] });
      });
      // An empty query matches every symbol, so a bare @ lists files only.
      if (query !== '')
        void searchSymbols(project_id, session_id, query).then((result) => {
          if (current)
            setSymbols({ for: search, list: result.ok ? result.value.slice(0, MAX_OPTIONS) : [] });
        });
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query, project_id, session_id]);

  // A picked option replaces the value, so the caret is put back after the inserted text.
  useEffect(() => {
    const to = moveTo.current;
    moveTo.current = null;
    if (to !== null) props.box.current?.setSelectionRange(to, to);
  }, [text]);

  // Esc closes the options only until the token or its query changes.
  useEffect(() => {
    if (key !== dismissed) setDismissed(null);
  }, [key]);

  const { skillSigil: sigil, skillPath } = runtimeTraits(skillRuntime);
  // Commands act on the session, so the new-session composer has none.
  const commands =
    at?.kind === '/' && session_id !== null
      ? matchSkills(
          COMMANDS.filter((c) => c.name !== 'compact' || props.compactable),
          at.query,
        )
      : [];
  // A skill whose row would read like a shown command's is left out: the command takes the name.
  const matched =
    at?.kind === '/'
      ? matchSkills(skills, at.query).filter(
          (s) => sigil !== '/' || !commands.some((c) => c.name === s.name),
        )
      : [];
  const grouped = at?.query === '';
  const found = paths.for === search ? paths.list : [];
  const foundSymbols = symbols.for === search ? symbols.list : [];
  // Symbols take the rows the files leave, and at least half of them.
  const symbolRows = foundSymbols.slice(0, Math.max(MAX_OPTIONS / 2, MAX_OPTIONS - found.length));
  const reference = session_id !== null ? { action: 'reference' as const } : {};
  const items: CompletionItem[] = (
    !at || key === dismissed
      ? []
      : at.kind === '@'
        ? [
            ...found.slice(0, MAX_OPTIONS - symbolRows.length).map((path) => ({
              key: path,
              label: path,
              mono: true,
              insert: `@${path}`,
              skill: null,
              ...reference,
            })),
            ...symbolRows.map((s) => ({
              key: `${s.path}:${s.line}`,
              label: s.name,
              mono: false,
              insert: `@${s.path}:${s.line}`,
              skill: null,
              ...reference,
              hint: `${s.path}:${s.line}`,
              symbol: s.kind,
              group: t({ id: 'sessions.completion.symbols', defaultMessage: 'Symbols' }),
            })),
          ]
        : [
            ...commands.map((c) => ({
              key: `command:${c.name}`,
              label: `/${c.name}`,
              mono: false,
              insert: `/${c.name}`,
              skill: null,
              ...(c.name === 'review' ? { action: 'review' as const } : {}),
              hint: commandHint(c.name),
              ...(grouped
                ? {
                    group: t({ id: 'sessions.completion.commands', defaultMessage: 'Commands' }),
                  }
                : {}),
            })),
            ...matched.map((s) => ({
              key: s.id,
              // Skills sharing a name are told apart by their path.
              label:
                s.path && matched.some((o) => o !== s && o.name === s.name)
                  ? `${sigil}${s.name} ${s.path}`
                  : `${sigil}${s.name}`,
              mono: false,
              insert: `${sigil}${s.name}`,
              skill: skillPath && s.path ? { name: s.name, path: s.path } : null,
              ...(grouped
                ? { group: t({ id: 'sessions.completion.skills', defaultMessage: 'Skills' }) }
                : {}),
            })),
          ]
  ).slice(0, MAX_OPTIONS);
  const open = items.length > 0;
  const index = active.key === key ? Math.min(active.index, items.length - 1) : 0;

  function pick(item: CompletionItem) {
    if (!at || caret === null) return;
    const where = Math.min(caret, text.length);
    const next = item.action
      ? removeCompletion(text, where, at)
      : applyCompletion(text, where, at, item.insert);
    moveTo.current = next.caret;
    setCaret(next.caret);
    props.onText(next.text);
    if (item.skill) props.onSkill(item.skill);
    if (session_id === null) return;
    if (item.action === 'reference') {
      const mention: FeedbackItem = {
        id: `reference:${item.key}`,
        kind: 'reference',
        label: item.key,
        text: item.insert,
      };
      useDrafts
        .getState()
        .update(draftKey(project_id, session_id), (draft) =>
          draft.mentions?.some((m) => m.id === mention.id)
            ? {}
            : { mentions: [...(draft.mentions ?? []), mention] },
        );
    }
    if (item.action === 'review') void requestReview(session_id, runtime);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!open || e.nativeEvent.isComposing) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : items.length - 1;
      setActive({ key, index: (index + step) % items.length });
      return true;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
      e.preventDefault();
      pick(items[index]!);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setDismissed(key);
      return true;
    }
    return false;
  }

  return {
    id,
    items,
    active: index,
    pick,
    onKeyDown,
    /** Call with the caret after each change of the value. */
    moved: setCaret,
    textarea: {
      ref: props.box,
      'aria-autocomplete': 'list' as const,
      'aria-expanded': open,
      'aria-controls': open ? id : undefined,
      'aria-activedescendant': open ? `${id}-${index}` : undefined,
      onSelect: (e: { currentTarget: HTMLTextAreaElement }) =>
        setCaret(e.currentTarget.selectionStart),
      onBlur: () => setCaret(null),
    },
  };
}

/**
 * The completion options above the composer's textarea, under their group captions while no
 * query is typed; nothing without options.
 */
export function CompletionPopup(props: {
  id: string;
  items: readonly CompletionItem[];
  active: number;
  onPick: (item: CompletionItem) => void;
}) {
  if (props.items.length === 0) return null;
  const option = (item: CompletionItem, i: number) => {
    const Icon = item.symbol ? (SYMBOL_ICON[item.symbol] ?? Braces) : item.mono ? FileText : Zap;
    return (
      <div
        key={item.key}
        id={`${props.id}-${i}`}
        role="option"
        aria-selected={i === props.active}
        className={item.mono ? 'cp-cmo mono' : 'cp-cmo'}
        title={item.label}
        // Pressing keeps the focus in the textarea.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => props.onPick(item)}
      >
        <Icon className="cp-cmi" aria-hidden="true" />
        <span className="cp-cml">{item.label}</span>
        {item.hint && <span className={item.symbol ? 'cp-cmh mono' : 'cp-cmh'}>{item.hint}</span>}
      </div>
    );
  };
  const shown = props.items.slice(0, MAX_OPTIONS);
  const groups = shown.flatMap((item, i) =>
    item.group !== undefined && item.group !== shown[i - 1]?.group
      ? [{ caption: item.group, from: i }]
      : [],
  );
  return (
    <div
      id={props.id}
      className="wmenu pop ss-cmp"
      role="listbox"
      aria-label={t({ id: 'sessions.composer.completions', defaultMessage: 'Completions' })}
    >
      {shown.slice(0, groups[0]?.from ?? shown.length).map(option)}
      {groups.map((g, n) => (
        <div key={g.caption} className="cp-cmg" role="group" aria-labelledby={`${props.id}-g${n}`}>
          <div id={`${props.id}-g${n}`} className="cp-cap">
            {g.caption}
          </div>
          {shown
            .slice(g.from, groups[n + 1]?.from ?? shown.length)
            .map((item, i) => option(item, g.from + i))}
        </div>
      ))}
    </div>
  );
}

const ESC_AGAIN_MS = 1_500;
const INTERRUPTED_MS = 4_000;

/** What the composer's status line says about the keys: Esc pressed once, or the turn interrupted. */
export type ComposeNotice = 'armed' | 'interrupted' | null;

/**
 * A session's composer: while a turn runs the send key queues or steers as Session display chose and
 * ⌘Enter does the other; Esc twice interrupts. A send waits for uploads; `/compact` alone compacts.
 */
export function useCompose(
  session: Session,
  skills?: { inText: (text: string) => SkillRef[] },
  feedback?: { items: readonly FeedbackItem[]; clear: (ids: readonly string[]) => void },
  box?: RefObject<HTMLTextAreaElement | null>,
  queue?: () => void,
  /** The session's runtime compacts on request, taking instructions or not. */
  compaction?: { runtime: string; instructions: boolean } | null,
) {
  const key = draftKey(session.project_id, session.id);
  const input = useDrafts((s) => s.drafts[key]?.text) ?? '';
  const sending = useRef(false);
  const [busy, setBusy] = useState<'session.send' | 'session.steer' | 'session.interrupt' | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ComposeNotice>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const state = composeState(session);
  const empty = input.trim() === '' && !feedback?.items.length;
  const interruptible =
    session.state === 'running' &&
    !session.stop_pending &&
    sessionPurpose(session) === 'conversation';

  function note(next: ComposeNotice, ms = 0) {
    clearTimeout(noticeTimer.current);
    setNotice(next);
    noticeTimer.current = next ? setTimeout(() => setNotice(null), ms) : undefined;
  }
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  async function submit(type: 'session.send' | 'session.steer', allowed: Availability) {
    if (!allowed.enabled || empty || sending.current) return;
    sending.current = true;
    if (notice === 'interrupted') note(null);
    const text = input;
    setBusy(type);
    setError(null);
    // What the message carries is taken with its text; what is added while it waits is the next one's.
    const { refs, github, comments, mentions } = useDrafts.getState().drafts[key] ?? EMPTY_DRAFT;
    const files = markSend(key);
    if (useDrafts.getState().drafts[key]?.uploading) await whenUploaded(key);
    const failed = files.failure();
    if (failed) {
      setBusy(null);
      sending.current = false;
      setError(failed);
      return;
    }
    const ids = files.ids();
    const picked = skills?.inText(text) ?? [];
    const carried = feedback?.items ?? [];
    // A message carrying anything besides its text is sent, so nothing the user put on it is lost.
    const instructions =
      compaction &&
      !ids.length &&
      !refs.length &&
      !github.length &&
      !picked.length &&
      !carried.length
        ? compactText(text)
        : null;
    if (instructions && !compaction!.instructions) {
      setBusy(null);
      sending.current = false;
      setError(
        t(
          {
            id: 'sessions.completion.compactNoInstructions',
            defaultMessage: '{runtime} takes no instructions for a compaction',
          },
          { runtime: runtimeName(compaction!.runtime) },
        ),
      );
      return;
    }
    const result = await (
      instructions !== null
        ? compactSession(session.id, instructions, session.revision)
        : runCommand(
            type,
            {
              session_id: session.id,
              input: withFeedback(text, carried),
              ...(ids.length ? { attachments: ids } : {}),
              ...(picked.length ? { skills: picked } : {}),
              ...refsInput(refs, github),
            },
            session.revision,
          )
    ).catch((reason: unknown): BridgeResult<unknown> => ({
      ok: false,
      error: { code: 'ipc_failed', message: String(reason) },
    }));
    setBusy(null);
    sending.current = false;
    if (result.ok) {
      // What changed while the message was in flight stays for the next one: a skill the newer
      // text still names, and an item taken off and attached again.
      const now = (useDrafts.getState().drafts[key] ?? EMPTY_DRAFT).text;
      const left = now === text ? '' : now;
      useDrafts.getState().sent(key, {
        text,
        attachments: ids,
        skills: picked.filter((skill) => !namesSkill(left, skill.name)).map((skill) => skill.name),
        refs: refs.map((r) => r.id),
        github: github.map(githubRefKey),
        comments: comments?.map((c) => c.id),
        mentions: mentions?.map((m) => m.id),
      });
      const attached = useFeedback.getState().items[session.id] ?? [];
      feedback?.clear(carried.filter((item) => attached.includes(item)).map((item) => item.id));
      // A comment both attached and in the draft is marked once; a second mark meets a conflict.
      const marked = new Map<string, { id: string; revision: number }>();
      for (const item of carried) if (item.comment) marked.set(item.comment.id, item.comment);
      for (const comment of comments ?? []) marked.set(comment.id, comment);
      for (const comment of marked.values()) void commentSent(comment);
    } else
      setError(
        t(
          { id: 'data.failure.reasonMessage', defaultMessage: '{reason} ({message})' },
          { reason: reasonText(result.error.code), message: result.error.message },
        ),
      );
  }

  async function interrupt() {
    if (!interruptible || sending.current) return;
    sending.current = true;
    setBusy('session.interrupt');
    setError(null);
    const result = await runCommand(
      'session.interrupt',
      { session_id: session.id },
      session.revision,
    ).catch((reason: unknown): BridgeResult<unknown> => ({
      ok: false,
      error: { code: 'ipc_failed', message: String(reason) },
    }));
    setBusy(null);
    sending.current = false;
    if (result.ok) note('interrupted', INTERRUPTED_MS);
    else
      setError(
        t(
          { id: 'data.failure.reasonMessage', defaultMessage: '{reason} ({message})' },
          { reason: reasonText(result.error.code), message: result.error.message },
        ),
      );
  }

  const change = (value: string) => useDrafts.getState().update(key, () => ({ text: value }));

  const prefill = usePrefill((s) => s.prefill[session.id]);
  useEffect(() => {
    if (prefill === undefined) return;
    const message = usePrefill.getState().take(session.id);
    if (message === undefined) return;
    useDrafts.getState().put(key, message);
    box?.current?.focus();
  }, [prefill, session.id]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape' && interruptible) {
      e.preventDefault();
      if (notice !== 'armed') return note('armed', ESC_AGAIN_MS);
      note(null);
      void interrupt();
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey) return;
    const metaSends = getLook().send_key === 'meta-enter';
    const sendKey = !metaSends || shortcutMatches('send', e);
    if (state.send.enabled) {
      // With ⌘Enter sending, Enter starts a new line.
      if (!sendKey) return;
      e.preventDefault();
      void submit('session.send', state.send);
      return;
    }
    if (!state.steer.enabled) return;
    const other = !metaSends && !!(onMac() ? e.metaKey : e.ctrlKey);
    if (!other && !sendKey) return;
    e.preventDefault();
    const steers = other !== (getSessionDisplay().running_send === 'steer');
    if (steers) void submit('session.steer', state.steer);
    // The box still holds the text a send or steer is delivering.
    else if (!empty && busy === null) queue?.();
  };

  return {
    input,
    change,
    busy,
    error,
    setError,
    /** Held while a message is on its way; a send key pressed meanwhile does nothing. */
    sending,
    notice,
    state,
    empty,
    submit,
    interrupt,
    interruptible,
    onKeyDown,
  };
}

export function SendButton(props: {
  label: string;
  busyLabel?: string;
  pri?: boolean;
  /** Drawn instead of the label, which then names the button, on the session composer's ink key. */
  icon?: ReactNode;
  /** The entry whose keys press the button, shown as its key hint. */
  shortcut?: ShortcutId;
  /** The key queues or steers a running turn, and ⌘Enter does the other. */
  steers?: boolean;
  busy: boolean;
  state: Availability;
  empty: boolean;
  onPress: () => void;
}) {
  const off = !props.state.enabled || props.empty || props.busy;
  const label = props.busy
    ? (props.busyLabel ?? t({ id: 'sessions.composer.sending', defaultMessage: 'Sending…' }))
    : props.label;
  const other = props.steers ? shortcutKeys('steer') : '';
  const button = (
    <button
      type="button"
      className={props.icon ? 'cp-send' : props.pri ? 'btn pri' : 'btn'}
      aria-label={
        other
          ? t(
              {
                id: 'sessions.completion.sendOther',
                defaultMessage: '{action}, {keys} {then, select, steer {steers} other {queues}}',
              },
              {
                action: label,
                keys: keyText(other),
                then: getSessionDisplay().running_send === 'steer' ? 'queue' : 'steer',
              },
            )
          : props.icon
            ? label
            : undefined
      }
      aria-disabled={off || undefined}
      aria-keyshortcuts={props.shortcut && shortcutKeys(props.shortcut)}
      onClick={() => {
        if (!off) props.onPress();
      }}
    >
      {props.icon ?? label}
      {props.shortcut && <KeyHint id={props.shortcut} />}
      {other !== '' && <KeyHint id="steer" />}
    </button>
  );
  const reason =
    props.state.reason ??
    (props.empty
      ? t({ id: 'sessions.composer.writeFirst', defaultMessage: 'Write a message first' })
      : null);
  return reason ? <Tip content={reason}>{button}</Tip> : button;
}

export type QueuedMessage = DraftMessage;

// Each queued message is stored on its own under this prefix and an id of its own, so it outlives
// the window, every window shows it, and windows queuing or taking messages at once never write
// over each other's.
const QUEUE_STORED = 'pantheon.queued.';

/** Where a queued message is stored, and when it was queued, which orders it in its queue. */
interface Place {
  key: string;
  at: number;
}

const places = new WeakMap<QueuedMessage, Place>();
/** The latest time a message this window knows of was queued; one queued next comes after it. */
let latest = 0;

function setPlace(message: QueuedMessage, key: string, at: number) {
  places.set(message, { key, at });
  latest = Math.max(latest, at);
}

const isMessage = (m: Partial<QueuedMessage> | null | undefined) =>
  typeof m?.text === 'string' &&
  Array.isArray(m.attachments) &&
  Array.isArray(m.skills) &&
  (m.refs === undefined || Array.isArray(m.refs));

/** A session's whole queue, as stored before each message was stored on its own. */
function readQueue(raw: string | null): QueuedMessage[] | null {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    return Array.isArray(value) ? value.filter(isMessage) : null;
  } catch {
    return null;
  }
}

function readStored(key: string, raw: string | null) {
  try {
    const value = JSON.parse(raw ?? 'null');
    return typeof value?.session === 'string' &&
      typeof value.at === 'number' &&
      isMessage(value.message)
      ? {
          key,
          at: value.at as number,
          session: value.session as string,
          message: value.message as QueuedMessage,
        }
      : null;
  } catch {
    return null;
  }
}

const later = (place: Place | undefined, than: Place) =>
  !!place && (place.at > than.at || (place.at === than.at && place.key > than.key));

/** The list with the placed message at its place among the list's. */
const placed = (list: readonly QueuedMessage[], message: QueuedMessage) => {
  const at = list.findIndex((m) => later(places.get(m), places.get(message)!));
  return at < 0 ? [...list, message] : [...list.slice(0, at), message, ...list.slice(at)];
};

function loadQueues(): Record<string, readonly QueuedMessage[]> {
  const queued: Record<string, readonly QueuedMessage[]> = {};
  try {
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
    for (const key of keys) {
      if (!key?.startsWith(QUEUE_STORED)) continue;
      const raw = localStorage.getItem(key);
      // A queue stored whole is stored again a message at a time, in its order.
      const whole = readQueue(raw);
      const stored = whole
        ? whole.map((message, i) => ({
            key: `${key}.${i}`,
            at: i,
            session: key.slice(QUEUE_STORED.length),
            message,
          }))
        : [readStored(key, raw)].flatMap((one) => one ?? []);
      for (const { key, at, session, message } of stored) {
        setPlace(message, key, at);
        queued[session] = placed(queued[session] ?? NONE, message);
        if (whole) localStorage.setItem(key, JSON.stringify({ session, at, message }));
      }
      if (whole) localStorage.removeItem(key);
    }
  } catch {
    // Unreadable storage starts with nothing queued.
  }
  return queued;
}

interface QueuedMessages {
  /** Messages waiting for each session's next idle moment, as stored. */
  queued: Readonly<Record<string, readonly QueuedMessage[]>>;
  /** Why the last queued send to each session failed. */
  failures: Readonly<Record<string, string>>;
  add: (id: string, message: QueuedMessage) => void;
  remove: (id: string, index: number) => void;
  /** Takes the first queued message off; undefined when none is queued or another window took it. */
  shift: (id: string) => QueuedMessage | undefined;
  /** Puts a message back in front, after its send failed. */
  unshift: (id: string, message: QueuedMessage) => void;
  /** Puts a message back at its place, after steering with it failed. */
  insert: (id: string, index: number, message: QueuedMessage) => void;
}

const NONE: readonly QueuedMessage[] = [];

export const useQueued = create<QueuedMessages>()((set, get) => {
  // Messages this window could not store; only it holds them.
  const unstored = new WeakSet<QueuedMessage>();
  const list = (id: string) => get().queued[id] ?? NONE;
  const put = (id: string, next: readonly QueuedMessage[]) =>
    set((s) => ({ queued: { ...s.queued, [id]: next } }));
  const store = (id: string, message: QueuedMessage) => {
    if (!places.has(message))
      setPlace(message, QUEUE_STORED + crypto.randomUUID(), Math.max(Date.now(), latest + 1));
    const { key, at } = places.get(message)!;
    try {
      localStorage.setItem(key, JSON.stringify({ session: id, at, message }));
      unstored.delete(message);
    } catch {
      // The message still holds in this window.
      unstored.add(message);
    }
  };
  const unstore = (message: QueuedMessage) => {
    try {
      const place = places.get(message);
      if (place) localStorage.removeItem(place.key);
    } catch {
      // The message is off this window's queue all the same.
    }
  };
  return {
    queued: loadQueues(),
    failures: {},
    add: (id, message) => {
      places.delete(message);
      store(id, message);
      put(id, placed(list(id), message));
    },
    remove: (id, index) => {
      const message = list(id)[index];
      if (message === undefined) return;
      unstore(message);
      put(
        id,
        list(id).filter((_, i) => i !== index),
      );
    },
    // Only one window sends a message: the one that takes it off storage.
    shift: (id) => {
      const [first, ...rest] = list(id);
      if (first === undefined) return undefined;
      const place = places.get(first);
      let taken = false;
      try {
        taken = !!place && !unstored.has(first) && localStorage.getItem(place.key) === null;
      } catch {
        // Without storage this window's queue is the only one.
      }
      unstore(first);
      put(id, rest);
      return taken ? undefined : first;
    },
    unshift: (id, message) => {
      store(id, message);
      put(id, [message, ...list(id)]);
    },
    insert: (id, index, message) => {
      store(id, message);
      put(id, [...list(id).slice(0, index), message, ...list(id).slice(index)]);
    },
  };
});

// Another window queued, withdrew or took a message: this one shows it.
if (typeof window !== 'undefined')
  window.addEventListener('storage', (e) => {
    const key = e.key;
    if (!key?.startsWith(QUEUE_STORED)) return;
    const one = readStored(key, e.newValue);
    useQueued.setState((s) => {
      const [id, list] =
        Object.entries(s.queued).find(([, l]) => l.some((m) => places.get(m)?.key === key)) ?? [];
      if (one) {
        if (id !== undefined) return s;
        setPlace(one.message, key, one.at);
        return {
          queued: {
            ...s.queued,
            [one.session]: placed(s.queued[one.session] ?? NONE, one.message),
          },
        };
      }
      if (id === undefined) return s;
      return { queued: { ...s.queued, [id]: list!.filter((m) => places.get(m)?.key !== key) } };
    });
  });

/** Failures after which the daemon may still have committed the command. */
const UNANSWERED = ['command_timeout', 'ipc_failed'];

async function sendCommand(sent: Command): Promise<BridgeResult<unknown>> {
  const bridge = window.pantheon;
  if (!bridge) return { ok: false, error: NO_BRIDGE };
  const result = await bridge.command(sent).catch(ipcFailed);
  if (result.ok || ['revision_conflict', 'command_timeout'].includes(result.error.code))
    useBoard.getState().refresh();
  return result;
}

/** Sends each session's first queued message once the session can take it; mounted once by App. */
export function useQueueDispatch() {
  const queued = useQueued((s) => s.queued);
  const sessions = useBoard((s) => s.board?.sessions);
  // Each return of the board to live is a new status object.
  const live = useBoard((s) => (s.status?.state === 'live' ? s.status : null));
  const resync = useBoard((s) => s.resync);
  const runtimeStatus = useRuntimeStatus();
  const reports = runtimeStatus.read.state === 'ready' ? runtimeStatus.read.statuses : [];
  const asking = runtimeStatus.read.state === 'loading';
  // Per session: the turn count a queued message was sent at; the next one waits for a later turn.
  const sentAt = useRef(new Map<string, number>());
  // Per queued message: where its send failed; it is tried again at the next revision, resync or
  // return of the board to live.
  const failedAt = useRef(
    new WeakMap<QueuedMessage, { revision: number; live: unknown; resync: number }>(),
  );
  // Per queued message: the send that got no answer, sent again as is so the daemon answers it
  // from its receipt when it committed.
  const unanswered = useRef(new WeakMap<QueuedMessage, Command>());

  async function deliver(session: Session, message: QueuedMessage) {
    const ids = message.attachments.map((a) => a.id);
    const report = reports.find((r) => r.runtime === session.runtime);
    // `/compact` carrying nothing else compacts, as sending it at once does.
    const instructions =
      report &&
      supports(report, 'manual_compaction') &&
      !ids.length &&
      !message.skills.length &&
      !message.refs?.length &&
      !message.github?.length &&
      !message.comments?.length
        ? compactText(message.text)
        : null;
    const fresh = () =>
      instructions !== null
        ? command(
            USER_PRINCIPAL_ID,
            'session.compact',
            { session_id: session.id, ...(instructions ? { instructions } : {}) },
            session.revision,
          )
        : command(
            USER_PRINCIPAL_ID,
            'session.send',
            {
              session_id: session.id,
              input: message.text,
              ...(ids.length ? { attachments: ids } : {}),
              ...(message.skills.length ? { skills: message.skills } : {}),
              ...refsInput(message.refs, message.github),
            },
            session.revision,
          );
    const lost = unanswered.current.get(message);
    let sent = lost ?? fresh();
    let result = await sendCommand(sent);
    // Refused outright, the earlier send never committed.
    if (lost && !result.ok && !UNANSWERED.includes(result.error.code)) {
      sent = fresh();
      result = await sendCommand(sent);
    }
    if (!result.ok && UNANSWERED.includes(result.error.code)) unanswered.current.set(message, sent);
    else unanswered.current.delete(message);
    // Answered from its receipt, the lost send's turn is one the session already counts.
    if (result.ok && sent === lost) sentAt.current.delete(session.id);
    return result;
  }

  useEffect(() => {
    for (const session of sessions ?? []) {
      const head = queued[session.id]?.[0];
      if (head === undefined || !composeState(session).send.enabled) continue;
      // Whether `/compact` compacts or is sent as text waits for the runtime's answer.
      if (asking && compactText(head.text) !== null) continue;
      const failed = failedAt.current.get(head);
      if (
        failed?.revision === session.revision &&
        failed.resync === resync &&
        (live === null || live === failed.live)
      )
        continue;
      const at = sentAt.current.get(session.id);
      if (at !== undefined && session.turn_count <= at) continue;
      const message = useQueued.getState().shift(session.id);
      if (message === undefined) continue;
      sentAt.current.set(session.id, session.turn_count);
      useQueued.setState((s) => {
        const { [session.id]: _, ...failures } = s.failures;
        return { failures };
      });
      void deliver(session, message).then((result) => {
        if (result.ok) {
          for (const comment of message.comments ?? []) void commentSent(comment);
          return;
        }
        sentAt.current.delete(session.id);
        failedAt.current.set(message, { revision: session.revision, live, resync });
        useQueued.getState().unshift(session.id, message);
        useQueued.setState((s) => ({
          failures: { ...s.failures, [session.id]: failureText(result.error) },
        }));
      });
    }
  }, [queued, sessions, live, resync, asking]);
}

/** A message waiting to be put into a session's composer, keyed by session id. */
interface Prefills {
  prefill: Readonly<Record<string, DraftMessage>>;
  set: (id: string, message: DraftMessage) => void;
  /** Takes the message off; undefined when none waits. */
  take: (id: string) => DraftMessage | undefined;
}

export const usePrefill = create<Prefills>()((set, get) => ({
  prefill: {},
  set: (id, message) => set((s) => ({ prefill: { ...s.prefill, [id]: message } })),
  take: (id) => {
    const message = get().prefill[id];
    if (message !== undefined)
      set((s) => {
        const { [id]: _, ...rest } = s.prefill;
        return { prefill: rest };
      });
    return message;
  },
}));
