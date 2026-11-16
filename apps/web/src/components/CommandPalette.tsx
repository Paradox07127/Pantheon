import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Bot, File, GitBranch, Search, SquarePen, User } from 'lucide-react';
import type { SessionSearchHit } from '@pantheon/protocol';
import { useBoard } from '../data/board';
import { useCurrentProject } from '../data/current-project';
import { failureText } from '../data/needs-you';
import { searchProjects, visibleProjects } from '../data/projects';
import { searchFiles } from '../data/runtime-models';
import { searchSessions } from '../data/session-search';
import { t } from '../i18n';
import { keyText } from '../lib/shortcuts';
import {
  fileItem,
  paletteIntent,
  paletteQuery,
  paletteSections,
  searchHitItems,
  type PaletteGroup,
  type PaletteItem,
  type PaletteSection,
} from './palette';
import { ProjectMonogram } from './ProjectMonogram';
import { SessionStateIcon } from './SessionStateIcon';
import { Tip } from './Tip';
import { toast } from './Toast';
import { useShell } from '../store';
import './command-palette.css';

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: PaletteItem[];
  /** Item ids of the recently opened sessions, newest first; they lead an empty search. */
  recent?: readonly string[];
  /** The current project, whose first folder a search looks for files in, and that folder. */
  fileSearch?: { projectId: string; root?: string };
  /** Opens the new-session page with the text in its composer; offered when nothing matches. */
  onNewSession?: (text: string) => void;
  /** Whether this window shows the place a found project or message opens; a session window does not. */
  navigable?: boolean;
}

const FILE_DELAY_MS = 150;
const NO_PATHS: { for: string | null; paths: readonly string[] } = { for: null, paths: [] };
const NO_HITS: { for: string | null; hits: readonly SessionSearchHit[]; complete: boolean } = {
  for: null,
  hits: [],
  complete: true,
};
const MESSAGE_MIN = 2;
const NO_PROJECTS: readonly never[] = [];
const START_ID = 'new-session-with-text';
const boardProjects = () => useBoard.getState().board?.projects ?? NO_PROJECTS;

// The project is chosen before the one navigation, which would drop a navigation still owed.
function openBoard(projectId: string) {
  useCurrentProject.getState().choose(projectId);
  useShell.getState().followFirstSession();
  useShell.getState().setScreen('board');
}

const groupName = (group: PaletteGroup): string =>
  group === 'session'
    ? t({ id: 'components.commandPalette.groupSessions', defaultMessage: 'Sessions' })
    : group === 'project'
      ? t({ id: 'components.commandPalette.groupProjects', defaultMessage: 'Projects' })
      : group === 'command'
        ? t({ id: 'components.commandPalette.groupCommands', defaultMessage: 'Commands' })
        : group === 'file'
          ? t({ id: 'components.commandPalette.groupFiles', defaultMessage: 'Files' })
          : t({ id: 'components.commandPalette.groupMessages', defaultMessage: 'Messages' });

const searchIn = (project: string) =>
  t(
    { id: 'components.commandPalette.searchIn', defaultMessage: 'Search in {project}' },
    { project },
  );

const leadIcon = (lead: 'user' | 'agent' | 'branch') =>
  lead === 'user' ? (
    <User
      size={16}
      role="img"
      aria-label={t({ id: 'components.commandPalette.byUser', defaultMessage: 'You' })}
    />
  ) : lead === 'agent' ? (
    <Bot
      size={16}
      role="img"
      aria-label={t({ id: 'components.commandPalette.byAgent', defaultMessage: 'Agent' })}
    />
  ) : (
    <GitBranch
      size={16}
      role="img"
      aria-label={t({ id: 'components.commandPalette.branch', defaultMessage: 'Branch' })}
    />
  );

