import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Sidebar } from '@/components/Sidebar';
import { readBoardPage } from '@/data/board-page';
import { zh } from './i18n-setup.js';

// With no stored project the shell starts on all projects; the sidebar here shows a project.
vi.mock('@/store', async (actual) => {
  const real = await actual<typeof import('@/store')>();
  return {
    ...real,
    useShell: Object.assign(
      (selector: (state: unknown) => unknown) =>
        selector({ ...real.useShell.getState(), screen: 'board' }),
      real.useShell,
    ),
  };
});

const PAGES = ['board', 'insights', 'repo', 'trace', 'memory'].map((s) =>
  zh(`app.screenName.${s}`),
);

const render = (collapsed: boolean) =>
  renderToStaticMarkup(
    createElement(Sidebar, {
      layout: { collapsed, width: 280, resize() {}, commit() {}, reset() {}, toggle() {} },
      projects: [{ id: 'project-a', name: 'Alpha' }],
      currentProjectId: 'project-a',
      onChooseProject() {},
      list: { data: [], loading: false, error: null, reload() {} },
      allNeeds: { items: [], loading: false, error: null, reload() {} },
    }),
  );

afterEach(() => vi.unstubAllGlobals());

describe('project page entries', () => {
  it('lists the project board, engineering board, repository, trace and memory, in that order', () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
    const open = render(false);
    const entries = [...open.matchAll(/class="sb-it"[^>]*>(?:<svg.*?<\/svg>)?([^<]*)<\/button>/g)];
    expect(entries.map((m) => m[1]).slice(0, 6)).toEqual([...PAGES, zh('app.screenName.settings')]);
    const rail = render(true);
    const icons = [...rail.matchAll(/class="ib" aria-label="([^"]*)"/g)].map((m) => m[1]);
    expect(icons.slice(0, 5)).toEqual(PAGES);
    for (const gone of [zh('app.screenName.runtime'), zh('app.screenName.flow')]) {
      expect(open).not.toContain(`>${gone}</button>`);
      expect(rail).not.toContain(`aria-label="${gone}"`);
    }
  });
});

describe('stored places', () => {
  it('opens a board left on the introduction or memory view on its now view', () => {
    expect(readBoardPage('intro')).toBe('now');
    expect(readBoardPage('memory')).toBe('now');
  });
});
