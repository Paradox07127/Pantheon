import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Sidebar } from '@/components/Sidebar';
import { zh } from './i18n-setup.js';

const shell = vi.hoisted(() => ({ screen: 'sessions' }));
// With no stored project the shell starts on all projects; the sidebar here shows a project.
vi.mock('@/store', async (actual) => {
  const real = await actual<typeof import('@/store')>();
  return {
    ...real,
    useShell: Object.assign(
      (selector: (state: unknown) => unknown) =>
        selector({ ...real.useShell.getState(), screen: shell.screen }),
      real.useShell,
    ),
  };
});

const PAGES = ['trace', 'memory'].map((s) => zh(`app.screenName.${s}`));

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

afterEach(() => {
  vi.unstubAllGlobals();
  shell.screen = 'sessions';
});

describe('project page entries', () => {
  it('lists the project and changes entries and no trace or memory entry, open or folded', () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
    const open = render(false);
    const entries = [...open.matchAll(/class="sb-it"[^>]*>(?:<svg.*?<\/svg>)?([^<]*)<\/button>/g)];
    expect(entries.map((m) => m[1])).toEqual([
      zh('app.screenName.project'),
      zh('app.screenName.changes'),
      zh('app.screenName.settings'),
    ]);
    const rail = render(true);
    const icons = [...rail.matchAll(/class="ib" aria-label="([^"]*)"/g)].map((m) => m[1]);
    expect(icons).toContain(zh('app.screenName.project'));
    expect(icons).toContain(zh('app.screenName.changes'));
    expect(icons).toContain(zh('app.screenName.settings'));
    for (const gone of [...PAGES, zh('app.screenName.flow')]) {
      expect(open).not.toContain(`>${gone}</button>`);
      expect(rail).not.toContain(`aria-label="${gone}"`);
    }
  });

  it.each([
    [
      'open',
      false,
      (name: string) => `>${name}</button>`,
      (name: string) => new RegExp(`aria-current="page"[^>]*>(?:<svg.*?</svg>)?${name}<`),
    ],
    [
      'folded',
      true,
      (name: string) => `aria-label="${name}"`,
      (name: string) => new RegExp(`aria-label="${name}"[^>]*aria-current="page"`),
    ],
  ] as const)(
    'puts the project entry above changes and marks it current on the project screen, %s',
    (_name, collapsed, entry, current) => {
      vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
      const project = zh('app.screenName.project');
      const changes = zh('app.screenName.changes');
      const before = render(collapsed);
      expect(before.indexOf(entry(project))).toBeGreaterThan(-1);
      expect(before.indexOf(entry(project))).toBeLessThan(before.indexOf(entry(changes)));
      expect(before).not.toMatch(current(project));
      shell.screen = 'project';
      expect(render(collapsed)).toMatch(current(project));
    },
  );
});
