import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { type HookHost, mount, named, nodes, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector({ board: null }), {
    getState: () => ({ board: null }),
    subscribe: () => () => {},
  }),
}));
vi.mock('@/store', () => {
  const shell = { theme: 'system', setTheme() {} };
  return { useShell: Object.assign((selector: any) => selector(shell), { getState: () => shell }) };
});
vi.mock('@/screens/settings/view', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSettingsView: (select: any) =>
    select({ runtime: 'codex', setRuntime() {}, page: 'sessionDisplay', setPage() {}, query: '' }),
}));
import { DEFAULT_LOOK, getLook, readLook, setLook } from '@/data/layout';
import {
  exportPersonalSettings,
  importPersonalSettings,
  personalSettings,
} from '@/data/personal-settings';
import {
  DEFAULT_SESSION_DISPLAY,
  getSessionDisplay,
  readSessionDisplay,
  SESSION_DISPLAY_KEY,
  setSessionDisplay,
} from '@/data/session-display';
import { ProjectSettingsScreen } from '@/screens/settings/ProjectSettingsScreen';
import { hitGroups } from '@/screens/settings/settings-jump';

let stored: Map<string, string>;
const label = (key: string) => zh(`settings.sessionDisplay.${key}`);
const child = (node: any) => mount(() => node.type(node.props) as ReactNode);

beforeEach(() => {
  stored = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
  vi.stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false }),
  });
});
afterEach(() => {
  unmountAll();
  setSessionDisplay(DEFAULT_SESSION_DISPLAY);
  setLook(DEFAULT_LOOK);
  vi.unstubAllGlobals();
});

describe('session display store', () => {
  it('falls back to the default for each missing or unreadable field', () => {
    expect(readSessionDisplay(null)).toEqual({
      state_motion: 'all',
      timeline: 'labels',
      overview: 'open',
      plan_bar: true,
      running_send: 'queue',
      reasoning: true,
      vendor_marks: 'brand',
      context_usage: true,
    });
    expect(readSessionDisplay('{bad')).toEqual(DEFAULT_SESSION_DISPLAY);
    expect(
      readSessionDisplay(
        JSON.stringify({
          state_motion: 'some',
          timeline: 1,
          overview: null,
          plan_bar: 'no',
          running_send: 'interrupt',
          reasoning: 0,
          vendor_marks: 'grey',
          context_usage: 'off',
        }),
      ),
    ).toEqual(DEFAULT_SESSION_DISPLAY);
    expect(readSessionDisplay(JSON.stringify({ timeline: 'marks' }))).toEqual({
      ...DEFAULT_SESSION_DISPLAY,
      timeline: 'marks',
    });
  });

  it('reads back what it stored', () => {
    const chosen = {
      state_motion: 'waiting',
      timeline: 'off',
      overview: 'folded',
      plan_bar: false,
      running_send: 'steer',
      reasoning: false,
      vendor_marks: 'mono',
      context_usage: false,
    } as const;
    setSessionDisplay(chosen);
    expect(getSessionDisplay()).toEqual(chosen);
    expect(readSessionDisplay(stored.get(SESSION_DISPLAY_KEY)!)).toEqual(chosen);
  });

  it('keeps reading the older tool call choices and takes the new one', () => {
    expect(readLook(JSON.stringify({ transcript: 'expanded' })).transcript).toBe('expanded');
    expect(readLook(JSON.stringify({ transcript: 'folded' })).transcript).toBe('folded');
    expect(readLook(JSON.stringify({ transcript: 'open-failed' })).transcript).toBe('open-failed');
    expect(readLook(JSON.stringify({ transcript: 'all' })).transcript).toBe('folded');
  });

  it('goes out with the personal settings and applies on import', () => {
    setSessionDisplay({ timeline: 'marks', reasoning: false });
    const file = exportPersonalSettings();
    expect(JSON.parse(file).session_display).toEqual({
      ...DEFAULT_SESSION_DISPLAY,
      timeline: 'marks',
      reasoning: false,
    });
    setSessionDisplay(DEFAULT_SESSION_DISPLAY);
    expect(importPersonalSettings(file)).toBe(true);
    expect(getSessionDisplay().timeline).toBe('marks');
    expect(getSessionDisplay().reasoning).toBe(false);
    expect(JSON.parse(stored.get(SESSION_DISPLAY_KEY)!).timeline).toBe('marks');
  });

  it('refuses a file without the section or with a broken one', () => {
    setSessionDisplay({ overview: 'off' });
    const file = JSON.parse(exportPersonalSettings());
    delete file.session_display;
    expect(importPersonalSettings(JSON.stringify(file))).toBe(false);
    expect(
      importPersonalSettings(JSON.stringify({ ...file, session_display: { overview: 'never' } })),
    ).toBe(false);
    expect(personalSettings().session_display.overview).toBe('off');
  });
});