/** ⌘K: find a session, project, command or file by its name and run or open it. */
export function CommandPalette({
  open,
  onOpenChange,
  items,
  recent,
  fileSearch,
  onNewSession,
  navigable = true,
}: CommandPaletteProps) {
  // Opened by a shortcut there is no trigger, so focus goes back to what had it before.
  const before = useRef<HTMLElement | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) before.current = document.activeElement as HTMLElement | null;
  }
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="cmdk-scrim" />
        <Dialog.Popup
          className="cmdk"
          finalFocus={() => before.current ?? true}
          aria-label={t({
            id: 'components.commandPalette.label',
            defaultMessage: 'Command palette',
          })}
        >
          <PaletteBody
            open={open}
            items={items}
            recent={recent}
            fileSearch={fileSearch}
            navigable={navigable}
            onRun={(item) => {
              onOpenChange(false);
              item.run();
            }}
            onSplit={(item, sessionId) => {
              onOpenChange(false);
              useShell.getState().openSplit(sessionId);
              // With no session to sit beside, the split does not open: the session opens alone.
              if (useShell.getState().splitId !== sessionId) item.run();
            }}
            onNewSession={
              onNewSession &&
              ((text) => {
                onOpenChange(false);
                onNewSession(text);
              })
            }
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PaletteBody({
  open,
  items,
  recent,
  fileSearch,
  navigable,
  onRun,
  onSplit,
  onNewSession,
}: {
  open: boolean;
  items: PaletteItem[];
  recent?: readonly string[];
  fileSearch?: { projectId: string; root?: string };
  navigable: boolean;
  onRun: (item: PaletteItem) => void;
  /** Opens the item's session beside the one shown. */
  onSplit: (item: PaletteItem, sessionId: string) => void;
  onNewSession?: (text: string) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  // An item id, so a refresh that reorders the results keeps the selection; the first item stands in.
  const [active, setActive] = useState<string | null>(null);
  // The paths found last and the search they answer; a new search shows them until its own arrive.
  const [found, setFound] = useState(NO_PATHS);
  // The same for the messages found across sessions.
  const [said, setSaid] = useState(NO_HITS);
  // The project Tab locked the search to.
  const [locked, setLocked] = useState<string | null>(null);
  // The body stays mounted until the dialog unmounts, so a reopening then starts a new search here.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setQuery('');
      setActive(null);
      setFound(NO_PATHS);
      setSaid(NO_HITS);
      setLocked(null);
    }
  }
  // The caller builds the items only while open; the closing dialog keeps the last ones.
  const [held, setHeld] = useState({ items, recent });
  if (open && (held.items !== items || held.recent !== recent)) setHeld({ items, recent });

  const allProjects = useSyncExternalStore(useBoard.subscribe, boardProjects, boardProjects);
  const projects = useMemo(() => visibleProjects(allProjects), [allProjects]);
  const scoped = projects.find((p) => p.id === locked) ?? null;
  const currentId = fileSearch?.projectId ?? null;
  // The caller's sessions are the current project's.
  const elsewhere = scoped !== null && scoped.id !== currentId;
  const pool = useMemo(
    () => (elsewhere ? held.items.filter((i) => i.group !== 'session') : held.items),
    [elsewhere, held.items],
  );
  const place = scoped ? { projectId: scoped.id, root: scoped.roots[0] } : fileSearch;
  const bridge = place && window.pantheon;
  const projectId = bridge ? place.projectId : null;
  const root = place?.root;
  const { scope, text } = paletteQuery(query);
  const fileQuery =
    projectId !== null && (scope === 'files' || (scope === 'all' && text !== '')) ? text : null;
  const search = fileQuery === null ? null : `${projectId}\n${fileQuery}`;
  useEffect(() => {
    if (projectId === null || fileQuery === null) return;
    let current = true;
    const timer = setTimeout(() => {
      void searchFiles(projectId, null, fileQuery).then((result) => {
        if (current) setFound({ for: search, paths: result.ok ? result.value : [] });
      });
    }, FILE_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [projectId, fileQuery]);
  const messageQuery =
    navigable && scope === 'all' && text.trim().length >= MESSAGE_MIN ? text.trim() : null;
  const scopedId = scoped?.id ?? null;
  const messageSearch = messageQuery === null ? null : `${scopedId ?? ''}\n${messageQuery}`;
  useEffect(() => {
    if (messageQuery === null) return;
    let current = true;
    const timer = setTimeout(() => {
      const pantheon = window.pantheon;
      // session.search takes a project, which searchSessions leaves to its bridge to add.
      const via =
        pantheon && scopedId !== null
          ? {
              query: (method: string, params?: Record<string, string | string[]>) =>
                pantheon.query(method, { ...params, project_id: scopedId }),
            }
          : pantheon;
      void searchSessions(via, messageQuery).then((result) => {
        if (current)
          setSaid({
            for: messageSearch,
            hits: result.ok ? result.value.hits : [],
            complete: !result.ok || result.value.indexing_complete,
          });
      });
    }, FILE_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [messageSearch]);
  const messages = useMemo(
    () => searchHitItems(said.hits, useShell.getState().openProjectSession),
    [said.hits],
  );
  const projectText = navigable && (scope === 'all' || scope === 'projects') ? text : null;
  const places = useMemo(
    () =>
      projectText === null
        ? []
        : searchProjects(projects, projectText).map((p): PaletteItem => ({
            id: `project-${p.id}`,
            group: 'project',
            label: p.name,
            ...(p.roots[0] ? { sub: p.roots[0] } : {}),
            project: p.id,
            run: () => openBoard(p.id),
          })),
    [projects, projectText],
  );
  const intent = useMemo(
    () => (scope === 'all' ? paletteIntent(text, projects, pool) : null),
    [scope, text, projects, pool],
  );
  const files = useMemo(
    () =>
      found.paths.map((path) =>
        fileItem(
          path,
          () =>
            void window.pantheon?.openFile({ path, base: root }).then((result) => {
              if (!result.ok) toast({ title: failureText(result.error), kind: 'failure' });
            }),
        ),
      ),
    [found.paths, root],
  );

  const indexing = messageQuery !== null && !said.complete;
  const lead = intent?.lead ?? null;
  const matched = useMemo((): PaletteSection[] => {
    const local = paletteSections(
      pool,
      query,
      held.recent,
      search === null ? [] : files,
      places,
      lead,
    );
    const shownMessages = messageQuery === null ? [] : messages;
    return shownMessages.length > 0 || indexing
      ? [...local, { group: 'message', items: shownMessages }]
      : local;
  }, [
    pool,
    query,
    held.recent,
    search === null,
    files,
    places,
    lead,
    messageQuery === null,
    messages,
    indexing,
  ]);
  // A new session starts in the current project, so a search locked elsewhere offers none.
  const canStart = onNewSession && !elsewhere;
  const sentence = canStart && intent?.sentence ? text.trim() : null;
  const sections: PaletteSection[] =
    sentence === null
      ? matched
      : [
          {
            group: null,
            items: [
              {
                id: START_ID,
                group: 'action',
                label: t(
                  {
                    id: 'components.commandPalette.newSessionWith',
                    defaultMessage: 'New session: {text}',
                  },
                  { text: sentence },
                ),
                run: () => onNewSession!(sentence),
              },
            ],
          },
          ...matched,
        ];
  const shown = sections.flatMap((s) => s.items);
  // Nothing matched, and no file or message search is still on its way.
  const none =
    query !== '' &&
    shown.length === 0 &&
    (search === null || found.for === search) &&
    (messageQuery === null || said.for === messageSearch);
  const startText = canStart && none && text.trim() !== '' ? text.trim() : null;
  // The new-session row closes the palette itself.
  const choose = (item: PaletteItem) => (item.id === START_ID ? item.run() : onRun(item));
  const indexOf = (item: PaletteItem) => shown.indexOf(item);
  const pos = shown.findIndex((item) => item.id === active);
  const current = pos >= 0 ? pos : shown.length > 0 ? 0 : -1;
  const selected = shown[current]?.id;
  const optionId = (i: number) => `${id}-${i}`;

  useEffect(() => {
    if (current >= 0)
      document.getElementById(optionId(current))?.scrollIntoView({ block: 'nearest' });
  }, [current, selected]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && startText !== null) {
      e.preventDefault();
      onNewSession!(startText);
      return;
    }
    if (e.key === 'Backspace' && query === '' && scoped) {
      setLocked(null);
      return;
    }
    if (shown.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : shown.length - 1;
      setActive(shown[(current + step) % shown.length]!.id);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = shown[current]!;
      if ((e.metaKey || e.ctrlKey) && item.session) onSplit(item, item.session.id);
      else choose(item);
    } else if (e.key === 'Tab') {
      const project = shown[current]!.project;
      if (!project || project === currentId) return;
      e.preventDefault();
      setLocked(project);
      setQuery('');
      setActive(null);
    }
  };

  const row = (item: PaletteItem) => {
    const i = indexOf(item);
    return (
      <Tip key={item.id} content={item.label}>
        <div
          key={item.id}
          id={optionId(i)}
          role="option"
          aria-selected={i === current}
          className="cmdk-op"
          aria-keyshortcuts={item.keys}
          onMouseMove={() => i !== current && setActive(item.id)}
          onClick={() => choose(item)}
        >
          <span className="cmdk-ld" aria-hidden={item.found ? undefined : 'true'}>
            {item.found ? (
              leadIcon(item.found.lead)
            ) : item.session ? (
              <SessionStateIcon session={item.session} place="list" />
            ) : item.project ? (
              <ProjectMonogram id={item.project} name={item.label} />
            ) : item.group === 'file' ? (
              <File size={16} />
            ) : item.id === START_ID ? (
              <SquarePen size={16} />
            ) : null}
          </span>
          <span className="cmdk-lb">
            {item.found ? (
              <>
                {item.found.before}
                <mark className="hit">{item.found.match}</mark>
                {item.found.after}
              </>
            ) : (
              item.label
            )}
          </span>
          {item.sub && (
            <span
              className={
                item.group === 'file' || item.group === 'project' ? 'cmdk-sub mono' : 'cmdk-sub'
              }
            >
              {item.sub}
            </span>
          )}
          {item.keys && <span className="kbd">{keyText(item.keys)}</span>}
          {item.archived && (
            <span className="cmdk-ht">
              {t({ id: 'components.commandPalette.archived', defaultMessage: 'Archived' })}
            </span>
          )}
        </div>
      </Tip>
    );
  };

  return (
    <>
      <label className="cmdk-bar">
        <Search className="cmdk-ic" size={16} aria-hidden="true" />
        {scoped && (
          <span className="cmdk-scope">
            <ProjectMonogram id={scoped.id} name={scoped.name} />
            {scoped.name}
          </span>
        )}
        <input
          aria-label={
            scoped
              ? searchIn(scoped.name)
              : t({ id: 'components.commandPalette.search', defaultMessage: 'Search' })
          }
          placeholder={
            scoped
              ? searchIn(scoped.name)
              : t({
                  id: 'components.commandPalette.placeholder',
                  defaultMessage: 'Search projects, sessions, files and commands',
                })
          }
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={shown.length > 0}
          aria-controls={id}
          aria-activedescendant={current >= 0 ? optionId(current) : undefined}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(null);
          }}
          onKeyDown={onKeyDown}
          className="cmdk-in"
        />
        <kbd className="kbd">esc</kbd>
      </label>
      <div
        id={id}
        role="listbox"
        aria-label={t({ id: 'components.commandPalette.commands', defaultMessage: 'Commands' })}
        className="cmdk-list"
      >
        {sections.map((section) =>
          section.group === null ? (
            section.items.map(row)
          ) : (
            <div
              key={section.group}
              role="group"
              aria-labelledby={`${id}-${section.group}`}
              className="cmdk-grp"
            >
              <div id={`${id}-${section.group}`} role="presentation" className="cmdk-gh">
                {groupName(section.group)}
              </div>
              {section.items.map(row)}
              {section.group === 'message' && indexing && (
                <div role="presentation" className="cmdk-gh">
                  {t({
                    id: 'components.commandPalette.stillIndexing',
                    defaultMessage: 'Still indexing; results may be incomplete',
                  })}
                </div>
              )}
            </div>
          ),
        )}
      </div>
      {none && (
        <div className="cmdk-none">
          <span>
            {t({
              id: 'components.commandPalette.noResults',
              defaultMessage: 'No matching results',
            })}
          </span>
          {startText !== null && (
            <button type="button" className="btn sm" onClick={() => onNewSession!(startText)}>
              <SquarePen size={16} aria-hidden="true" />
              {t({
                id: 'components.commandPalette.startWithText',
                defaultMessage: 'Start a new session with this',
              })}
            </button>
          )}
        </div>
      )}
      <div className="cmdk-ft">
        <span className="cmdk-fk">
          <kbd className="kbd">↑</kbd>
          <kbd className="kbd">↓</kbd>
          {t({ id: 'components.commandPalette.footSelect', defaultMessage: 'Select' })}
        </span>
        <span className="cmdk-fk">
          <kbd className="kbd">↵</kbd>
          {t({ id: 'components.commandPalette.footOpen', defaultMessage: 'Open' })}
        </span>
        {navigable && (
          <>
            <span className="cmdk-fk">
              <kbd className="kbd">{keyText('Meta+Enter')}</kbd>
              {t({ id: 'components.commandPalette.footSplit', defaultMessage: 'Open beside' })}
            </span>
            <span className="cmdk-fk">
              <kbd className="kbd">tab</kbd>
              {t({ id: 'components.commandPalette.footEnter', defaultMessage: 'Enter project' })}
            </span>
            <span className="cmdk-fk cmdk-fe">
              <kbd className="kbd">@</kbd>
              {groupName('project')}
            </span>
          </>
        )}
        <span className={navigable ? 'cmdk-fk' : 'cmdk-fk cmdk-fe'}>
          <kbd className="kbd">&gt;</kbd>
          {groupName('command')}
        </span>
        {bridge && (
          <span className="cmdk-fk">
            <kbd className="kbd">#</kbd>
            {groupName('file')}
          </span>
        )}
      </div>
    </>
  );
}
