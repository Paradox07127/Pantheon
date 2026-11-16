import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Session } from '@pantheon/domain';
import type { WorkbenchSession } from '@pantheon/protocol';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector: any) => selector(mock.shell), {
    getState: () => mock.shell,
  }),
}));
import { ProjectMonogram } from '@/components/ProjectMonogram';
import {
  compareRuntimes,
  KNOWN_RUNTIMES,
  RuntimeGlyph,
  runtimeColor,
  runtimeName,
  runtimeTraits,
} from '@/components/RuntimeGlyph';
import { projectColor } from '@/components/Sidebar';
import { ProjectRow } from '@/screens/projects/ProjectsScreen';
import { ModelMenu } from '@/screens/sessions/parts';
import { SessionHeader, SessionRowButton } from '@/screens/sessions/SessionsScreen';

const source = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../apps/web/${path}`, import.meta.url)), 'utf8');

beforeEach(() => {
  mock.board = {
    board: { sessions: [], session_turns: [], projects: [], workspaces: [], cursor: 1 },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  mock.shell = {};
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const listed = (runtime: string): WorkbenchSession => ({
  id: 'session-a',
  created_at: '2026-11-03T00:00:00.000Z',
  title: 'Release notes',
  runtime,
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-a',
  workspace_kind: 'linked_worktree',
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-03T00:00:00.000Z',
  changes: { files: 2, additions: 3, deletions: 1 },
  merge: null,
});

const isGlyph = (runtime: string) => (n: any) =>
  n.type === RuntimeGlyph && n.props.runtime === runtime;

/** The ACP runtimes after Muse, in table order, with their display names. */
const ACP_RUNTIMES: [string, string][] = [
  ['opencode', 'OpenCode'],
  ['cursor', 'Cursor'],
  ['copilot', 'GitHub Copilot'],
  ['gemini', 'Gemini CLI'],
  ['kilo', 'Kilo Code'],
  ['cline', 'Cline'],
  ['qwen', 'Qwen Code'],
  ['kimi', 'Kimi Code'],
  ['goose', 'Goose'],
  ['openhands', 'OpenHands'],
  ['kiro', 'Kiro'],
  ['junie', 'Junie'],
  ['devin', 'Devin'],
  ['vibe', 'Mistral Vibe'],
  ['auggie', 'Augment'],
  ['hermes', 'Hermes Agent'],
  ['omp', 'omp'],
  ['codebuddy', 'CodeBuddy'],
  ['droid', 'Factory Droid'],
  ['qoder', 'Qoder'],
];
const ACP_IDS = ACP_RUNTIMES.map(([id]) => id);
const KNOWN = ['claude', 'codex', 'agy', 'grok', 'dsh', 'muse', ...ACP_IDS];
/** The runtimes the table names without a vendor mark, so without a colour of their own. */
const UNMARKED = ['auggie', 'omp', 'droid'];
const TONED = KNOWN.filter((runtime) => !UNMARKED.includes(runtime));
/** What the UI does for a runtime whose ACP modes Pantheon does not set. */
const NO_MODES = {
  modes: [],
  modeNames: {},
  skillSigil: '/',
  skillPath: false,
  turnSkills: false,
  reviewer: 'claude',
  appsLabel: 'Apps',
  extensions: false,
};

describe('runtime identity table', () => {
  it('names, colours and orders the known runtimes and keeps another runtime as given', () => {
    expect([...KNOWN, 'fixture'].map(runtimeName)).toEqual([
      'Claude',
      'Codex',
      'agy',
      'grok',
      'DeepSeek',
      'Muse',
      ...ACP_RUNTIMES.map(([, name]) => name),
      'fixture',
    ]);
    expect([...KNOWN, 'fixture'].map(runtimeColor)).toEqual([
      ...KNOWN.map((runtime) =>
        UNMARKED.includes(runtime) ? 'var(--mu)' : `var(--rt-${runtime})`,
      ),
      'var(--mu)',
    ]);
    expect(['fixture', ...KNOWN].reverse().sort(compareRuntimes)).toEqual([...KNOWN, 'fixture']);
  });

  it('lists what each runtime does differently and gives another runtime the defaults', () => {
    expect(KNOWN_RUNTIMES).toEqual(KNOWN);
    expect(ACP_IDS.map(runtimeTraits)).toMatchObject(ACP_IDS.map(() => NO_MODES));
    expect(
      ['claude', 'codex', 'agy', 'grok', 'dsh', 'muse', 'fixture'].map(runtimeTraits),
    ).toMatchObject([
      {
        modes: ['ask', 'auto_edit', 'plan'],
        skillSigil: '/',
        skillPath: false,
        turnSkills: false,
        reviewer: 'codex',
        appsLabel: zh('components.runtime.claudeConnectors'),
      },
      {
        modes: ['auto_edit', 'plan'],
        skillSigil: '$',
        skillPath: true,
        turnSkills: true,
        reviewer: 'claude',
        appsLabel: 'Apps',
      },
      {
        modes: ['ask', 'auto_edit', 'plan'],
        skillSigil: '/',
        skillPath: false,
        turnSkills: false,
        reviewer: 'claude',
        appsLabel: 'Apps',
      },
      {
        modes: [],
        skillSigil: '/',
        skillPath: false,
        turnSkills: false,
        reviewer: 'claude',
        appsLabel: 'Apps',
      },
      {
        modes: ['auto_edit', 'plan'],
        skillSigil: '/',
        skillPath: false,
        turnSkills: false,
        reviewer: 'claude',
        appsLabel: 'Apps',
        extensions: false,
      },
      {
        modes: [],
        skillSigil: '/',
        skillPath: false,
        turnSkills: false,
        reviewer: 'claude',
        appsLabel: 'Apps',
        extensions: false,
      },
      {
        modes: ['ask', 'auto_edit', 'plan'],
        skillSigil: '/',
        skillPath: false,
        turnSkills: false,
        reviewer: 'claude',
        appsLabel: 'Apps',
      },
    ]);
  });

  it('defines each runtime colour in both themes', () => {
    const css = source('src/index.css');
    for (const selector of [/^:root \{[^}]*color-scheme[^}]*\}/m, /^\.dark \{[^}]*\}/m]) {
      const block = css.match(selector)?.[0] ?? '';
      for (const runtime of TONED)
        expect(block).toMatch(new RegExp(`--rt-${runtime}: #[0-9A-F]{6};`));
    }
  });
});

