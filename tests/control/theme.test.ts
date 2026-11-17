import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { Principal, Session } from '@pantheon/domain';
import { command, type CommandType } from '@pantheon/protocol';
import { deriveTheme, themeCss, type ThemeInput } from '@pantheon/protocol/theme';
import { fixture, user } from '../helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const paper: ThemeInput = {
  label: 'Paper',
  light: { anchors: { 'surface-0': '#f3f3f1', 'text-primary': '#1a1a18' } },
};
const night: ThemeInput = {
  label: 'Night',
  dark: { anchors: { 'surface-0': '#0e0e0d', 'text-primary': '#ededE9' } },
  roles: { accent: '#6aa8ff' },
};
const faint: ThemeInput = {
  label: 'Faint',
  light: { anchors: { 'surface-0': '#777777', 'text-primary': '#888888' } },
};
/** A theme from canvas, text and accent in light, then in dark. */
const both = (label: string, light: string[], dark: string[]): ThemeInput => {
  const mode = ([surface, text, accent]: string[]) => ({
    anchors: { 'surface-0': surface!, 'text-primary': text! },
    roles: { accent: accent! },
  });
  return { label, light: mode(light), dark: mode(dark) };
};
const builtIns: Record<string, ThemeInput> = {
  'builtin-travertine': both(
    'Travertine',
    ['#FBF7EE', '#3A2E22', '#8A6A3F'],
    ['#211C15', '#F1E6CF', '#C9A46A'],
  ),
  'builtin-dusk': both(
    'Dusk',
    ['#F3F5FB', '#1F2D54', '#24345F'],
    ['#141B33', '#F1E6CF', '#FFD58A'],
  ),
  'builtin-lapis': both(
    'Lapis',
    ['#F2F4FC', '#182760', '#2F4BA8'],
    ['#111839', '#E9E3CF', '#E9C46A'],
  ),
  'builtin-terracotta': both(
    'Terracotta',
    ['#FCF5F0', '#4A2A1A', '#B4532A'],
    ['#231711', '#FBF1E2', '#E07A4C'],
  ),
};

async function themes() {
  const configDir = mkdtempSync(path.join(tmpdir(), 'pantheon-theme-config-'));
  const f = await fixture({
    managedWorkspaces: true,
    controlOptions: { userConfigDir: configDir },
  });
  cleanups.push(async () => {
    await f.close();
    rmSync(configDir, { recursive: true, force: true });
  });
  const session = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Make the app look like paper',
  });
  const lead: Principal = {
    id: `session:${session.id}`,
    role: 'lead',
    project_id: f.project.id,
    session_id: session.id,
    expires_at: f.store.now() + 60000,
  };
  const call = <T = unknown>(type: string, input: unknown, actor: Principal = user): T =>
    f.control.execute(
      actor,
      command(actor.id, type as CommandType, input as Record<string, unknown>),
    ) as T;
  const set = (input: ThemeInput, actor: Principal = lead) =>
    call<{ theme_id: string; warnings: string[] }>('theme.set', input, actor);
  const active = () => f.control.themeList(user).active_theme_id;
  const applied = () =>
    f.store.db
      .prepare("SELECT payload FROM events WHERE kind='theme.applied' ORDER BY sequence")
      .all()
      .map((row) => JSON.parse((row as { payload: string }).payload) as unknown);
  const rows = () => f.store.db.prepare('SELECT id FROM themes').all().length;
  return { ...f, configDir, session, lead, call, set, active, applied, rows };
}

it('keeps the applied theme with the themes it saved, not in the shared user configuration', async () => {
  const f = await themes();
  f.set(paper);
  expect(f.active()).toBe('paper');
  expect(existsSync(path.join(f.configDir, 'config.json'))).toBe(false);
});

it('saves and applies a theme a session sets and returns its warnings', async () => {
  const f = await themes();
  const receipt = f.set(paper);
  expect(receipt).toEqual({ theme_id: 'paper', warnings: deriveTheme(paper).warnings });
  expect(f.rows()).toBe(1);
  expect(f.active()).toBe('paper');
  expect(f.applied()).toEqual([{ theme_id: 'paper', by_session_id: f.session.id }]);
});

it('refuses a theme whose contrast is too low and lists every blocking line', async () => {
  const f = await themes();
  f.set(paper);
  const { blocking } = deriveTheme(faint);
  expect(blocking.length).toBeGreaterThan(1);
  let message = '';
  try {
    f.set(faint);
  } catch (error) {
    message = (error as Error).message;
  }
  for (const line of blocking) expect(message).toContain(line);
  expect(f.rows()).toBe(1);
  expect(f.active()).toBe('paper');
  expect(f.applied()).toHaveLength(1);
});

it('refuses a backdrop that carries a script', async () => {
  const f = await themes();
  expect(() =>
    f.set({ ...paper, backdrop: { svg: '<svg><script>alert(1)</script></svg>' } }),
  ).toThrow('backdrop contains <script');
  expect(f.rows()).toBe(0);
});

it('names the theme it replaced, and applying that one again undoes the change', async () => {
  const f = await themes();
  f.set(paper);
  f.set(night);
  expect(f.applied().at(-1)).toEqual({
    theme_id: 'night',
    previous_theme_id: 'paper',
    by_session_id: f.session.id,
  });
  f.call('theme.apply', { theme_id: 'paper' });
  expect(f.active()).toBe('paper');
  expect(f.applied().at(-1)).toEqual({ theme_id: 'paper', previous_theme_id: 'night' });
});

