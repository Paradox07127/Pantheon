import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCurrentProject } from '@/data/current-project';
import { jumpTo } from '@/screens/settings/settings-jump';
import { searchSettings } from '@/screens/settings/settings-search';
import { useSettingsView } from '@/screens/settings/view';
import { useShell } from '@/store';

let stored: Map<string, string>;
const ids = (query: string) => searchSettings(query).map((h) => h.id);

beforeEach(() => {
  stored = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  useSettingsView.setState({ open: false, query: '', page: 'general' });
});

describe('settings search reaches the workflow definition', () => {
  it('finds the custom steps, the plan review tiers and the most review rounds', () => {
    expect(ids('审查轮数')[0]).toBe('workflow.reviewRounds');
    expect(ids('计划审查')).toContain('workflow.planReviewTiers');
    expect(ids('自定义步骤')[0]).toBe('workflow.customSteps');
  });

  it('closes the settings and opens the current project board on its workflow tab', () => {
    useShell.setState({ screen: 'sessions' });
    useCurrentProject.setState({ projectId: 'beta' });
    useSettingsView.setState({ open: true, query: '审查轮数' });
    jumpTo(searchSettings('审查轮数')[0]!);
    expect(useSettingsView.getState().open).toBe(false);
    expect(useCurrentProject.getState().projectId).toBe('beta');
    expect(useShell.getState().screen).toBe('insights');
    expect(stored.get('pantheon.insights.beta')).toBe('workflow');
  });
});

describe('settings search reveals a setting whose row renders after the jump', () => {
  it('scrolls to and flashes the row once the page has read its settings', () => {
    vi.useFakeTimers();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      frames.push(callback),
    );
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    const row = {
      dataset: {} as DOMStringMap,
      scrollIntoView: vi.fn(),
      closest: () => null,
      addEventListener: () => {},
    };
    let rendered = false;
    vi.stubGlobal('document', {
      querySelector: (selector: string) =>
        rendered && selector === '[data-setting-id="general.baselineVisuals"]' ? row : null,
    });
    const hit = searchSettings('绘制解释图').find((h) => h.id === 'general.baselineVisuals');
    expect(hit).toBeDefined();
    useSettingsView.setState({ open: true, page: 'appearance', query: '绘制解释图' });
    jumpTo(hit!);
    // The general page draws its rows only after its settings read returns.
    frames.shift()!(0);
    rendered = true;
    for (let i = 0; i < 100 && frames.length; i++) frames.shift()!(0);
    expect(row.scrollIntoView).toHaveBeenCalledOnce();
    expect(row.dataset.flash).toBe('on');
    vi.useRealTimers();
  });

  it('scrolls to the row when a busy daemon answers the settings read after more than a second', () => {
    vi.useFakeTimers();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      frames.push(callback),
    );
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    const row = {
      dataset: {} as DOMStringMap,
      scrollIntoView: vi.fn(),
      closest: () => null,
      addEventListener: () => {},
    };
    let rendered = false;
    vi.stubGlobal('document', {
      querySelector: (selector: string) =>
        rendered && selector === '[data-setting-id="general.baselineVisuals"]' ? row : null,
    });
    const hit = searchSettings('绘制解释图').find((h) => h.id === 'general.baselineVisuals');
    useSettingsView.setState({ open: true, page: 'appearance', query: '绘制解释图' });
    jumpTo(hit!);
    const frame = () => {
      vi.advanceTimersByTime(16);
      frames.shift()?.(0);
    };
    // 90 frames at 60 Hz: the read answers after one and a half seconds.
    for (let i = 0; i < 90; i++) frame();
    rendered = true;
    for (let i = 0; i < 10; i++) frame();
    expect(row.scrollIntoView).toHaveBeenCalledOnce();
    expect(row.dataset.flash).toBe('on');
    vi.useRealTimers();
  });
});