describe('project monogram', () => {
  it('fills a 16px square with the project colour under the first letter', () => {
    const square = ProjectMonogram({ id: 'project-a', name: 'alpha app' });
    expect(square.props['aria-hidden']).toBe(true);
    expect(square.props.className).toBe('pmono');
    expect(square.props.style).toEqual({ '--pmono': projectColor('project-a') });
    expect(text(square)).toBe('A');
    expect(text(ProjectMonogram({ id: 'project-b', name: '星图' }))).toBe('星');
  });

  it('is 16px with the inner radius, the small type and the page colour', () => {
    const rule = source('src/index.css').match(/^\.pmono\{[^}]*\}/m)?.[0] ?? '';
    for (const part of [
      'width:16px',
      'height:16px',
      'border-radius:max(calc(var(--r-sm) - 2px),4px)',
      'font-size:var(--fs-xs)',
      'font-weight:600',
      'color:var(--bg)',
      'background:color-mix(in srgb,var(--pmono) 80%,var(--tx))',
    ])
      expect(rule).toContain(part);
  });

  it('heads each project row and each project in the switcher menu', () => {
    const card = ProjectRow({
      project: { id: 'project-a', revision: 1, name: 'Alpha', roots: ['/work/a'] } as any,
      summary: undefined,
      oldestWait: null,
      now: 0,
      onOpenSettings: () => {},
      onRemove: () => {},
    });
    const head = find(card, (n) => n.props.className === 'pr-mark');
    const parts = nodes(head.props.children).filter((n) => n !== head);
    expect(parts[0]!.type).toBe(ProjectMonogram);
    expect(parts[0]!.props).toEqual({ id: 'project-a', name: 'Alpha' });
    expect(nodes(card).some((n) => n.props.className === 'pg-sq')).toBe(false);
    expect(source('src/components/Sidebar.tsx')).toMatch(
      /<ProjectMonogram id=\{p\.id\} name=\{p\.name\} \/>\s*\{p\.name\}/,
    );
  });
});

describe('runtime glyph placement', () => {
  it('leads a session row, before its title, under the status mark', () => {
    const row = SessionRowButton({
      session: listed('codex'),
      on: false,
      now: Date.parse('2026-11-03T00:05:00.000Z'),
      onSelect: () => {},
    });
    const parts = [row.props.children].flat(2).filter(Boolean);
    const avatar = parts.findIndex((n: any) => n.type?.name === 'Avatar');
    expect(avatar).toBeGreaterThanOrEqual(0);
    expect(avatar).toBeLessThan(parts.findIndex((n: any) => text(n) === 'Release notes'));
    const drawn = parts[avatar].type(parts[avatar].props);
    const first = [drawn.props.children].flat().find(Boolean);
    expect(isGlyph('codex')(first)).toBe(true);
    expect(row.props['aria-label']).toContain('Codex');
  });

  it('leaves the thread bar to the state glyph before the title', () => {
    const session = {
      id: 'session-a',
      revision: 1,
      project_id: 'project-a',
      runtime: 'claude',
      state: 'open',
      turn_count: 1,
    } as Session;
    const h = mount(() =>
      SessionHeader({
        session,
        listed: listed('claude'),
        title: 'Release notes',
        panels: [],
        onPanel() {},
        overview: true,
      }),
    );
    const head = find(h.value, (n) => n.type === 'header');
    const parts = [head.props.children].flat().filter(Boolean);
    expect(parts[0].type.name).toBe('SessionStateIcon');
    expect(parts.some(isGlyph('claude'))).toBe(false);
    expect(parts.find((p) => p.type === 'h1')).toBeTruthy();
  });

  it('marks each runtime in the model menu', () => {
    const h = mount(() =>
      ModelMenu({
        runtimes: ['claude', 'codex'],
        models: {},
        value: { runtime: 'claude', backend: null, model: null, effort: null },
        onChange: () => {},
      }),
    );
    for (const runtime of ['claude', 'codex']) {
      const item = find(h.value, (n) => n.key === runtime && n.props.value === runtime);
      const parts = [item.props.children].flat();
      const name = parts.findIndex((p) => text(p) === runtimeName(runtime));
      expect(name).toBeGreaterThan(0);
      expect(parts.findIndex(isGlyph(runtime))).toBe(name - 1);
    }
  });
});
