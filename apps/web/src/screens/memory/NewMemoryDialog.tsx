import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Popover } from '@base-ui/react/popover';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import {
  ChevronDown,
  Clock,
  Diamond,
  File,
  FileText,
  Globe,
  Keyboard,
  Plus,
  StickyNote,
  X,
  type LucideIcon,
} from 'lucide-react';
import type {
  MemoryDirectory,
  MemoryItem,
  MemoryRecord,
  MemoryReference,
  MemorySummary,
} from '@pantheon/domain';
import { Menu, MenuCheckboxItem, MenuRadioGroup, MenuRadioItem } from '../../components/Menu';
import { Tip } from '../../components/Tip';
import { useMemoryQuery } from '../../data/memory';
import { sendProjectCommand } from '../../data/project-read';
import { readQuery } from '../../data/workbench-sessions';
import { currentLocale, t } from '../../i18n';
import { keyText } from '../../lib/shortcuts';
import { scrimFlag } from '../../lib/root-flag';
import './new-memory.css';

type Kind = MemoryRecord['kind'];
type Task = NonNullable<MemoryRecord['task']>;
type Reference = Omit<MemoryReference, 'content_hash'>;

/** The input of `memory.propose`. */
export interface MemoryProposal {
  project_id: string;
  key: string;
  kind: Kind;
  title?: string;
  summary?: string;
  tags?: string[];
  references?: Reference[];
  text: string;
  dependencies: string[];
  task?: Task;
  expires_at?: number;
  based_on?: string;
}

type SavedDraft = { id: string; revision: number | null };

export type SaveOutcome =
  | { ok: true; id: string }
  /** `id` and `revision` are the draft that was saved when only the confirmation failed. */
  | ({ ok: false; error: string } & Partial<SavedDraft>);

export interface SaveOptions {
  /** The draft already saved for this same proposal; it is committed instead of proposed again. */
  draft?: SavedDraft;
  /** The draft this proposal takes the place of; it is discarded once the new draft is saved. */
  replaces?: SavedDraft;
}

// The protocol's limits on a proposal.
const KEY_MAX = 120;
const TITLE_MAX = 160;
const SUMMARY_MAX = 400;
const TEXT_MAX = 20000;
const TAG_MAX = 60;
const MAX_TAGS = 12;
const URI_MAX = 2000;
const MAX_REFERENCES = 12;
const MAX_DEPENDENCIES = 32;

const KINDS: { kind: Kind; icon: LucideIcon; label: () => string }[] = [
  {
    kind: 'decision',
    icon: Diamond,
    label: () => t({ id: 'memory.new.kind.decision', defaultMessage: 'Decision' }),
  },
  {
    kind: 'report',
    icon: FileText,
    label: () => t({ id: 'memory.new.kind.report', defaultMessage: 'Report' }),
  },
  {
    kind: 'note',
    icon: StickyNote,
    label: () => t({ id: 'memory.new.kind.note', defaultMessage: 'Note' }),
  },
];
const kindOf = (kind: Kind) => KINDS.find((k) => k.kind === kind)!;

/** Sends the proposal as a draft and, when `confirm` is set, commits that draft. */
export async function saveMemory(
  input: MemoryProposal,
  confirm: boolean,
  { draft, replaces }: SaveOptions = {},
): Promise<SaveOutcome> {
  let saved = draft;
  if (!saved) {
    const proposed = await sendProjectCommand('memory.propose', { ...input }, null);
    if (!proposed.ok) return { ok: false, error: proposed.error };
    saved = { id: proposed.receipt.id!, revision: proposed.receipt.revision };
    // A replaced draft whose revision moved on is no longer this proposal's to discard.
    if (replaces)
      await sendProjectCommand('memory.archive', { memory_id: replaces.id }, replaces.revision);
  }
  if (!confirm) return { ok: true, id: saved.id };
  const committed = await sendProjectCommand(
    'memory.commit',
    { memory_id: saved.id },
    saved.revision,
  );
  return committed.ok
    ? { ok: true, id: saved.id }
    : { ok: false, error: committed.error, ...saved };
}

