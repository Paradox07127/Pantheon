import { useEffect, useRef, useState, type KeyboardEvent as KeyPress, type ReactNode } from 'react';
import { Menu } from '@base-ui/react/menu';
import { Popover } from '@base-ui/react/popover';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import {
  Check,
  ChevronDown,
  CircleDot,
  Crown,
  ExternalLink,
  FileText,
  Folder,
  GitBranch,
  GitPullRequest,
  Mic,
  Plus,
  Search,
  Sprout,
  Zap,
} from 'lucide-react';
import type { BoardSnapshot, WorkbenchSession } from '@pantheon/protocol';
import { ProjectMonogram } from '../../components/ProjectMonogram';
import { runtimeTraits } from '../../components/RuntimeGlyph';
import { KeyHint } from '../../components/Shortcuts';
import { Tip } from '../../components/Tip';
import { SessionStateIcon, sessionStateLabel, StateGlyph } from '../../components/SessionStateIcon';
import { useBoard } from '../../data/board';
import { runCommand } from '../../data/commands';
import { listGithubItems, type GithubItem } from '../../data/code-refs';
import { useFactsRead } from '../../data/facts-read';
import {
  draftKey,
  EMPTY_DRAFT,
  githubRefKey,
  useDrafts,
  whenUploaded,
  type Draft,
  type DraftStart,
  type DraftWorkspace,
  type GithubRef,
} from '../../data/drafts';
import { readBranches, type ProjectBranch } from '../../data/project-branches';
import { getLook } from '../../data/layout';
import { ageText, failureText, reasonText, useNow, type NeedsYouItem } from '../../data/needs-you';
import { visibleProjects } from '../../data/projects';
import { useBackends } from '../../data/backends';
import { useProjectHead, useRuntimeModels } from '../../data/runtime-models';
import { offeredRuntimes, useConnectionsStatus, useRuntimeStatus } from '../../data/runtime-status';
import { insertVoiceText, useVoice } from '../../data/voice';
import { t } from '../../i18n';
import {
  digitKeys,
  keyText,
  pressedKeys,
  sameKeys,
  shortcutKeys,
  shortcutMatches,
  useShortcut,
} from '../../lib/shortcuts';
import { useShell } from '../../store';
import { useSettingsView } from '../settings/view';
import { refsInput } from './compose';
import {
  checksLabel,
  githubRefCard,
  markSend,
  MAX_REFS,
  sessionRefCard,
  sessionRefMenu,
} from './attachments';
import {
  defaultModelFor,
  defaultPermissionMode,
  defaultRuntime,
  modelPermissionModes,
  newSessionInput,
  sessionRow,
} from './model';
import {
  AttachmentStrip,
  CompletionPopup,
  ModelMenu,
  SendButton,
  useAttachments,
  useCompletion,
  usePickedSkills,
  type ModelChoice,
} from './parts';
import { conductorLabel } from './session-groups';
import { fail, ON, useFileInput } from './shared';
import { VoiceBar } from './VoiceBar';
import './compose.css';
import './create.css';

const scratchLabel = () =>
  t({ id: 'sessions.composer.fromScratch', defaultMessage: 'Start from scratch' });

/** The picked value of the new-session composer; session ids are never empty. */
export const NEW = '';

const NO_PROJECTS: BoardSnapshot['projects'] = [];
const NO_SESSIONS: readonly WorkbenchSession[] = [];
const NO_GITHUB: readonly GithubRef[] = [];

type Workspace = DraftWorkspace;
type From = DraftStart;
type BranchRead =
  | { state: 'loading' }
  | { state: 'ready'; branches: ProjectBranch[] }
  | { state: 'failed'; text: string };

const WORKSPACE_KEYS = 'Meta+Shift+W';
// Sessions in progress offered before the rest fold behind a more row; ⌘1 to ⌘3 open them.
const SUGGESTED = 3;
// More branches than this get a filter above them.
const BRANCH_FILTER_FROM = 8;
// The start menu's value for the project's own checkout; other values are the start as JSON.
const HEAD = '';
// Open pull requests and open issues offered each.
const GITHUB_SUGGESTED = 3;

type GithubKind = GithubRef['kind'];

/** The project's open pull requests and issues once GitHub is connected; empty when a read fails. */
function useGithubItems(projectId: string, connected: boolean) {
  const [read, setRead] = useState<{ for: string; pr: GithubItem[]; issue: GithubItem[] } | null>(
    null,
  );
  useEffect(() => {
    if (!connected) return;
    let current = true;
    const items = (kind: GithubKind) =>
      listGithubItems(projectId, kind).then((result) => (result.ok ? result.value : []));
    void Promise.all([items('pr'), items('issue')]).then(([pr, issue]) => {
      if (current) setRead({ for: projectId, pr, issue });
    });
    return () => {
      current = false;
    };
  }, [projectId, connected]);
  return read?.for === projectId ? read : null;
}

