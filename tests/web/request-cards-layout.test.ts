import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { HookHost, mount, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
const mock = vi.hoisted(() => ({ runCommand: vi.fn() }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/commands', () => ({ runCommand: mock.runCommand }));
import { Collapsible } from '../../apps/web/node_modules/@base-ui/react/collapsible/index.mjs';
import type { RequestItem } from '@/data/transcript';
import type { PendingPermission } from '@/screens/sessions/model';
import { AnsweredRequest } from '@/screens/sessions/parts';
import { PermissionCard, RequestSlot } from '@/screens/sessions/SessionsScreen';
import { clockText } from '@/lib/time-text';

const asked = Date.UTC(2026, 0, 2, 3, 39);
const needsFor = (id: string) => ({
  items: [
    {
      source: { table: 'approvals' as const, id, revision: 4 },
      kind: 'permission' as const,
      project_id: 'project-a',
      status: 'pending',
      created_at: asked,
      reason: 'permission_requested' as const,
      actions: [{ command: 'approval.respond', allowed: true }],
    },
  ],
  loading: false,
  error: null,
  reload: () => {},
});

afterEach(() => {
  unmountAll();
  mock.runCommand.mockReset();
});
function card(tool: string, input: unknown, extra: Partial<PendingPermission> = {}) {
  const permission: PendingPermission = { id: 'approval-1', tool, revision: 4, ...extra };
  return mount(() =>
    PermissionCard({ permission, needs: needsFor('approval-1'), input, folders: ['/repo'] }),
  );
}
const all = (h: HookHost<any>) => nodes(h.value as ReactElement);
const withClass = (h: HookHost<any>, name: string) =>
  all(h).filter((n) => typeof n.props.className === 'string' && n.props.className === name);
const rows = (h: HookHost<any>) => withClass(h, 'rq-line');
const buttons = (tree: ReactElement) => nodes(tree).filter((n) => n.type === 'button');

describe('approval card', () => {
  it('names what the request would do by the kind of tool, and the tool itself otherwise', () => {
    const title = (tool: string, input: unknown) => text(withClass(card(tool, input), 'rq-title'));
    expect(title('Bash', { command: 'pnpm db:migrate' })).toBe(zh('sessions.card.runCommand'));
    expect(title('Edit', { file_path: '/repo/src/a.ts' })).toBe(zh('sessions.card.editFile'));
    expect(title('Read', { file_path: '/repo/src/a.ts' })).toBe(zh('sessions.card.readFile'));
    expect(title('mcp__files__stat', { path: 'a' })).toBe('mcp__files__stat');
  });

  it('puts the mark, the title, the command or path and the time on the first row', () => {
    const run = rows(card('Bash', { command: 'pnpm db:migrate --env staging' }))[0]!;
    const first = nodes(run)[1]!;
    const mark = (first.type as () => ReactElement<any>)();
    expect([mark.props.role, mark.props['aria-label']]).toEqual([
      'img',
      zh('sessions.card.waiting'),
    ]);
    expect(text(nodes(run)[2])).toBe(zh('sessions.card.runCommand'));
    expect(text(nodes(run).find((n) => n.props.className === 'rq-objt'))).toBe(
      'pnpm db:migrate --env staging',
    );
    expect(text(nodes(run).find((n) => n.props.className === 'rq-at'))).toBe(clockText(asked));
    const read = rows(card('Read', { file_path: '/repo/src/a.ts' }))[0]!;
    expect(text(nodes(read).find((n) => n.props.className === 'rq-objt'))).toBe('src/a.ts');
  });

  it('puts the rule an allow for the session lets through left of the three buttons', () => {
    const answer = rows(card('Bash', { command: 'pnpm test' }, { rule: 'Bash(pnpm test:*)' }))[1]!;
    expect(text(nodes(answer).find((n) => n.props.className === 'rq-note'))).toBe(
      'Bash(pnpm test:*)',
    );
    expect(buttons(answer).map((b) => [text(b), b.props.className])).toEqual([
      [zh('sessions.card.allowOnce'), 'btn pri'],
      [zh('sessions.card.allowSession'), 'btn'],
      [zh('sessions.card.deny'), 'btn ghost'],
    ]);
  });

  it('wraps the answers inside the card instead of running past a narrow one', () => {
    const css = readFileSync(
      path.resolve(import.meta.dirname, '../../apps/web/src/screens/sessions/requests.css'),
      'utf8',
    );
    const rule = /\n\.rq-btns \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('flex-wrap: wrap');
    expect(rule).toContain('min-width: 0');
    expect(rule).not.toContain('flex: none');
  });

  it('answers each button with its approval decision', async () => {
    mock.runCommand.mockResolvedValue({ ok: false, error: { code: 'conflict', message: 'x' } });
    const press = async (label: string) => {
      const h = card('Bash', { command: 'pnpm test' }, { rule: 'Bash(pnpm test:*)' });
      buttons(rows(h)[1]!)
        .find((b) => text(b) === label)!
        .props.onClick();
      await h.flush();
      return h;
    };
    await press(zh('sessions.card.allowOnce'));
    await press(zh('sessions.card.allowSession'));
    const denied = await press(zh('sessions.card.deny'));
    denied.render();
    buttons(denied.value as ReactElement)
      .find((b) => text(b) === zh('sessions.card.confirmDeny'))!
      .props.onClick();
    await denied.flush();
    expect(mock.runCommand.mock.calls).toEqual([
      ['approval.respond', { approval_id: 'approval-1', decision: 'approve' }, 4],
      ['approval.respond', { approval_id: 'approval-1', decision: 'approve_session' }, 4],
      ['approval.respond', { approval_id: 'approval-1', decision: 'reject' }, 4],
    ]);
  });

  it('keeps the whole input in a folded section behind the command', () => {
    const command = `${'node scripts/step.mjs && '.repeat(20)}echo the-distinct-tail`;
    const h = card('Bash', { command });
    const fold = all(h).find((n) => n.type === Collapsible.Root)!;
    expect(fold.props.open).toBeUndefined();
    expect(fold.props.defaultOpen).toBeUndefined();
    const trigger = all(h).find((n) => n.type === Collapsible.Trigger)!;
    expect(trigger.props['aria-label']).toBe(zh('sessions.parts.input'));
    const panel = all(h).find((n) => n.type === Collapsible.Panel)!;
    expect(text(panel)).toContain('the-distinct-tail');
    expect(all(h).some((n) => n.type === 'pre' && !nodes(panel).includes(n))).toBe(false);
  });
});

describe('answered request', () => {
  const answered = (outcome: RequestItem['outcome'], reason?: string) => {
    const item: RequestItem = {
      kind: 'request',
      id: 'request-1',
      tool: 'Bash',
      input: { command: 'pnpm db:migrate' },
      questions: [],
      outcome,
      ...(reason ? { reason } : {}),
    };
    const slot = mount(() => RequestSlot({ item, needs: needsFor('x'), folders: [], enter: '' }))
      .value as ReactElement<any>;
    expect(slot.type).toBe(AnsweredRequest);
    return (slot.type as (p: unknown) => ReactElement<any>)(slot.props);
  };

  it('folds into one row with the mark and the result', () => {
    const allowed = answered('approve');
    expect(Array.isArray(allowed)).toBe(false);
    expect(text(allowed)).toContain('pnpm db:migrate');
    expect(text(allowed)).toContain(zh('data.transcript.outcome.approve'));
    expect(text(answered('reject', 'not on staging'))).toContain('拒绝：not on staging');
  });
});