describe('the Session display page', () => {
  function page() {
    const screen = mount(() => ProjectSettingsScreen());
    const app = child(named(screen.value, 'AppPage'));
    return child(named(app.value, 'SessionDisplayPage'));
  }
  const control = (h: HookHost<any>, name: string) =>
    nodes(h.value).find((n) => n.props['aria-label'] === name)!;

  it('lists one row per setting, each starting at the present behaviour', () => {
    const h = page();
    const rows = nodes(h.value).filter(
      (n) => typeof n.type === 'function' && n.type.name === 'Row',
    );
    expect(rows.map((n) => n.props.label)).toEqual(
      [
        'stateMotion',
        'timeline',
        'overview',
        'planBar',
        'toolCalls',
        'runningSend',
        'reasoning',
        'vendorMarks',
        'contextUsage',
      ].map(label),
    );
    const first = (name: string) => {
      const group = control(h, label(name));
      return [group.props.value, nodes(group.props.children)[0]!.props.value];
    };
    for (const name of [
      'stateMotion',
      'timeline',
      'overview',
      'toolCalls',
      'runningSend',
      'vendorMarks',
    ]) {
      const [value, leading] = first(name);
      expect(value, name).toBe(leading);
    }
    for (const name of ['planBar', 'reasoning', 'contextUsage'])
      expect(control(h, label(name)).props.checked, name).toBe(true);
  });

  it('changes each preference from its control', () => {
    const h = page();
    control(h, label('stateMotion')).props.onValueChange('off');
    control(h, label('timeline')).props.onValueChange('marks');
    control(h, label('overview')).props.onValueChange('folded');
    control(h, label('planBar')).props.onChange({ target: { checked: false } });
    control(h, label('runningSend')).props.onValueChange('steer');
    control(h, label('reasoning')).props.onChange({ target: { checked: false } });
    control(h, label('vendorMarks')).props.onValueChange('mono');
    control(h, label('contextUsage')).props.onChange({ target: { checked: false } });
    control(h, label('toolCalls')).props.onValueChange('open-failed');
    expect(getSessionDisplay()).toEqual({
      state_motion: 'off',
      timeline: 'marks',
      overview: 'folded',
      plan_bar: false,
      running_send: 'steer',
      reasoning: false,
      vendor_marks: 'mono',
      context_usage: false,
    });
    expect(getLook().transcript).toBe('open-failed');
  });

  it('offers the three tool call choices in order', () => {
    const group = control(page(), label('toolCalls'));
    expect(nodes(group.props.children).map((n) => n.props.value)).toEqual([
      'folded',
      'open-failed',
      'expanded',
    ]);
  });

  it('finds the tool call row by search on the Session display page', () => {
    expect(hitGroups(label('toolCalls')).map((g) => g.page)).toEqual(['sessionDisplay']);
    expect(hitGroups('Tool calls').map((g) => g.page)).toEqual(['sessionDisplay']);
  });
});