/** A pull request by the state of its checks; an issue by its mark. */
function githubGlyph(kind: GithubKind, item: GithubItem) {
  if (kind === 'issue') return <CircleDot className="ic-sm" aria-hidden="true" />;
  if (item.checks === 'passing') return <StateGlyph name="done" />;
  if (item.checks === 'failing') return <StateGlyph name="failed" />;
  if (item.checks === 'pending') return <StateGlyph name="running" />;
  return <GitPullRequest className="ic-sm" aria-hidden="true" />;
}

export function NewSession(props: {
  projectId: string;
  defaults: BoardSnapshot['projects'][number]['session_defaults'];
  focus: number;
  onCreated: (id: string) => void;
  /** The open sessions of the list, offered while the message is empty and in the add menu. */
  recent: WorkbenchSession[];
  /** The project's needs-you items, which say why an offered session waits. */
  needs?: readonly NeedsYouItem[] | null;
  onOpen: (id: string) => void;
  /** Called on Escape without creating a session; absent, Escape stays in the page. */
  onClose?: () => void;
}) {
  // The session edits code in its own worktree, so it needs a runtime that can write in isolation.
  const { read: status, runtimes, unavailable, disconnected } = useRuntimeStatus('writer');
  const key = draftKey(props.projectId, null);
  // Kept with the draft, so leaving and opening the composer again keeps them like the text.
  const pick = (change: Partial<Draft>) => {
    useDrafts.getState().start(key, '');
    useDrafts.getState().update(key, () => change);
  };
  const choice: ModelChoice | null = useDrafts((s) => s.drafts[key]?.model) ?? null;
  const setChoice = (model: ModelChoice) => pick({ model });
  const mode = useDrafts((s) => s.drafts[key]?.mode) ?? null;
  const setMode = (next: WorkbenchSession['permission_mode']) => pick({ mode: next });
  const fast = useDrafts((s) => s.drafts[key]?.fast) ?? false;
  const setFast = (on: boolean) => pick({ fast: on });
  const ultracode = useDrafts((s) => s.drafts[key]?.ultracode) ?? false;
  const setUltracode = (on: boolean) => pick({ ultracode: on });
  const conductor = useDrafts((s) => s.drafts[key]?.conductor) ?? false;
  const input = useDrafts((s) => s.drafts[key]?.text) ?? '';
  const setInput = (text: string) => useDrafts.getState().update(key, () => ({ text }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allShown, setAllShown] = useState(false);
  const attachments = useAttachments(props.projectId, key);
  const skills = usePickedSkills(key);
  const files = useFileInput(attachments);
  const box = useRef<HTMLTextAreaElement>(null);
  const projects = useBoard((s) => s.board?.projects ?? NO_PROJECTS);
  const projectName = projects.find((p) => p.id === props.projectId)?.name ?? null;
  const projectFolder = projects.find((p) => p.id === props.projectId)?.roots?.[0];
  const head = useProjectHead(props.projectId).read;
  const pickedWorkspace = useDrafts((s) => s.drafts[key]?.workspace);
  const setWorkspace = (next: Workspace) =>
    useDrafts.getState().update(key, () => ({ workspace: next }));
  const refs = useDrafts((s) => s.drafts[key]?.refs) ?? NO_SESSIONS;
  // The branch or referenced session the worktree starts from; null starts from the project's checkout.
  const start = useDrafts((s) => s.drafts[key]?.from) ?? null;
  const setStart = (next: From | null) =>
    useDrafts.getState().update(key, () => ({ from: next ?? undefined }));
  // Without a choice the daemon picks the project folder, or a worktree while a session writes there.
  const holder = props.recent.find((s) => s.holds_folder) ?? null;
  const workspace: Workspace =
    pickedWorkspace ?? (start !== null || holder ? 'worktree' : 'in_place');
  const from: From | undefined = workspace === 'worktree' && start !== null ? start : undefined;
  const [branchRead, setBranchRead] = useState<BranchRead | null>(null);
  const [branchFilter, setBranchFilter] = useState('');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!sameKeys(pressedKeys(e) ?? '', WORKSPACE_KEYS)) return;
      e.preventDefault();
      useDrafts.getState().update(key, () => ({
        workspace: workspace === 'in_place' ? 'worktree' : 'in_place',
      }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [key, workspace]);
  const githubRefs = useDrafts((s) => s.drafts[key]?.github) ?? NO_GITHUB;
  const connections = useConnectionsStatus().read;
  const githubState = connections.state === 'ready' ? connections.github.state : null;
  const githubItems = useGithubItems(props.projectId, githubState === 'signed_in');
  const refer = (s: WorkbenchSession) => {
    const draft = useDrafts.getState().drafts[key] ?? EMPTY_DRAFT;
    const known = draft.refs.some((r) => r.id === s.id);
    if (!known && draft.refs.length + draft.github.length >= MAX_REFS) return;
    if (!known) useDrafts.getState().update(key, (d) => ({ refs: [...d.refs, s] }));
    if (s.workspace_kind === 'linked_worktree') setStart({ session_id: s.id });
  };
  const unrefer = (id: string) => {
    useDrafts.getState().update(key, (d) => ({ refs: d.refs.filter((r) => r.id !== id) }));
    if (start && 'session_id' in start && start.session_id === id) setStart(null);
  };
  const referGithub = (kind: GithubKind, item: GithubItem) => {
    const ref: GithubRef = {
      kind,
      number: item.number,
      title: item.title,
      ...(item.checks ? { checks: item.checks } : {}),
    };
    useDrafts
      .getState()
      .update(key, (d) =>
        d.github.some((r) => githubRefKey(r) === githubRefKey(ref)) ||
        d.refs.length + d.github.length >= MAX_REFS
          ? {}
          : { github: [...d.github, ref] },
      );
  };
  const unreferGithub = (ref: GithubRef) =>
    useDrafts.getState().update(key, (d) => ({
      github: d.github.filter((r) => githubRefKey(r) !== githubRefKey(ref)),
    }));
  const openOnGithub = (url: string) => void window.pantheon?.openLink(url).catch(fail);
  const connectGithub = () => {
    useSettingsView.getState().setPage('connections');
    useShell.getState().openSettings(null);
  };
  // Read on each opening of the start menu; a list already read stays while it is read again.
  const listBranches = () => {
    if (branchRead?.state !== 'ready') setBranchRead({ state: 'loading' });
    void readBranches(window.pantheon, props.projectId, projectFolder).then((result) =>
      setBranchRead(
        result.ok
          ? { state: 'ready', branches: result.value }
          : { state: 'failed', text: failureText(result.error) },
      ),
    );
  };
  // A referenced session as the list shows it now.
  const referred = refs.map((r) => props.recent.find((s) => s.id === r.id) ?? r);
  const now = useNow(30_000);
  const chosen = choice?.runtime ?? defaultRuntime(runtimes, props.defaults?.runtime, unavailable);
  const offered = offeredRuntimes(status, [chosen]);
  const models = useRuntimeModels(props.projectId, offered);
  const backends = useBackends();
  const listedModels = models[chosen];
  const preset =
    listedModels?.state === 'ready'
      ? defaultModelFor(
          listedModels.models,
          chosen === props.defaults?.runtime ? props.defaults.model : undefined,
        )
      : null;
  const projectModel =
    preset !== null &&
    chosen === props.defaults?.runtime &&
    props.defaults.model !== undefined &&
    (preset.id === props.defaults.model || preset.resolved === props.defaults.model);
  const model: ModelChoice = choice ?? {
    runtime: chosen,
    backend: null,
    model: preset?.id ?? null,
    effort: (projectModel ? props.defaults?.effort : undefined) ?? preset?.default_effort ?? null,
  };
  // A backend's models list no modes or fast mode of their own; without a listed model the
  // session runs on the default one.
  const pickedModel =
    model.backend === null && listedModels?.state === 'ready'
      ? defaultModelFor(listedModels.models, model.model ?? undefined)
      : null;
  const modes = modelPermissionModes(chosen, pickedModel);
  const preferred = props.defaults?.permission_mode;
  const picked =
    mode !== null && modes.includes(mode)
      ? mode
      : preferred !== undefined && modes.includes(preferred)
        ? preferred
        : defaultPermissionMode(chosen, preferred);
  const fastOn = fast && pickedModel?.fast === true;
  const ultracodeOn = ultracode && chosen === 'claude';
  const empty = input.trim() === '';
  // An empty project offers a guided start.
  const fromScratch = useFactsRead(props.projectId).read?.empty === true;
  const completion = useCompletion({
    project_id: props.projectId,
    session_id: null,
    runtime: chosen,
    text: input,
    onText: setInput,
    onSkill: skills.add,
    box,
  });
  // Where the caret goes once the box shows text the add menu put in.
  const caretTo = useRef<number | null>(null);
  useEffect(() => {
    const to = caretTo.current;
    caretTo.current = null;
    if (to !== null) box.current?.setSelectionRange(to, to);
  }, [input]);
  const voice = useVoice((text) => {
    const el = box.current;
    const next = insertVoiceText(
      input,
      text,
      el ? { start: el.selectionStart, end: el.selectionEnd } : null,
    );
    caretTo.current = next.caret;
    setInput(next.value);
    el?.focus();
  });

  /** Puts the trigger of a completion into the box, which opens its options. */
  function begin(text: string, caret: number) {
    caretTo.current = caret;
    setInput(text);
    completion.moved(caret);
  }

  useEffect(() => box.current?.focus(), [props.focus]);
  // The project the composer shows; a creation answered after a switch leaves the view alone.
  const shown = useRef<string | null>(props.projectId);
  useEffect(() => {
    shown.current = props.projectId;
    return () => {
      shown.current = null;
    };
  }, [props.projectId]);

  // ⌘U opens the add menu, which takes files, references and commands.
  const [adding, setAdding] = useState(false);
  useShortcut('attach', () => setAdding(true), voice.state.phase === 'idle');

  useShortcut('permission-mode', () => {
    if (modes.length === 0) return;
    const at = modes.indexOf(picked);
    setMode(modes[(at + 1) % modes.length]!);
  });

  async function create(purpose?: 'project_setup') {
    if (busy || (empty && !purpose)) return;
    setBusy(true);
    setError(null);
    const text = empty ? scratchLabel() : input;
    const files = markSend(key);
    if (useDrafts.getState().drafts[key]?.uploading) await whenUploaded(key);
    const failed = files.failure();
    if (failed) {
      setBusy(false);
      setError(failed);
      return;
    }
    const ids = files.ids();
    const sent = skills.inText(text);
    const result = await runCommand(
      'session.create',
      {
        ...newSessionInput({
          projectId: props.projectId,
          runtime: chosen,
          permissionMode: picked,
          input: text,
          backend: model.backend,
          model: model.model,
          effort: model.effort,
          attachments: ids,
        }),
        ...(runtimeTraits(chosen).turnSkills && sent.length ? { skills: sent } : {}),
        ...(fastOn ? { fast: true } : {}),
        ...(ultracodeOn ? { ultracode: true } : {}),
        workspace: pickedWorkspace ?? (from ? 'worktree' : 'auto'),
        ...(from ? { from } : {}),
        ...refsInput(refs, githubRefs),
        ...(purpose ? { purpose } : conductor ? { purpose: 'conductor' } : {}),
      },
      null,
    ).catch(fail);
    setBusy(false);
    if (!result.ok) {
      setError(failureText(result.error));
      return;
    }
    // A skill the newer text still names stays for the next message.
    const now = (useDrafts.getState().drafts[key] ?? EMPTY_DRAFT).text;
    const named = skills.inText(now === text ? '' : now).map((skill) => skill.name);
    useDrafts.getState().sent(key, {
      text,
      attachments: ids,
      skills: sent.map((skill) => skill.name).filter((name) => !named.includes(name)),
      refs: refs.map((r) => r.id),
      github: githubRefs.map(githubRefKey),
      ...(pickedWorkspace ? { workspace: pickedWorkspace } : {}),
      ...(start ? { from: start } : {}),
      ...(choice ? { model: choice } : {}),
      ...(mode ? { mode } : {}),
      fast,
      ultracode,
      conductor,
    });
    const id = (result.value as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || shown.current !== props.projectId) return;
    props.onCreated(id);
  }

  // Its keys start the session and open the sessions offered.
  const onComposerKey = (e: KeyPress) => {
    if (e.isDefaultPrevented() || e.nativeEvent.isComposing) return;
    if (props.onClose && e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
      return;
    }
    if (shortcutMatches('dialog-next', e)) {
      e.preventDefault();
      void create();
      return;
    }
    if (!shortcutMatches('session-number', e)) return;
    const digit = Number((e.code || e.key).slice(-1));
    if (digit > SUGGESTED) return;
    e.preventDefault();
    e.stopPropagation();
    const s = empty ? props.recent[digit - 1] : undefined;
    if (s) props.onOpen(s.id);
  };
  const suggested = allShown ? props.recent : props.recent.slice(0, SUGGESTED);
  const why = (s: WorkbenchSession) => {
    const item = props.needs?.find(
      (n) => n.session_id === s.id || (n.source.table === 'sessions' && n.source.id === s.id),
    );
    if (!item) return sessionStateLabel(s);
    return t(
      { id: 'sessions.newWorkspace.waitReason', defaultMessage: '{state}: {reason}' },
      {
        state: sessionStateLabel(s),
        reason: item.binding?.input_summary ?? reasonText(item.reason),
      },
    );
  };

  const githubOffered = !!githubItems && githubItems.pr.length + githubItems.issue.length > 0;
  const githubOff = githubState === 'signed_out' || githubState === 'missing';
  const githubGroup = (kind: GithubKind) => {
    const items = githubItems?.[kind].slice(0, GITHUB_SUGGESTED) ?? [];
    if (items.length === 0) return null;
    const label =
      kind === 'pr'
        ? t({ id: 'sessions.newWorkspace.openPulls', defaultMessage: 'Open pull requests' })
        : t({ id: 'sessions.newWorkspace.openIssues', defaultMessage: 'Open issues' });
    return (
      <div className="cr-sgg" role="group" aria-label={label}>
        <span className="cr-gh" aria-hidden="true">
          {label}
        </span>
        {items.map((item) => (
          <div key={item.number} className="cr-sg">
            <button type="button" className="cr-sgm" onClick={() => referGithub(kind, item)}>
              <span className="cr-gl" aria-hidden="true">
                {githubGlyph(kind, item)}
              </span>
              <span className="cr-sha">#{item.number}</span>
              <span className="cr-cdt">{item.title}</span>
              {item.checks && <span className="cr-then">{checksLabel(item.checks)}</span>}
            </button>
            <span className="cr-acts">
              <button type="button" className="btn ghost sm" onClick={() => openOnGithub(item.url)}>
                <ExternalLink className="ic-sm" aria-hidden="true" />
                {t({ id: 'sessions.newWorkspace.openOnGithub', defaultMessage: 'Open on GitHub' })}
              </button>
            </span>
          </div>
        ))}
      </div>
    );
  };

  const picker = (
    <Menu.Root>
      <Menu.Trigger
        className="cr-pk"
        aria-label={t({
          id: 'sessions.composer.newSessionProject',
          defaultMessage: 'Project for the new session',
        })}
      >
        <Folder aria-hidden="true" />
        <span className="cr-pkn">{projectName}</span>
        <ChevronDown className="cr-dn" aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={4} style={{ zIndex: 40 }}>
          <Menu.Popup className="wmenu pjm pop">
            <Menu.RadioGroup value={props.projectId}>
              {visibleProjects(projects).map((p) => (
                <Menu.RadioItem
                  key={p.id}
                  value={p.id}
                  closeOnClick
                  onClick={() => {
                    if (p.id !== props.projectId) useShell.getState().openProjectSession(p.id, NEW);
                  }}
                >
                  <span className="pjm-ck">
                    <Menu.RadioItemIndicator>
                      <Check className="ic-sm" aria-hidden="true" />
                    </Menu.RadioItemIndicator>
                  </span>
                  <ProjectMonogram id={p.id} name={p.name} />
                  {p.name}
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );

  const mention = () => {
    const lead = input === '' || /\s$/.test(input) ? input : `${input} `;
    begin(`${lead}@`, lead.length + 1);
  };
  // A command is completed only at the start of the message.
  const command = () => begin(input.trim() === '' ? '/' : `/ ${input}`, 1);
  const inProgress = t({ id: 'sessions.composer.inProgress', defaultMessage: 'In progress' });

  const headName =
    head?.branch ??
    head?.sha.slice(0, 7) ??
    t({ id: 'sessions.newWorkspace.currentBranch', defaultMessage: 'Current branch' });
  const starts = referred.filter((s) => s.workspace_kind === 'linked_worktree');
  const startSession = referred.find(
    (s) => from !== undefined && 'session_id' in from && s.id === from.session_id,
  );
  const startBranch = from && 'branch' in from ? from.branch : null;
  const listed = branchRead?.state === 'ready' ? branchRead.branches : [];
  const needle = branchFilter.toLowerCase();
  const startItem = (value: string, content: ReactNode, className?: string) => (
    <Menu.RadioItem key={value} value={value} className={className} closeOnClick>
      <span className="pjm-ck">
        <Menu.RadioItemIndicator>
          <Check className="ic-sm" aria-hidden="true" />
        </Menu.RadioItemIndicator>
      </span>
      {content}
    </Menu.RadioItem>
  );
  const startMenu = (
    <Menu.Root
      onOpenChange={(open) => {
        if (open) listBranches();
        else setBranchFilter('');
      }}
    >
      <Menu.Trigger
        className="cr-pk"
        aria-label={t({ id: 'sessions.newWorkspace.start', defaultMessage: 'Start point' })}
      >
        <GitBranch aria-hidden="true" />
        <span className="cr-pkn">
          {t(
            { id: 'sessions.newWorkspace.from', defaultMessage: 'From {name}' },
            { name: startSession ? sessionRow(startSession).title : (startBranch ?? headName) },
          )}
        </span>
        <ChevronDown className="cr-dn" aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={4} style={{ zIndex: 40 }}>
          <Menu.Popup className="wmenu pjm pop cr-stm">
            <Menu.RadioGroup
              value={startSession || startBranch !== null ? JSON.stringify(from) : HEAD}
              onValueChange={(value: string) =>
                setStart(value === HEAD ? null : (JSON.parse(value) as From))
              }
            >
              {startItem(HEAD, headName)}
              {branchRead && (branchRead.state !== 'ready' || listed.length > 0) && (
                <Menu.Separator className="pjm-sep" />
              )}
              {branchRead?.state === 'loading' && (
                <div className="cr-bst" role="status">
                  {t({ id: 'sessions.startBranch.loading', defaultMessage: 'Reading branches…' })}
                </div>
              )}
              {branchRead?.state === 'failed' && (
                <>
                  <div className="cr-bst" role="alert" data-bad>
                    {branchRead.text}
                  </div>
                  <Menu.Item closeOnClick={false} onClick={listBranches}>
                    {t({ id: 'sessions.startBranch.retry', defaultMessage: 'Retry' })}
                  </Menu.Item>
                </>
              )}
              {listed.length > BRANCH_FILTER_FROM && (
                <label className="pjm-q">
                  <Search className="ic-sm" aria-hidden="true" />
                  <input
                    type="search"
                    aria-label={t({
                      id: 'sessions.startBranch.filter',
                      defaultMessage: 'Filter branches',
                    })}
                    value={branchFilter}
                    onChange={(e) => setBranchFilter(e.target.value)}
                    // The menu's typeahead would take the typed letters; arrows and Escape still reach it.
                    onKeyDown={(e) => {
                      if (!['ArrowDown', 'ArrowUp', 'Escape', 'Tab'].includes(e.key))
                        e.stopPropagation();
                    }}
                  />
                </label>
              )}
              {listed
                .filter((b) => b.name.toLowerCase().includes(needle))
                .map((b) =>
                  startItem(
                    JSON.stringify({ branch: b.name }),
                    <>
                      <span className="cr-brn">{b.name}</span>
                      {b.checked_out && (
                        <span className="cr-btag">
                          {t({ id: 'sessions.startBranch.current', defaultMessage: 'Current' })}
                        </span>
                      )}
                      <span className="cr-sha">{b.sha.slice(0, 7)}</span>
                      <span className="cr-meta">{ageText(b.commit_time, now)}</span>
                    </>,
                    'cr-bri',
                  ),
                )}
              {starts.length > 0 && <Menu.Separator className="pjm-sep" />}
              {starts.map((s) =>
                startItem(JSON.stringify({ session_id: s.id }), sessionRow(s).title),
              )}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );

  const where = t({
    id: 'sessions.composer.whereStarts',
    defaultMessage: 'Where the session starts',
  });
  const wherePicker = (
    <Popover.Root>
      <Popover.Trigger className="cr-wp" aria-label={where}>
        <Folder aria-hidden="true" />
        <span className="cr-wpn">{projectName}</span>
        <span className="cr-wpw">
          {workspace === 'worktree'
            ? t({ id: 'sessions.newWorkspace.worktree', defaultMessage: 'New worktree' })
            : t({ id: 'sessions.newWorkspace.inPlace', defaultMessage: 'Current folder' })}
        </span>
        <GitBranch aria-hidden="true" />
        <span className="cr-wpb">
          {startSession ? sessionRow(startSession).title : (startBranch ?? headName)}
        </span>
        <ChevronDown className="cr-dn" aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={4} style={{ zIndex: 40 }}>
          <Popover.Popup className="pop cr-ws" aria-label={where}>
            <div className="cr-wsr">
              {picker}
              <span className="cr-seg">
                <RadioGroup<Workspace>
                  className="tb-seg"
                  aria-label={t({
                    id: 'sessions.newWorkspace.where',
                    defaultMessage: 'Where to change',
                  })}
                  aria-keyshortcuts={WORKSPACE_KEYS}
                  value={workspace}
                  onValueChange={setWorkspace}
                >
                  <Radio.Root value="worktree">
                    {t({ id: 'sessions.newWorkspace.worktree', defaultMessage: 'New worktree' })}
                  </Radio.Root>
                  <Radio.Root value="in_place">
                    {t({ id: 'sessions.newWorkspace.inPlace', defaultMessage: 'Current folder' })}
                  </Radio.Root>
                </RadioGroup>
                <span className="kbd hk" aria-hidden="true">
                  {keyText(WORKSPACE_KEYS)}
                </span>
              </span>
              {workspace === 'worktree' && startMenu}
            </div>

            {head && (
              <div className="cr-list">
                <div className="cr-head">
                  <GitBranch aria-hidden="true" />
                  {head.branch && <span className="cr-br">{head.branch}</span>}
                  <span className="cr-sha">{head.sha.slice(0, 7)}</span>
                  <span className="cr-sub" title={head.subject}>
                    {head.subject}
                  </span>
                  {head.ahead_upstream !== undefined && (
                    <span className="cr-num">
                      {t(
                        {
                          id: 'sessions.newWorkspace.ahead',
                          defaultMessage: '{count} ahead of upstream',
                        },
                        { count: head.ahead_upstream },
                      )}
                    </span>
                  )}
                </div>
                {head.uncommitted > 0 && (
                  <div className="cr-dirty">
                    <span className="cr-dot" aria-hidden="true" />
                    <span className="cr-cdt">
                      {t(
                        {
                          id: 'sessions.newWorkspace.uncommitted',
                          defaultMessage:
                            '{count, plural, one {# uncommitted change} other {# uncommitted changes}}',
                        },
                        { count: head.uncommitted },
                      )}
                    </span>
                    <span className="cr-then">
                      {workspace === 'worktree'
                        ? t({
                            id: 'sessions.newWorkspace.uncommittedLeft',
                            defaultMessage: 'The new worktree does not see them',
                          })
                        : t({
                            id: 'sessions.newWorkspace.uncommittedKept',
                            defaultMessage: 'The session changes them directly',
                          })}
                    </span>
                  </div>
                )}
              </div>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );

  const label = t({ id: 'sessions.composer.newSession', defaultMessage: 'New session' });
  const body = (
    <div className="cr-in" {...files.box}>
      {referred.map((s) => sessionRefCard(s, unrefer))}
      {githubRefs.map((r) => githubRefCard(r, unreferGithub))}
      <AttachmentStrip
        items={attachments.items}
        pending={attachments.pending}
        onRemove={attachments.remove}
        onRetry={(id) => void attachments.retry(id)}
      />
      <CompletionPopup
        id={completion.id}
        items={completion.items}
        active={completion.active}
        onPick={completion.pick}
      />
      <textarea
        {...completion.textarea}
        rows={3}
        spellCheck
        aria-label={t({
          id: 'sessions.composer.firstMessage',
          defaultMessage: 'First message of the new session',
        })}
        placeholder={t({
          id: 'sessions.composer.firstMessagePlaceholder',
          defaultMessage: 'What needs doing…',
        })}
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
          completion.moved(e.target.selectionStart ?? e.target.value.length);
        }}
        onPaste={files.onPaste}
        onKeyDown={(e) => {
          if (completion.onKeyDown(e)) return;
          if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
          if (getLook().send_key === 'meta-enter' && !shortcutMatches('send', e)) return;
          e.preventDefault();
          void create();
        }}
      />
      {voice.state.phase !== 'idle' ? (
        <VoiceBar
          state={voice.state}
          slow={voice.slow}
          now={Date.now()}
          onStop={voice.stop}
          onCancel={voice.cancel}
          onRetry={voice.retry}
          onOpenSettings={() => void voice.openSettings()}
        />
      ) : (
        <div className="cp-row">
          <Menu.Root open={adding} onOpenChange={(next) => setAdding(next)}>
            <Menu.Trigger
              className="cp-add"
              aria-label={t({
                id: 'sessions.composer.addMenu',
                defaultMessage: 'Add, reference, command',
              })}
              aria-keyshortcuts={shortcutKeys('attach') || undefined}
            >
              <Plus aria-hidden="true" />
              <KeyHint id="attach" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner side="top" align="start" sideOffset={4} style={{ zIndex: 40 }}>
                <Menu.Popup className="pop cp-am" finalFocus={box}>
                  <Menu.Group className="cp-amg">
                    <Menu.GroupLabel className="cp-cap">
                      {t({ id: 'sessions.composer.addGroup', defaultMessage: 'Add' })}
                    </Menu.GroupLabel>
                    <Menu.Item className="cp-mi" onClick={() => void attachments.choose()}>
                      <FileText className="cp-mic" aria-hidden="true" />
                      <span className="cp-mil">
                        {t({
                          id: 'sessions.composer.addFile',
                          defaultMessage: 'File or image',
                        })}
                      </span>
                    </Menu.Item>
                  </Menu.Group>
                  <Menu.Group className="cp-amg">
                    <Menu.GroupLabel className="cp-cap">
                      {t({
                        id: 'sessions.composer.referenceGroup',
                        defaultMessage: 'Reference',
                      })}
                    </Menu.GroupLabel>
                    <Menu.Item className="cp-mi" onClick={mention}>
                      <Folder className="cp-mic" aria-hidden="true" />
                      <span className="cp-mil">
                        {t({ id: 'sessions.composer.mentionFile', defaultMessage: 'File' })}
                      </span>
                      <span className="kbd" aria-hidden="true">
                        @
                      </span>
                    </Menu.Item>
                    {sessionRefMenu({
                      sessions: props.recent,
                      refs,
                      full: refs.length + githubRefs.length >= MAX_REFS,
                      onRefer: refer,
                      finalFocus: box,
                    })}
                  </Menu.Group>
                  <Menu.Group className="cp-amg">
                    <Menu.GroupLabel className="cp-cap">
                      {t({
                        id: 'sessions.composer.abilityGroup',
                        defaultMessage: 'Capabilities',
                      })}
                    </Menu.GroupLabel>
                    <Menu.Item className="cp-mi" onClick={command}>
                      <Zap className="cp-mic" aria-hidden="true" />
                      <span className="cp-mil">
                        {t({ id: 'sessions.composer.command', defaultMessage: 'Command' })}
                      </span>
                      <span className="kbd" aria-hidden="true">
                        /
                      </span>
                    </Menu.Item>
                  </Menu.Group>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
          {wherePicker}
          <ModelMenu
            runtimes={offered}
            models={models}
            value={model}
            onChange={setChoice}
            unavailable={unavailable}
            disconnected={disconnected}
            backends={backends}
            mode={picked}
            onMode={setMode}
            fast={{ on: fastOn }}
            onFast={setFast}
            ultracode={ultracodeOn}
            onUltracode={setUltracode}
          />
          <Tip content={conductorLabel()}>
            <button
              type="button"
              className="ib"
              aria-label={conductorLabel()}
              aria-pressed={conductor}
              onClick={() => pick({ conductor: !conductor })}
            >
              <Crown aria-hidden="true" />
            </button>
          </Tip>
          <span style={{ flex: 1 }} />
          {voice.available && (
            <button
              type="button"
              className="vc-mic"
              aria-label={t({ id: 'sessions.voice.start', defaultMessage: 'Voice input' })}
              onClick={voice.start}
            >
              <Mic aria-hidden="true" />
            </button>
          )}
          <SendButton
            label={t({ id: 'sessions.newWorkspace.begin', defaultMessage: 'Start' })}
            pri
            shortcut="dialog-next"
            busy={busy}
            state={ON}
            empty={empty}
            onPress={() => void create()}
          />
        </div>
      )}
      {status.state === 'failed' && <span className="tr-why">{status.text}</span>}
      {holder && pickedWorkspace === undefined && start === null && (
        <span className="tr-why">
          {t(
            {
              id: 'sessions.newWorkspace.folderHeld',
              defaultMessage: '{title} is writing in the project folder',
            },
            { title: sessionRow(holder).title },
          )}
        </span>
      )}
      {(error ?? attachments.error) && (
        <span className="tr-err" role="alert">
          {error ?? attachments.error}
        </span>
      )}
    </div>
  );
  // Sessions in progress and GitHub items, under the box; they take its keys too.
  const sug = empty && (props.recent.length > 0 || githubOffered || githubOff) && (
    <div className="cr-sug" onKeyDown={onComposerKey}>
      {props.recent.length > 0 && (
        <div className="cr-sgg" role="group" aria-label={inProgress}>
          <span className="cr-gh" aria-hidden="true">
            {inProgress}
          </span>
          {suggested.map((s, i) => (
            <div key={s.id} className="cr-sg">
              <button
                type="button"
                className="cr-sgm"
                aria-keyshortcuts={
                  i < SUGGESTED ? digitKeys(shortcutKeys('session-number'), i + 1) : undefined
                }
                onClick={() => props.onOpen(s.id)}
              >
                <span className="cr-gl" aria-hidden="true">
                  <SessionStateIcon session={s} place="list" />
                </span>
                <span className="cr-sgt">{sessionRow(s).title}</span>
                {s.conductor && (
                  <Crown className="ic-sm cr-agent" role="img" aria-label={conductorLabel()} />
                )}
                <span className="cr-sgs">{why(s)}</span>
                <span className="cr-meta">{ageText(Date.parse(s.last_activity_at), now)}</span>
                {i < SUGGESTED && <KeyHint id="session-number" digit={i + 1} />}
              </button>
              <span className="cr-acts">
                <button type="button" className="btn ghost sm" onClick={() => refer(s)}>
                  {t({
                    id: 'sessions.newWorkspace.referSession',
                    defaultMessage: 'New with its history',
                  })}
                </button>
              </span>
            </div>
          ))}
          {!allShown && props.recent.length > SUGGESTED && (
            <button type="button" className="cr-more" onClick={() => setAllShown(true)}>
              {t(
                { id: 'sessions.newWorkspace.more', defaultMessage: '{count} more' },
                { count: props.recent.length - SUGGESTED },
              )}
            </button>
          )}
        </div>
      )}
      {githubGroup('pr')}
      {githubGroup('issue')}
      {githubOff && (
        <div className="cr-sgx">
          <span className="cr-gl" aria-hidden="true">
            <StateGlyph name="idle" />
          </span>
          <span className="cr-sgs">
            {t({
              id: 'sessions.newWorkspace.githubOff',
              defaultMessage: 'GitHub not connected',
            })}
          </span>
          <button type="button" className="btn ghost sm" onClick={connectGithub}>
            {t({ id: 'sessions.newWorkspace.connectGithub', defaultMessage: 'Connect' })}
          </button>
        </div>
      )}
    </div>
  );
  const scratch = (
    <button
      type="button"
      className="btn cr-scratch"
      disabled={busy}
      aria-disabled={conductor ? 'true' : undefined}
      onClick={conductor ? undefined : () => void create('project_setup')}
    >
      <Sprout size={14} aria-hidden="true" />
      {scratchLabel()}
    </button>
  );
  return (
    <>
      <header className="cr-hero">
        <h1 className="cr-ttl">
          {t({ id: 'sessions.composer.heroQuestion', defaultMessage: 'What should we work on?' })}
        </h1>
      </header>
      {fromScratch &&
        (conductor ? (
          <Tip
            content={t({
              id: 'sessions.composer.fromScratchConductor',
              defaultMessage: 'Main agent and start from scratch cannot be used together',
            })}
          >
            {scratch}
          </Tip>
        ) : (
          scratch
        ))}
      <div className="cr-box">
        <section className="cr-dlg" aria-label={label} onKeyDown={onComposerKey}>
          {body}
        </section>
        {sug}
      </div>
    </>
  );
}
