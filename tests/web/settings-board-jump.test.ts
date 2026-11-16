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