const pad = (n: number) => String(n).padStart(2, '0');
/** The last day an expiry still holds, as a date input's value; expiry is the start of the next day. */
function expiryDay(at: number): string {
  const day = new Date(at - 1);
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}
function expiryAt(day: string): number | null {
  const [y, m, d] = day.split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d + 1).getTime() : null;
}

interface Draft {
  kind: Kind;
  task: Task | null;
  title: string;
  summary: string;
  text: string;
  key: string;
  tags: string[];
  references: Reference[];
  dependencies: string[];
  expiresAt: number | null;
}

function draftOf(original: MemoryItem | null | undefined): Draft {
  return {
    kind: original?.kind ?? 'decision',
    task: original?.task ?? null,
    title: original?.title ?? '',
    summary: original?.summary ?? '',
    text: original?.text ?? '',
    key: original?.key ?? '',
    tags: original?.tags ?? [],
    references: (original?.references ?? []).map(({ content_hash: _, ...r }) => r),
    dependencies: original?.dependencies ?? [],
    expiresAt: original?.expires_at ?? null,
  };
}

type Problem = 'text' | 'key';

function proposalOf(
  draft: Draft,
  projectId: string,
  signature: string,
): { input: MemoryProposal } | { problem: Problem } {
  const text = draft.text.trim();
  const key = draft.key.trim();
  if (!text) return { problem: 'text' };
  if (!key) return { problem: 'key' };
  const title = draft.title.trim();
  const summary = draft.summary.trim();
  return {
    input: {
      project_id: projectId,
      key,
      kind: draft.kind,
      ...(title ? { title } : {}),
      ...(summary ? { summary } : {}),
      ...(draft.tags.length ? { tags: draft.tags } : {}),
      ...(draft.references.length ? { references: draft.references } : {}),
      text,
      // A decision cannot rest on another memory.
      dependencies: draft.kind === 'decision' ? [] : draft.dependencies,
      ...(draft.task ? { task: draft.task } : {}),
      ...(draft.expiresAt ? { expires_at: draft.expiresAt } : {}),
      based_on: signature,
    },
  };
}

const sameTask = (a: Task | null, b: { id: string; lead_session_id: string }) =>
  !!a && a.id === b.id && a.lead_session_id === b.lead_session_id;

/** The kind the draft must keep: confirming would replace the active original, which keeps its kind. */
function lockedKind(draft: Draft, original: MemoryItem | null): Kind | null {
  if (original?.state !== 'active' || draft.key.trim() !== original.key) return null;
  const sameScope = draft.task ? sameTask(original.task ?? null, draft.task) : !original.task;
  return sameScope ? original.kind : null;
}