it('goes back to the default theme and lets only the user apply or delete', async () => {
  const f = await themes();
  f.set(paper);
  f.call('theme.apply', { theme_id: null });
  expect(f.active()).toBeNull();
  expect(f.applied().at(-1)).toEqual({ theme_id: null, previous_theme_id: 'paper' });
  const planner: Principal = { id: 'agent', role: 'planner' };
  for (const actor of [f.lead, planner]) {
    expect(() => f.call('theme.apply', { theme_id: 'paper' }, actor)).toThrowError(
      expect.objectContaining({ code: 'permission_denied' }),
    );
    expect(() => f.call('theme.delete', { theme_id: 'paper' }, actor)).toThrowError(
      expect.objectContaining({ code: 'permission_denied' }),
    );
  }
  expect(f.rows()).toBe(1);
});

it('deleting the applied theme goes back to the default', async () => {
  const f = await themes();
  f.set(paper);
  f.call('theme.delete', { theme_id: 'paper' });
  expect(f.rows()).toBe(0);
  expect(f.active()).toBeNull();
  expect(f.applied().at(-1)).toEqual({ theme_id: null, previous_theme_id: 'paper' });
});

it('lists the saved themes with swatches and reads one with its CSS', async () => {
  const f = await themes();
  f.set(paper);
  const glass = { blur: 12, tint: '#ffffff', opacity: 0.5 };
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@keyframes a{to{opacity:0}}</style><rect width="10" height="10"/></svg>';
  f.set({ label: 'Paper', dark: night.dark, backdrop: { svg, glass } }, user);
  const dark = deriveTheme({ label: 'Paper', dark: night.dark }).modes.dark!;
  const list = f.control.themeList(user);
  expect({ ...list, themes: list.themes.filter((theme) => !theme.built_in) }).toEqual({
    active_theme_id: 'paper-2',
    themes: [
      {
        id: 'paper-2',
        label: 'Paper',
        modes: ['dark'],
        has_backdrop: true,
        built_in: false,
        created_at: expect.any(Number),
        swatches: { surface0: dark['--bg'], surface1: dark['--sf'], accent: dark['--ac'] },
      },
      {
        id: 'paper',
        label: 'Paper',
        modes: ['light'],
        has_backdrop: false,
        built_in: false,
        session_id: f.session.id,
        created_at: expect.any(Number),
        swatches: { surface0: '#f3f3f1', surface1: '#fdfdfb', accent: '#1a1a18' },
      },
    ],
  });
  expect(f.control.themeGet(user, 'paper-2')).toEqual({
    id: 'paper-2',
    label: 'Paper',
    css: themeCss('paper-2', deriveTheme({ label: 'Paper', dark: night.dark }).modes),
    backdrop: svg,
    glass,
    modes: ['dark'],
  });
  expect(f.control.themeGet(user, 'paper')).toEqual({
    id: 'paper',
    label: 'Paper',
    css: themeCss('paper', deriveTheme(paper).modes),
    modes: ['light'],
  });
});

it('lists the four built-in themes before the saved ones, each with contrast enough to apply', async () => {
  const f = await themes();
  f.set(paper);
  expect(f.control.themeList(user).themes.map((theme) => [theme.id, theme.built_in])).toEqual([
    ['builtin-travertine', true],
    ['builtin-dusk', true],
    ['builtin-lapis', true],
    ['builtin-terracotta', true],
    ['paper', false],
  ]);
  for (const [id, input] of Object.entries(builtIns)) {
    const { modes, blocking } = deriveTheme(input);
    expect(blocking, id).toEqual([]);
    expect(f.control.themeGet(user, id)).toEqual({
      id,
      label: input.label,
      css: themeCss(id, modes),
      modes: ['light', 'dark'],
    });
  }
});

it('applies a built-in theme by its id and moves on from it like a saved one', async () => {
  const f = await themes();
  f.set(paper);
  f.call('theme.apply', { theme_id: 'builtin-dusk' });
  expect(f.active()).toBe('builtin-dusk');
  expect(f.applied().at(-1)).toEqual({ theme_id: 'builtin-dusk', previous_theme_id: 'paper' });
  f.call('theme.apply', { theme_id: 'paper' });
  expect(f.active()).toBe('paper');
  expect(f.applied().at(-1)).toEqual({ theme_id: 'paper', previous_theme_id: 'builtin-dusk' });
  f.call('theme.apply', { theme_id: 'builtin-lapis' });
  f.call('theme.apply', { theme_id: null });
  expect(f.active()).toBeNull();
  expect(f.rows()).toBe(1);
});

it('refuses to delete a built-in theme', async () => {
  const f = await themes();
  f.call('theme.apply', { theme_id: 'builtin-lapis' });
  expect(() => f.call('theme.delete', { theme_id: 'builtin-lapis' })).toThrowError(
    expect.objectContaining({
      code: 'invalid_input',
      message: expect.stringContaining('built-in'),
    }),
  );
  expect(f.active()).toBe('builtin-lapis');
  expect(f.control.themeGet(user, 'builtin-lapis').label).toBe('Lapis');
});

it('never gives a saved theme the id of a built-in one', async () => {
  const f = await themes();
  const ids = ['Dusk', 'Builtin Dusk', 'Builtin', 'Builtin'].map(
    (label) => f.set({ ...paper, label }).theme_id,
  );
  expect(ids).toEqual(['dusk', 'theme-builtin-dusk', 'theme-builtin', 'theme-builtin-2']);
  expect(f.control.themeGet(user, 'builtin-dusk').css).toBe(
    themeCss('builtin-dusk', deriveTheme(builtIns['builtin-dusk']!).modes),
  );
});
