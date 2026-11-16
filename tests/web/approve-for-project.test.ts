import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { BoardSnapshot } from '@pantheon/protocol';
import { type HookHost, mount, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
const mock = vi.hoisted(() => ({ runCommand: vi.fn() }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/commands', () => ({ runCommand: mock.runCommand }));
import type { NeedsYouItem } from '@/data/needs-you';
import { needsCard, type NoticeWatch } from '@/data/notice-tiers';
import type { PendingPermission } from '@/screens/sessions/model';
import { PermissionCard } from '@/screens/sessions/SessionsScreen';

const item = (supported: boolean | undefined): NeedsYouItem => ({
  source: { table: 'approvals', id: 'approval-1', revision: 4 },
  kind: 'permission',
  project_id: 'project-a',
  session_id: 'session-a',
  status: 'pending',
  created_at: Date.UTC(2026, 0, 2, 3, 39),
  reason: 'permission_requested',
  actions: [{ command: 'approval.respond', allowed: true }],
  binding: {
    action: 'Bash',
    input_summary: 'pnpm test',
    rule: 'Bash(pnpm test:*)',
    ...(supported === undefined ? {} : { project_rule_supported: supported }),
  },
});

const choices = (...keys: string[]) => keys.map((key) => zh(`sessions.card.${key}`));
afterEach(() => {
  unmountAll();
  mock.runCommand.mockReset();
});

function card(supported: boolean | undefined, extra: Partial<PendingPermission> = {}) {
  const permission: PendingPermission = {
    id: 'approval-1',
    tool: 'Bash',
    revision: 4,
    rule: 'Bash(pnpm test:*)',
    ...extra,
  };
  const needs = { items: [item(supported)], loading: false, error: null, reload: () => {} };
  return mount(() =>
    PermissionCard({ permission, needs, input: { command: 'pnpm test' }, folders: ['/repo'] }),
  );
}
const labels = (h: HookHost<any>) =>
  nodes(h.value as ReactElement)
    .filter((n) => n.type === 'button')
    .map((n) => text(n));

describe('allowing a request for the whole project', () => {
  it('offers it beside the session choice when the request supports a project rule', () => {
    expect(labels(card(true))).toEqual(
      choices('allowOnce', 'allowSession', 'allowProject', 'deny'),
    );
  });

  it('leaves it out when the request does not support a project rule', () => {
    expect(labels(card(false))).toEqual(choices('allowOnce', 'allowSession', 'deny'));
    expect(labels(card(undefined))).toEqual(choices('allowOnce', 'allowSession', 'deny'));
  });

  it('answers with the project decision', async () => {
    mock.runCommand.mockResolvedValue({ ok: true, value: {} });
    const h = card(true);
    nodes(h.value as ReactElement)
      .find((n) => n.type === 'button' && text(n) === zh('sessions.card.allowProject'))!
      .props.onClick();
    await h.flush();
    expect(mock.runCommand.mock.calls).toEqual([
      ['approval.respond', { approval_id: 'approval-1', decision: 'approve_project' }, 4],
    ]);
  });

  it('keeps the notice card to allowing once and rejecting', () => {
    const board = {
      cursor: 0,
      projects: [{ id: 'project-a', name: 'Alpha app' }],
      sessions: [{ id: 'session-a', project_id: 'project-a', native_title: 'Fix login' }],
    } as unknown as BoardSnapshot;
    const away: NoticeWatch = { focused: false, sessionId: null } as NoticeWatch;
    const notice = needsCard(item(true), board, away, () => {})!;
    expect(notice.options.actions!.map((a) => a.label)).toEqual([
      zh('data.noticeTiers.allowOnce'),
      zh('data.noticeTiers.reject'),
    ]);
  });
});