function MemoryForm({
  projectId,
  original,
  titleRef,
  onSubmit,
  onOpenChange,
}: {
  projectId: string;
  original: MemoryItem | null;
  titleRef: RefObject<HTMLInputElement | null>;
  onSubmit: (input: MemoryProposal, confirm: boolean, options: SaveOptions) => Promise<SaveOutcome>;
  onOpenChange: (open: boolean) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(original));
  const [adding, setAdding] = useState<'tag' | 'source' | null>(null);
  const [entry, setEntry] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The draft this form saved and the proposal it holds, while that draft still waits.
  const [saved, setSaved] = useState<(SavedDraft & { input: string }) | null>(null);
  const read = useMemoryQuery<MemoryDirectory>('memory.read', projectId, {
    state: 'active',
    limit: 50,
  });
  const directory = read.data;
  // Active records past the directory's first page, read for its signature.
  const [rest, setRest] = useState<{ signature: string; records: MemorySummary[] } | null>(null);
  useEffect(() => {
    const signature = directory?.signature;
    let cursor = directory?.next_cursor;
    if (!signature || !cursor) return;
    let live = true;
    void (async () => {
      const records: MemorySummary[] = [];
      while (cursor) {
        const result = await readQuery('memory.read', {
          project_id: projectId,
          state: 'active',
          limit: '50',
          cursor,
        });
        if (!live || !result.ok) return;
        const page = result.value as MemoryDirectory;
        records.push(...page.records);
        cursor = page.next_cursor;
      }
      setRest({ signature, records });
    })();
    return () => {
      live = false;
    };
  }, [projectId, directory?.signature, directory?.next_cursor]);
  const change = (next: Partial<Draft>) => setDraft((d) => ({ ...d, ...next }));
  const seen = new Set<string>();
  const candidates = [
    ...(directory?.records ?? []),
    ...(rest && rest.signature === directory?.signature ? rest.records : []),
  ].filter((r) => r.id !== original?.id && !seen.has(r.id) && !!seen.add(r.id));
  const titleOf = (id: string) => candidates.find((r) => r.id === id)?.title ?? id;
  const scopeName = draft.task
    ? (directory?.facets.tasks.find((task) => sameTask(draft.task, task))?.title ?? draft.task.id)
    : t({ id: 'memory.new.scope.project', defaultMessage: 'Project' });
  const locked = lockedKind(draft, original);
  const kind = locked ?? draft.kind;
  const decision = kind === 'decision';

  const submit = async (confirm: boolean, from = draft) => {
    if (busy || !directory) return;
    // A signature read before a refresh still guards: the daemon refuses it once memory moved on.
    const built = proposalOf(
      { ...from, kind: lockedKind(from, original) ?? from.kind },
      projectId,
      directory.signature,
    );
    if ('problem' in built) return setProblem(built.problem);
    setProblem(null);
    setFailure(null);
    setBusy(true);
    const input = JSON.stringify(built.input);
    const replaces = saved ?? (original?.state === 'draft' ? original : null);
    const outcome = await onSubmit(
      built.input,
      confirm,
      saved?.input === input
        ? { draft: { id: saved.id, revision: saved.revision } }
        : replaces
          ? { replaces: { id: replaces.id, revision: replaces.revision } }
          : {},
    );
    setBusy(false);
    if (outcome.ok) return onOpenChange(false);
    setFailure(outcome.error);
    if (outcome.id) setSaved({ id: outcome.id, revision: outcome.revision ?? null, input });
  };
  const finishEntry = (): Draft => {
    const value = entry.trim();
    let added: Partial<Draft> = {};
    if (adding === 'tag' && value && !draft.tags.includes(value))
      added = { tags: [...draft.tags, value.slice(0, TAG_MAX)] };
    if (adding === 'source' && value && !draft.references.some((r) => r.uri === value))
      added = {
        references: [
          ...draft.references,
          { kind: /^https?:\/\//i.test(value) ? 'url' : 'file', uri: value },
        ],
      };
    change(added);
    setAdding(null);
    setEntry('');
    return { ...draft, ...added };
  };
  const entryKeys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    // The form's ⌘↵ would submit the draft from before this entry.
    e.stopPropagation();
    const next = finishEntry();
    if (e.metaKey || e.ctrlKey) void submit(true, next);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void submit(true);
  };

  const confirmText = t({ id: 'memory.new.confirm', defaultMessage: 'Confirm' });
  const scopeText = t({ id: 'memory.new.scope', defaultMessage: 'Scope' });
  const basedText = t({ id: 'memory.new.dependencies', defaultMessage: 'Based on' });
  const entryText =
    adding === 'tag'
      ? t({ id: 'memory.new.tagInput', defaultMessage: 'New tag' })
      : t({ id: 'memory.new.sourceInput', defaultMessage: 'Source path or URL' });
  const entryInput = (
    <input
      autoFocus
      className={adding === 'tag' ? 'mnw-entry' : 'mnw-entry mono'}
      aria-label={entryText}
      value={entry}
      maxLength={adding === 'tag' ? TAG_MAX : URI_MAX}
      onChange={(e) => setEntry(e.target.value)}
      onKeyDown={entryKeys}
      onBlur={finishEntry}
    />
  );
  const basedButton = (
    <button
      type="button"
      className="btn ghost sm"
      aria-disabled={decision || !candidates.length || undefined}
    >
      <Diamond aria-hidden="true" />
      {basedText}
      <ChevronDown aria-hidden="true" />
    </button>
  );
  const expiry = draft.expiresAt
    ? t(
        { id: 'memory.new.expires', defaultMessage: 'Expires {date}' },
        {
          date: new Intl.DateTimeFormat(currentLocale(), { month: 'short', day: 'numeric' }).format(
            draft.expiresAt - 1,
          ),
        },
      )
    : t({ id: 'memory.new.noExpiry', defaultMessage: 'No expiry' });

  return (
    <div className="mnw" onKeyDown={onKeyDown}>
      <div className="mnw-hd">
        <RadioGroup<Kind>
          className="tb-seg"
          aria-label={t({ id: 'memory.new.kind', defaultMessage: 'Kind' })}
          value={kind}
          disabled={busy || !!locked}
          onValueChange={(kind) => change({ kind })}
        >
          {KINDS.map(({ kind, icon: Icon, label }) => (
            <Radio.Root key={kind} value={kind}>
              <Icon aria-hidden="true" />
              {label()}
            </Radio.Root>
          ))}
        </RadioGroup>
        {original?.task && (
          <Menu
            label={scopeText}
            trigger={
              <button
                type="button"
                className="btn ghost sm"
                aria-label={t(
                  { id: 'memory.new.scopeOf', defaultMessage: 'Scope: {name}' },
                  { name: scopeName },
                )}
              >
                {scopeName}
                <ChevronDown aria-hidden="true" />
              </button>
            }
          >
            <MenuRadioGroup
              value={draft.task ? 'task' : 'project'}
              onChange={(value) => change({ task: value === 'task' ? original.task! : null })}
            >
              <MenuRadioItem value="project">
                {t({ id: 'memory.new.scope.project', defaultMessage: 'Project' })}
              </MenuRadioItem>
              <MenuRadioItem value="task">
                {directory?.facets.tasks.find((task) => sameTask(original.task!, task))?.title ??
                  original.task.id}
              </MenuRadioItem>
            </MenuRadioGroup>
          </Menu>
        )}
        <Dialog.Close
          className="ib mnw-x"
          aria-label={t({ id: 'memory.new.close', defaultMessage: 'Close' })}
        >
          <X aria-hidden="true" />
        </Dialog.Close>
      </div>
      <div className="mnw-bd">
        <input
          ref={titleRef}
          className="mnw-din mnw-title"
          placeholder={t({ id: 'memory.new.title', defaultMessage: 'Title' })}
          aria-label={t({ id: 'memory.new.title', defaultMessage: 'Title' })}
          value={draft.title}
          maxLength={TITLE_MAX}
          readOnly={busy}
          onChange={(e) => change({ title: e.target.value })}
        />
        <input
          className="mnw-din mnw-sum"
          placeholder={t({ id: 'memory.new.summaryHint', defaultMessage: 'One-line summary' })}
          aria-label={t({ id: 'memory.new.summary', defaultMessage: 'Summary' })}
          value={draft.summary}
          maxLength={SUMMARY_MAX}
          readOnly={busy}
          onChange={(e) => change({ summary: e.target.value })}
        />
        <textarea
          className="mnw-din mnw-text"
          rows={4}
          spellCheck
          placeholder={t({ id: 'memory.new.text', defaultMessage: 'Body' })}
          aria-label={t({ id: 'memory.new.text', defaultMessage: 'Body' })}
          aria-invalid={problem === 'text' || undefined}
          value={draft.text}
          maxLength={TEXT_MAX}
          readOnly={busy}
          onChange={(e) => change({ text: e.target.value })}
        />
        <label className="field">
          <Keyboard aria-hidden="true" />
          <input
            className="mono"
            aria-label={t({ id: 'memory.new.key', defaultMessage: 'Key' })}
            aria-invalid={problem === 'key' || undefined}
            value={draft.key}
            maxLength={KEY_MAX}
            readOnly={busy}
            onChange={(e) => change({ key: e.target.value })}
          />
        </label>
        <div className="mnw-rows">
          {draft.references.map((r) => {
            const Icon = r.kind === 'url' ? Globe : File;
            return (
              <div key={r.uri} className="mnw-srow">
                <Icon aria-hidden="true" />
                <span className="mono mnw-cut">{r.uri}</span>
                <button
                  type="button"
                  className="ib mnw-x"
                  aria-label={t(
                    { id: 'memory.new.removeSource', defaultMessage: 'Remove source {uri}' },
                    { uri: r.uri },
                  )}
                  disabled={busy}
                  onClick={() =>
                    change({ references: draft.references.filter((x) => x.uri !== r.uri) })
                  }
                >
                  <X aria-hidden="true" />
                </button>
              </div>
            );
          })}
          {adding === 'source' && (
            <div className="mnw-srow">
              <File aria-hidden="true" />
              {entryInput}
            </div>
          )}
          {!decision &&
            draft.dependencies.map((id) => {
              const record = candidates.find((r) => r.id === id);
              const Icon = record ? kindOf(record.kind).icon : Diamond;
              const title = titleOf(id);
              return (
                <div key={id} className="mnw-srow">
                  {record ? (
                    <Icon role="img" aria-label={kindOf(record.kind).label()} />
                  ) : (
                    <Icon aria-hidden="true" />
                  )}
                  <span className="mnw-cut">
                    {t({ id: 'memory.new.basedOn', defaultMessage: 'Based on {title}' }, { title })}
                  </span>
                  <button
                    type="button"
                    className="ib mnw-x"
                    aria-label={t(
                      { id: 'memory.new.removeBasis', defaultMessage: 'Remove basis {title}' },
                      { title },
                    )}
                    disabled={busy}
                    onClick={() =>
                      change({ dependencies: draft.dependencies.filter((x) => x !== id) })
                    }
                  >
                    <X aria-hidden="true" />
                  </button>
                </div>
              );
            })}
        </div>
        <div className="mnw-tags">
          {draft.tags.map((tag) => (
            <button
              key={tag}
              type="button"
              className="chip mnw-chip"
              aria-label={t(
                { id: 'memory.new.removeTag', defaultMessage: 'Remove tag {tag}' },
                { tag },
              )}
              disabled={busy}
              onClick={() => change({ tags: draft.tags.filter((x) => x !== tag) })}
            >
              {tag}
            </button>
          ))}
          {adding === 'tag'
            ? entryInput
            : draft.tags.length < MAX_TAGS && (
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={busy}
                  onClick={() => setAdding('tag')}
                >
                  <Plus aria-hidden="true" />
                  {t({ id: 'memory.new.addTag', defaultMessage: 'Tag' })}
                </button>
              )}
          <button
            type="button"
            className="btn ghost sm"
            disabled={busy || draft.references.length >= MAX_REFERENCES}
            onClick={() => setAdding('source')}
          >
            <File aria-hidden="true" />
            {t({ id: 'memory.new.addSource', defaultMessage: 'Source' })}
          </button>
          {decision || !candidates.length ? (
            decision ? (
              <Tip
                content={t({
                  id: 'memory.new.decisionBasis',
                  defaultMessage: 'A decision cannot rest on another memory',
                })}
              >
                {basedButton}
              </Tip>
            ) : (
              basedButton
            )
          ) : (
            <Menu label={basedText} trigger={basedButton}>
              {candidates.map((r) => {
                const Icon = kindOf(r.kind).icon;
                const on = draft.dependencies.includes(r.id);
                return (
                  <MenuCheckboxItem
                    key={r.id}
                    checked={on}
                    icon={<Icon />}
                    onChange={(checked) =>
                      change({
                        dependencies: checked
                          ? [...draft.dependencies, r.id].slice(0, MAX_DEPENDENCIES)
                          : draft.dependencies.filter((x) => x !== r.id),
                      })
                    }
                  >
                    {r.title}
                  </MenuCheckboxItem>
                );
              })}
            </Menu>
          )}
          <Popover.Root>
            <Popover.Trigger className="btn ghost sm" disabled={busy}>
              <Clock aria-hidden="true" />
              {expiry}
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Positioner side="bottom" align="start" sideOffset={4} style={{ zIndex: 60 }}>
                <Popover.Popup
                  className="pop mnw-exp"
                  aria-label={t({ id: 'memory.new.expiryPopup', defaultMessage: 'Expiry' })}
                >
                  <input
                    type="date"
                    className="inp"
                    aria-label={t({ id: 'memory.new.expiry', defaultMessage: 'Expiry date' })}
                    min={expiryDay(Date.now() + 1)}
                    value={draft.expiresAt ? expiryDay(draft.expiresAt) : ''}
                    onChange={(e) => change({ expiresAt: expiryAt(e.target.value) })}
                  />
                  {draft.expiresAt && (
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => change({ expiresAt: null })}
                    >
                      {t({ id: 'memory.new.noExpiry', defaultMessage: 'No expiry' })}
                    </button>
                  )}
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        </div>
      </div>
      {(failure ?? (directory ? null : read.error)) && (
        <div className="pj-err" role="alert">
          <b>{failure ?? read.error}</b>
        </div>
      )}
      <div className="mnw-ft">
        <span className="mnw-hint" aria-hidden="true">
          <kbd className="kbd">{keyText('Meta+Enter')}</kbd>
          {confirmText}
        </span>
        <span className="mnw-end">
          <Dialog.Close className="btn ghost">
            {t({ id: 'memory.new.cancel', defaultMessage: 'Cancel' })}
          </Dialog.Close>
          <button
            type="button"
            className="btn"
            aria-busy={busy || read.loading || undefined}
            disabled={busy || !directory}
            onClick={() => void submit(false)}
          >
            {t({ id: 'memory.new.saveDraft', defaultMessage: 'Save as draft' })}
          </button>
          <button
            type="button"
            className="btn pri"
            aria-busy={busy || read.loading || undefined}
            aria-keyshortcuts="Meta+Enter"
            disabled={busy || !directory}
            onClick={() => void submit(true)}
          >
            {confirmText}
          </button>
        </span>
      </div>
    </div>
  );
}

/** The dialog that records a memory, or rewrites `original` as its next version; it closes itself once `onSubmit` succeeds. */
export function NewMemoryDialog({
  open,
  onOpenChange,
  projectId,
  original = null,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** The entry to rewrite, with its body. */
  original?: MemoryItem | null;
  /**
   * `confirm` is set for a memory that takes effect at once rather than waiting as a draft;
   * `options` names the drafts the save reuses or replaces, as `saveMemory` takes them.
   */
  onSubmit: (input: MemoryProposal, confirm: boolean, options: SaveOptions) => Promise<SaveOutcome>;
}) {
  const titleRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="pj-scrim" ref={scrimFlag} />
        <Dialog.Popup
          className="pj-dlg pop mnw-dlg"
          initialFocus={titleRef}
          aria-label={
            original
              ? t({ id: 'memory.new.rewrite', defaultMessage: 'Rewrite' })
              : t({ id: 'memory.new.dialog', defaultMessage: 'New memory' })
          }
        >
          <MemoryForm
            projectId={projectId}
            original={original}
            titleRef={titleRef}
            onSubmit={onSubmit}
            onOpenChange={onOpenChange}
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
