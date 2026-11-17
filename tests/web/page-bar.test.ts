import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardSnapshot } from '@pantheon/protocol';
import { App } from '@/App';
import { TopBar } from '@/components/TopBar';
import { useBoard } from '@/data/board';
import { useCurrentProject } from '@/data/current-project';
import { SCREEN_NAMES } from '@/screens';
import { InsightsView } from '@/screens/insights/InsightsScreen';
import { MemoryScreen } from '@/screens/memory/MemoryScreen';
import { ProjectsScreen } from '@/screens/projects/ProjectsScreen';
import { TraceScreen } from '@/screens/trace/TraceScreen';
import { useShell, type Screen } from '@/store';
import { zh } from './i18n-setup.js';

const board = (): BoardSnapshot =>
  ({
    cursor: 0,
    projects: [{ id: 'alpha', revision: 1, name: 'Alpha app', roots: ['/work/alpha'] }],
    sessions: [],
  }) as unknown as BoardSnapshot;

/** The page's top bar and the rest of the page, as markup. */
function split(node: ReactElement) {
  const html = renderToStaticMarkup(node);
  const bars = html.match(/<header class="tb">[\s\S]*?<\/header>/g) ?? [];
  expect(bars).toHaveLength(1);
  return { bar: bars[0]!, body: html.replace(bars[0]!, '') };
}

const traceTabs = ['timeline', 'runs', 'activity', 'diagnose', 'approved'].map((tab) =>
  zh(`trace.tab.${tab}`),
);
const tabs = (html: string) => [...html.matchAll(/role="tab"[^>]*>([^<]*)</g)].map((m) => m[1]);

afterEach(() => {
  vi.unstubAllGlobals();
  useBoard.setState({ board: null });
  useShell.setState({ screen: 'board', sessionId: null, traceTab: 'timeline' });
});

describe('page top bar', () => {
  it('puts the page name, the muted count and the page controls in one header row', () => {
    const html = renderToStaticMarkup(
      createElement(
        TopBar,
        { title: '运行', count: 2, countLabel: '2 个 agent 运行中' },
        createElement('button', { type: 'button' }, 'go'),
      ),
    );
    expect(html).toMatch(/^<header class="tb"><h1>运行<\/h1>/);
    expect(html).toContain('aria-label="2 个 agent 运行中"');
    expect(html).toContain('>2</span>');
    expect(html).toContain('<button type="button">go</button></header>');
  });

  it('holds the engineering board name, its section tabs and the time range', () => {
    const { bar, body } = split(
      createElement(InsightsView, {
        model: null,
        loading: true,
        error: null,
        onRetry() {},
        days: 7,
        onDays() {},
        section: 'iterations',
        onSection() {},
        onOpenSession() {},
        onOpenStory() {},
      }),
    );
    expect(bar).toContain(`<h1>${SCREEN_NAMES.insights}</h1>`);
    expect(tabs(bar)).toEqual(
      [
        'insights.sections.iterations',
        'insights.sections.collab',
        'insights.sections.workflow',
        'board.sections.quality',
        'board.sections.usage',
        'board.panels.retro',
        'insights.digest.label',
        'insights.sections.signals',
      ].map((id) => zh(id)),
    );
    expect(bar).toMatch(
      new RegExp(`role="radiogroup"[^>]*aria-label="${zh('board.headline.range')}"`),
    );
    expect(tabs(body)).toEqual([]);
  });

  it('holds the trace name, its view tabs and the view switch', () => {
    const { bar, body } = split(createElement(TraceScreen, { projectId: 'alpha', sessions: [] }));
    expect(bar).toContain(`<h1>${SCREEN_NAMES.trace}</h1>`);
    expect(bar).toMatch(new RegExp(`role="tablist"[^>]*aria-label="${zh('trace.tabs.label')}"`));
    expect(tabs(bar)).toEqual(traceTabs);
    expect(bar).toMatch(new RegExp(`role="radiogroup"[^>]*aria-label="${zh('trace.view')}"`));
    expect(tabs(body)).toEqual([]);
    expect(body).not.toContain('role="radiogroup"');
  });

  it('keeps the trace top bar over the runs tab, with the runs body in the tab', () => {
    useShell.setState({ traceTab: 'runs' });
    const { bar, body } = split(createElement(TraceScreen, { projectId: 'alpha', sessions: [] }));
    expect(bar).toContain(`<h1>${SCREEN_NAMES.trace}</h1>`);
    expect(tabs(bar)).toEqual(traceTabs);
    expect(bar).not.toContain(zh('runs.page.follow'));
    expect(body).toContain(`aria-label="${zh('runs.page.nowLabel')}"`);
    expect(body).not.toContain('<h1');
    expect(body).not.toContain('role="radiogroup"');
  });

  it('holds the memory name and its overview, entries, graph and learned tabs', () => {
    const { bar, body } = split(createElement(MemoryScreen, { projectId: 'alpha' }));
    expect(bar).toContain(`<h1>${SCREEN_NAMES.memory}</h1>`);
    expect(tabs(bar)).toEqual(
      ['overview', 'entries', 'graph', 'learned'].map((tab) => zh(`memory.tab.${tab}`)),
    );
    expect(tabs(body)).toEqual([]);
  });

  it('holds the projects name, their count, the import and the open buttons', () => {
    useBoard.setState({ board: board() });
    const { bar, body } = split(
      createElement(ProjectsScreen, { onOpenSettings() {}, onOpenProject() {} }),
    );
    expect(bar).toContain(`<h1>${SCREEN_NAMES.projects}</h1>`);
    expect(bar).toContain('>1</span>');
    expect(bar).toContain(zh('projects.import.open'));
    expect(bar).toContain(zh('projects.open.title'));
    expect(body).not.toContain('<h1');
  });
});

describe('app top bar', () => {
  const app = (screen: Screen, sessionId: string | null = null) => {
    useBoard.setState({ board: board() });
    useCurrentProject.getState().choose('alpha');
    useShell.setState({ screen, sessionId });
    return renderToStaticMarkup(createElement(App));
  };

  it.each([
    ['names the project board in its one top bar', 'board'],
    ['names the memory page in its one top bar', 'memory'],
  ] as const)('%s', (_name, screen) => {
    const html = app(screen);
    expect(html.match(/<header class="tb">/g)).toHaveLength(1);
    expect(html).toContain(`<header class="tb"><h1>${SCREEN_NAMES[screen]}</h1>`);
  });

  it('draws no location path on any screen', () => {
    vi.stubGlobal('window', { innerWidth: 1440 });
    for (const [screen, sessionId] of [
      ['board', null],
      ['insights', null],
      ['sessions', ''],
      ['projects', null],
    ] as const)
      expect(app(screen, sessionId)).not.toContain('aria-label="位置"');
  });
});
