import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Review, ReviewFinding, Session } from '@pantheon/domain';
import type { SessionGates, WorkbenchSession } from '@pantheon/protocol';
import type { DaemonEvent } from '@/data/sync';
import { sessionScope } from '@/data/workbench-sessions';
import {
  changesText,
  checkItem,
  defaultRuntime,
  findingItem,
  findingState,
  groupWorkbenchSessions,
  mergeBlock,
  pendingPermissions,
  readsDiff,
  reviewFindings,
  sessionRow,
  type PanelTab,
} from '@/screens/sessions/model';
import { ChecksTab, ReviewTab } from '@/screens/sessions/panel';
import { panelOf } from '@/screens/sessions/inspector-model';
import { ResolveButtons } from '@/screens/sessions/parts';
import {
  SessionInspector,
  PermissionCard,
  QuestionRequest,
  RequestSlot,
  SessionCompose,
  SessionHeader,
} from '@/screens/sessions/SessionsScreen';
import { zh } from './i18n-setup.js';

const session = (
  id: string,
  state: WorkbenchSession['state'],
  extra: Partial<WorkbenchSession> = {},
): WorkbenchSession => ({
  id,
  created_at: '2026-01-01T00:00:00.000Z',
  title: `title of ${id}`,
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: `workspace-${id}`,
  workspace_kind: 'linked_worktree',
  state,
  waiting: state === 'waiting' ? 1 : 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-01-01T00:00:00.000Z',
  changes: null,
  merge: null,
  ...extra,
});

let sequence = 0;
const event = (kind: string, aggregate_id: string, payload: unknown = {}): DaemonEvent => ({
  sequence: ++sequence,
  event_id: `event-${sequence}`,
  kind,
  aggregate_id,
  aggregate_revision: sequence,
  project_id: 'project',
  causation_id: '',
  created_at: sequence,
  payload,
});

describe('session list groups', () => {
  it('orders the groups needs you, working, to review, merged', () => {
    const groups = groupWorkbenchSessions([
      session('merged', 'merged'),
      session('ready', 'ready'),
      session('running', 'running'),
      session('waiting', 'waiting'),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['waiting', 'working', 'review', 'merged']);
    expect(groups.map((g) => g.label)).toEqual(
      ['waiting', 'working', 'review', 'merged'].map((key) => zh(`sessions.model.group.${key}`)),
    );
  });

  it('puts each state in its group and keeps the list order within a group', () => {
    const states: WorkbenchSession['state'][] = [
      'starting',
      'running',
      'waiting',
      'idle',
      'ready',
      'failed',
      'merged',
      'discarded',
    ];
    const groups = groupWorkbenchSessions(states.map((state) => session(state, state)));
    const ids = Object.fromEntries(groups.map((g) => [g.key, g.sessions.map((s) => s.id)]));
    expect(ids).toEqual({
      waiting: ['waiting', 'failed'],
      working: ['starting', 'running'],
      review: ['ready'],
      merged: ['merged'],
      ended: ['idle', 'discarded'],
    });
  });

  it('folds the merged, the ended and the archived groups by default', () => {
    const groups = groupWorkbenchSessions([
      session('waiting', 'waiting'),
      session('running', 'running'),
      session('ready', 'ready'),
      session('discarded', 'discarded'),
      session('archived', 'done', { archived_at: '2026-01-01T00:00:00.000Z' }),
    ]);
    expect(groups.map((g) => [g.key, g.folded])).toEqual([
      ['waiting', false],
      ['working', false],
      ['review', false],
      ['ended', true],
      ['archived', true],
    ]);
  });

  it('leaves out empty groups and has none for an empty list', () => {
    expect(groupWorkbenchSessions([])).toEqual([]);
    expect(groupWorkbenchSessions([session('idle', 'idle')]).map((g) => g.key)).toEqual(['ended']);
  });
});

describe('session rows', () => {
  it('shows added and removed lines, or nothing without changes', () => {
    expect(changesText({ files: 3, additions: 42, deletions: 7 })).toBe('+42 −7');
    expect(changesText({ files: 1, additions: 0, deletions: 5 })).toBe('+0 −5');
    expect(changesText({ files: 0, additions: 0, deletions: 0 })).toBe('');
    expect(changesText(null)).toBe('');
  });

  it('carries the title, runtime and change text of the row', () => {
    expect(
      sessionRow(
        session('a', 'ready', {
          runtime: 'codex',
          changes: { files: 2, additions: 12, deletions: 3 },
        }),
      ),
    ).toEqual({ title: 'title of a', runtime: 'codex', changes: '+12 −3' });
  });

  it('names an untitled session by its short id', () => {
    expect(sessionRow(session('session-abcdef123456', 'starting', { title: '' })).title).toMatch(
      /^会话 /,
    );
  });
});

describe('new session runtime', () => {
  it('starts on claude when it is offered, else the first runtime', () => {
    expect(defaultRuntime(['codex', 'claude'])).toBe('claude');
    expect(defaultRuntime(['codex'])).toBe('codex');
    expect(defaultRuntime([])).toBe('claude');
  });
});

describe('pending permissions', () => {
  it('keeps the session permission requests that no later event answered', () => {
    const events = [
      event('approval.requested', 'approval-1', {
        id: 'approval-1',
        kind: 'permission',
        session_id: 'session-a',
        tool: 'Bash',
        state: 'pending',
      }),
      event('approval.requested', 'approval-2', {
        id: 'approval-2',
        kind: 'permission',
        session_id: 'session-a',
        tool: 'WebFetch',
        state: 'pending',
      }),
      event('approval.requested', 'approval-3', {
        id: 'approval-3',
        kind: 'permission',
        session_id: 'session-b',
        tool: 'Edit',
        state: 'pending',
      }),
      event('approval.resolved', 'approval-1', {
        id: 'approval-1',
        kind: 'permission',
        session_id: 'session-a',
        tool: 'Bash',
        state: 'approved',
      }),
    ];
    expect(pendingPermissions(events, 'session-a')).toEqual([
      { id: 'approval-2', tool: 'WebFetch', revision: events[1]!.aggregate_revision },
    ]);
  });

  it('carries the questions of an AskUserQuestion request', () => {
    const questions = [
      {
        question: 'Which package manager?',
        header: 'Tooling',
        options: [
          { label: 'pnpm', description: 'Workspace default' },
          { label: 'npm', description: 'Bundled with node' },
        ],
        multiSelect: false,
        id: 'package-manager',
        other: false,
        secret: false,
        recommended: 'pnpm',
      },
    ];
    const events = [
      event('approval.requested', 'approval-ask', {
        id: 'approval-ask',
        kind: 'permission',
        session_id: 'session-a',
        tool: 'AskUserQuestion',
        state: 'pending',
        questions,
      }),
    ];
    expect(pendingPermissions(events, 'session-a')).toEqual([
      {
        id: 'approval-ask',
        tool: 'AskUserQuestion',
        revision: events[0]!.aggregate_revision,
        questions,
      },
    ]);
  });

  it('carries the rule an allow for the session would add', () => {
    const events = [
      event('approval.requested', 'approval-rule', {
        id: 'approval-rule',
        kind: 'permission',
        session_id: 'session-a',
        tool: 'Bash',
        state: 'pending',
        rule: 'Bash(pnpm test:*)',
      }),
    ];
    expect(pendingPermissions(events, 'session-a')).toEqual([
      {
        id: 'approval-rule',
        tool: 'Bash',
        revision: events[0]!.aggregate_revision,
        rule: 'Bash(pnpm test:*)',
      },
    ]);
  });
});

describe('permission and question cards', () => {
  const needs = { items: [], loading: false, error: null, reload: () => {} };
  const bash = { id: 'approval-1', tool: 'Bash', revision: 1 };
  const rule = 'Bash(pnpm test:*)';
  const card = (props: Partial<Parameters<typeof PermissionCard>[0]>) =>
    renderToStaticMarkup(createElement(PermissionCard, { permission: bash, needs, ...props }));
  const buttons = (html: string) =>
    [...html.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map(([, label]) => label);
  const disabled = (id: string) =>
    new RegExp(`<button[^>]*aria-disabled="true"[^>]*>${zh(id)}</button>`);
  const bound = (binding: object) => ({
    ...needs,
    items: [
      {
        source: { table: 'approvals' as const, id: 'approval-1', revision: 1 },
        kind: 'permission' as const,
        project_id: 'project-a',
        status: 'pending' as const,
        created_at: 1,
        reason: 'permission_requested' as const,
        actions: [{ command: 'approval.respond', allowed: true }],
        binding,
      },
    ],
  });

  it('offers allow once, allow for the session and deny on a permission card', () => {
    const html = card({ permission: { ...bash, rule } });
    expect(buttons(html)).toEqual([
      zh('sessions.card.allowOnce'),
      zh('sessions.card.allowSession'),
      zh('sessions.card.deny'),
    ]);
    expect(html).toContain('class="btn pri"');
    expect(html).not.toContain(zh('sessions.card.denyReason'));
  });

  it('shows the command of the request on the permission card in its thread place, its input folded', () => {
    const command = `rm -rf build && ${'node scripts/step.mjs && '.repeat(20)}echo the-distinct-tail`;
    const html = renderToStaticMarkup(
      createElement(RequestSlot, {
        item: { kind: 'request', id: 'request-1', tool: 'Bash', input: { command }, questions: [] },
        permission: { id: 'approval-1', tool: 'Bash', revision: 1, request: 'request-1' },
        needs,
        folders: [],
        enter: '',
      }),
    );
    expect(html).toContain(zh('sessions.card.runCommand'));
    expect(html).toContain('rm -rf build &amp;&amp; node scripts/step.mjs');
    expect(html).toMatch(
      /<button[^>]*aria-label="输入"[^>]*aria-expanded="false"|<button[^>]*aria-expanded="false"[^>]*aria-label="输入"/,
    );
    expect(html).not.toMatch(disabled('sessions.card.allowOnce'));
  });

  it('shows what an allow for the session lets through when the request has a rule', () => {
    const input = { command: 'pnpm test' };
    expect(card({ permission: { ...bash, rule }, input })).toContain(rule);
    expect(card({ input })).not.toContain('Bash(');
  });

  it('puts the rule from the needs-you binding left of the answer buttons', () => {
    const html = card({
      needs: bound({ action: 'Bash', input_summary: 'command=pnpm test', rule }),
    });
    expect(html).toMatch(/<span[^>]*>Bash\(pnpm test:\*\)<\/span><div[^>]*><button[^>]*>允许一次</);
  });

  it('offers no allow for the session when the request has no rule', () => {
    const input = { command: 'pnpm test' };
    expect(buttons(card({ permission: { ...bash, rule }, input }))).toEqual([
      zh('sessions.card.allowOnce'),
      zh('sessions.card.allowSession'),
      zh('sessions.card.deny'),
    ]);
    expect(buttons(card({ input }))).toEqual([
      zh('sessions.card.allowOnce'),
      zh('sessions.card.deny'),
    ]);
  });

  it('marks a request input the trace cut short', () => {
    expect(card({ input: { command: 'cat big.log', truncated: true } })).toContain(
      zh('sessions.parts.truncated'),
    );
    expect(card({ input: { command: 'cat big.log' } })).not.toContain(
      zh('sessions.parts.truncated'),
    );
  });

  it('marks a needs-you summary cut at its length limit', () => {
    const summary = (input_summary: string) =>
      card({ needs: bound({ action: 'Bash', input_summary }) });
    expect(summary(`command=${'x'.repeat(291)}…`)).toContain(zh('sessions.parts.truncated'));
    expect(summary('command=ls…')).not.toContain(zh('sessions.parts.truncated'));
    expect(summary('command=ls')).not.toContain(zh('sessions.parts.truncated'));
  });

  it('keeps approval off while nothing identifies what the request would run', () => {
    const html = card({ permission: { ...bash, rule } });
    expect(html).toMatch(disabled('sessions.card.allowOnce'));
    expect(html).toMatch(disabled('sessions.card.allowSession'));
    expect(html).not.toMatch(disabled('sessions.card.deny'));
  });

  it('shows the questions, options and a free answer field and waits for every answer', () => {
    const html = renderToStaticMarkup(
      createElement(QuestionRequest, {
        permission: {
          id: 'approval-ask',
          tool: 'AskUserQuestion',
          revision: 1,
          questions: [
            {
              question: 'Which package manager?',
              header: 'Tooling',
              options: [
                { label: 'pnpm', description: 'Workspace default' },
                { label: 'npm', description: 'Bundled with node' },
              ],
              multiSelect: false,
            },
            {
              question: 'Which checks?',
              header: 'Checks',
              options: [
                { label: 'lint', description: 'Style' },
                { label: 'test', description: 'Behaviour' },
              ],
              multiSelect: true,
            },
          ],
        },
        needs,
      }),
    );
    expect(html).toContain('Which package manager?');
    expect(html).toContain('Which checks?');
    for (const label of ['pnpm', 'npm', 'lint', 'test']) expect(html).toContain(`>${label}<`);
    expect(html.match(/aria-label="其他回答"/g)).toHaveLength(2);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>发送<\/button>/);
    expect(html).toMatch(/<button type="button" class="btn ghost">拒绝<\/button>/);
  });

  it.each([
    [
      [{ command: 'session.resolve', allowed: true }],
      [zh('sessions.parts.resumeSession'), zh('sessions.parts.closeSession')],
    ],
    [
      [
        { command: 'session.resolve', allowed: false, disabled_reason: 'termination_unconfirmed' },
        { command: 'session.discard', allowed: true },
      ],
      [
        zh('sessions.parts.resumeSession'),
        zh('sessions.parts.closeSession'),
        zh('sessions.parts.discardChanges'),
      ],
    ],
  ])(
    'offers resume and close for a reconciling session, and discard when allowed',
    (actions, labels) => {
      const html = renderToStaticMarkup(
        createElement(ResolveButtons, {
          item: {
            source: { table: 'sessions', id: 'session-a', revision: 4 },
            kind: 'session.reconciling',
            project_id: 'project-a',
            status: 'reconciling',
            created_at: 1,
            reason: 'reconciliation_required',
            actions,
          },
          title: 'Release notes',
        }),
      );
      expect(
        [...html.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map(([, label]) => label),
      ).toEqual(labels);
    },
  );
});

describe('merge blocks', () => {
  it('lists a merging session with the working ones, before the sessions ready to merge', () => {
    const groups = groupWorkbenchSessions([session('a', 'merging'), session('b', 'ready')]);
    expect(groups.map((group) => [group.key, group.sessions.map((entry) => entry.id)])).toEqual([
      ['working', ['a']],
      ['review', ['b']],
    ]);
  });
  it.each([
    [
      'names the conflicting files and asks the session to rebase',
      { reason: 'rebase_conflict', conflicts: ['a.ts', 'b.ts'] },
      '和源分支冲突：a.ts、b.ts',
      expect.stringContaining('a.ts, b.ts'),
    ],
    [
      'sends the failed gate output back to the session',
      { reason: 'gate_failed', gate: { name: 'Unit tests', output: '1 failed' } },
      '门禁「Unit tests」失败',
      expect.stringContaining('1 failed'),
    ],
    [
      'names a dependency folder the gate skipped',
      { reason: 'dependency_folder_skipped' },
      zh('sessions.model.mergeBlock.dependencySkipped'),
      null,
    ],
  ])('%s', (_name, block, text, request) => {
    expect(mergeBlock({ state: 'blocked', ...block } as never)).toEqual({ text, request });
  });
  it('names in words a block reason it has no text of its own for', () => {
    expect(mergeBlock({ state: 'blocked', reason: 'task_retired' })?.text).toBe(
      zh('data.reason.taskRetired'),
    );
    expect(mergeBlock({ state: 'blocked', reason: 'out_of_scope' })?.text).toBe(
      zh('data.reason.outOfScope'),
    );
    expect(mergeBlock({ state: 'blocked', reason: 'git_failed: index locked' })?.text).toBe(
      'git 失败：index locked',
    );
    expect(mergeBlock({ state: 'blocked' })?.text).toBe(zh('sessions.model.mergeBlock.blocked'));
  });
  it('offers no request for a block the session cannot fix', () => {
    expect(mergeBlock({ state: 'blocked', reason: 'local_changes' })).toEqual({
      text: zh('sessions.model.mergeBlock.localChanges'),
      request: null,
    });
    expect(mergeBlock({ state: 'running' })).toBeNull();
    expect(mergeBlock(null)).toBeNull();
  });
});

describe('session header', () => {
  it.each(['open', 'closed'] as const)('offers a clickable title for an %s session', (state) => {
    const html = renderToStaticMarkup(
      createElement(SessionHeader, {
        session: {
          id: 'session-a',
          revision: 2,
          project_id: 'project-a',
          runtime: 'claude',
          state,
          turn_count: 1,
          workspace_id: 'workspace-a',
        },
        listed: null,
        title: 'Release notes',
        panels: ['changes'],
        onPanel: () => {},
        overview: true,
      }),
    );
    expect(html).toContain('<header');
    expect(html).toMatch(
      /<button[^>]*aria-label="修改会话标题"[^>]*><span[^>]*data-clip[^>]*>Release notes<\/span><\/button>/,
    );
    expect(html).not.toMatch(/<button[^>]*aria-label="修改会话标题"[^>]*disabled/);
    expect(html).not.toContain('<input');
  });
});

const compose = (open: Session, listed: WorkbenchSession) =>
  renderToStaticMarkup(
    createElement(SessionCompose, { session: open, listed, title: 'title of a' }),
  );

describe('composer permission mode', () => {
  const open: Session = {
    id: 'a',
    revision: 2,
    project_id: 'project-a',
    runtime: 'claude',
    state: 'open',
    turn_count: 1,
  };
  it("names a claude session's permission mode on its model button, which it can open", () => {
    const html = compose(open, session('a', 'idle', { permission_mode: 'plan' }));
    expect(modelButton(html)).toMatch(/aria-label="模型：[^"]*计划"/);
    expect(modelButton(html)).not.toMatch(/ disabled/);
  });

  it("names a codex session's permission mode on its model button", () => {
    const html = compose(
      { ...open, runtime: 'codex' },
      session('a', 'idle', { runtime: 'codex', permission_mode: 'auto_edit' }),
    );
    expect(modelButton(html)).toMatch(/aria-label="模型：[^"]*工作区可写"/);
  });
});

/** The opening tag of the composer's model button. */
const modelButton = (html: string) => html.match(/<button[^>]*class="cp-mdl"[^>]*>/)?.[0] ?? '';

describe('ended sessions', () => {
  const closed: Session = {
    id: 'a',
    revision: 3,
    project_id: 'project-a',
    runtime: 'fixture',
    state: 'closed',
    turn_count: 1,
  };

  it('names the end in the composer instead of offering to steer', () => {
    const html = compose(closed, session('a', 'merged'));
    expect(html).toContain(`placeholder="${zh('sessions.model.ended.merged')}"`);
    expect(html).not.toContain(zh('sessions.composer.steer'));
  });

  it('disables the model button, which holds the permission mode, of an ended session', () => {
    const html = compose(closed, session('a', 'discarded'));
    expect(modelButton(html)).toMatch(/ disabled=""/);
  });

  const changes = (state: WorkbenchSession['state']) =>
    renderToStaticMarkup(
      createElement(SessionInspector, {
        sessionId: 'a',
        listed: session('a', state),
        session: closed,
        panels: ['changes'],
        onOpen: () => {},
        onClose: () => {},
        onView: () => {},
      }),
    );

  it('shows the end in the changes panel instead of reading the removed worktree', () => {
    const html = changes('discarded');
    expect(html).toContain(zh('sessions.model.ended.discarded'));
    expect(html).not.toContain('aria-busy');
  });

  it('reads the diff of a merged session in the changes panel instead of naming the end', () => {
    const html = changes('merged');
    expect(html).toContain(zh('components.diff.loading'));
    expect(html.slice(html.indexOf('<div class="ss-pbody"'))).not.toContain(
      zh('sessions.model.ended.merged'),
    );
    expect(html).not.toContain(zh('sessions.parts.discard'));
    expect(html).not.toContain('合并</button>');
  });
});

describe('changes panel tabs', () => {
  const open: Session = {
    id: 'a',
    revision: 2,
    project_id: 'project-a',
    runtime: 'claude',
    state: 'open',
    turn_count: 1,
  };
  const panel = (listed: WorkbenchSession, tab: Exclude<PanelTab, 'run'>) =>
    renderToStaticMarkup(
      createElement(SessionInspector, {
        sessionId: 'a',
        listed,
        session: { ...open, runtime: listed.runtime },
        panels: [panelOf(tab)!.panel],
        view: panelOf(tab)!.view ?? 'diff',
        onOpen: () => {},
        onClose: () => {},
        onView: () => {},
      }),
    );
  const finding = (id: string, extra: Partial<ReviewFinding> = {}): ReviewFinding => ({
    id,
    review_id: 'review',
    runtime: 'codex',
    round: 1,
    location: 'src/answer.ts:12',
    quote: 'return 1',
    evidence: 'The caller expects two',
    impact: `Returns the wrong answer ${id}`,
    status: 'open',
    blocking: false,
    ...extra,
  });
  const read = <T>(data: T) => ({ data, error: null, reload: () => {} });
  const review = (id: string, findings: ReviewFinding[]): Review => ({
    id,
    revision: 1,
    project_id: 'project-a',
    session_id: 'a',
    round: 1,
    runtimes: ['codex'],
    state: 'completed',
    session_ids: [],
    findings,
  });
  const reviewTab = (findings: ReviewFinding[]) =>
    renderToStaticMarkup(
      createElement(ReviewTab, {
        sessionId: 'a',
        runtime: 'claude',
        reviews: read([review('review', findings)]),
        files: null,
        readOnly: false,
        attached: new Set<string>(),
        onAttach: () => {},
      }),
    );

  it('shows only the column of the open panel, headed by its name', () => {
    const html = panel(session('a', 'ready'), 'checks');
    expect(
      [...html.matchAll(/<section[^>]*aria-label="([^"]+)"/g)].map(([, label]) => label),
    ).toEqual([zh('sessions.screen.tabChecks')]);
    expect(html).toMatch(/class="ss-colt">检查</);
  });

  it('asks the other vendor to review a claude session', () => {
    expect(panel(session('a', 'ready'), 'review')).toContain('请 Codex 审查</button>');
    expect(panel(session('a', 'ready', { runtime: 'codex' }), 'review')).toContain(
      '请 Claude 审查</button>',
    );
  });

  it('shows no review request or fix button for an ended session', () => {
    const html = panel(session('a', 'merged'), 'review');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toMatch(/请 \S+ 审查/);
    expect(html).not.toContain('让它修');
  });

  it('asks for a fix of a finding in the item it attaches', () => {
    const html = panel(session('a', 'ready'), 'review');
    expect(html.slice(html.indexOf('class="ss-pf"'))).not.toContain('让它修');
    expect(findingItem(finding('one'))).toEqual({
      id: 'finding:one',
      kind: 'finding',
      label: 'src/answer.ts:12',
      text: 'Please fix this review finding: Returns the wrong answer one (src/answer.ts:12)\n\nQuote:\nreturn 1\n\nEvidence:\nThe caller expects two',
    });
  });

  it('sends the reproduction of a finding along with its quote and evidence', () => {
    expect(findingItem(finding('one', { reproduction: 'node answer.js # prints 1' })).text).toBe(
      'Please fix this review finding: Returns the wrong answer one (src/answer.ts:12)\n\nQuote:\nreturn 1\n\nEvidence:\nThe caller expects two\n\nReproduction:\nnode answer.js # prints 1',
    );
    expect(findingItem(finding('one', { reproduction: { steps: ['run'] } })).text).toContain(
      'Reproduction:\n{\n  "steps": [\n    "run"\n  ]\n}',
    );
  });

  it('names a stale finding apart from one not handled yet', () => {
    expect(findingState(finding('one'))).toBe(zh('sessions.model.finding.open'));
    expect(findingState(finding('one', { status: 'stale' }))).toBe(
      zh('sessions.model.finding.stale'),
    );
  });

  it('lists the findings of the newest review first', () => {
    const older = review('older', [finding('first')]);
    const newer = review('newer', [finding('second'), finding('third')]);
    expect(reviewFindings([older, newer]).map((f) => f.id)).toEqual(['second', 'third', 'first']);
  });

  it('lets each open finding be attached and leaves resolved ones as they are', () => {
    const html = reviewTab([
      finding('open', { blocking: true }),
      finding('adopted', {
        resolution: { outcome: 'adopted', resolved_at: 1, resolved_by: 'user' },
      }),
      finding('invalid', { status: 'rejected' }),
    ]);
    expect(html).toContain(zh('sessions.panel.review.blocking'));
    expect(html).toContain('src/answer.ts:12');
    expect(html).toContain(zh('sessions.model.finding.adopted'));
    expect(html).not.toContain('Returns the wrong answer invalid');
    expect(html).not.toContain('type="checkbox"');
    expect(html.match(/>附加</g)).toHaveLength(1);
  });

  it('shows the quote and evidence of a finding', () => {
    const html = reviewTab([finding('quoted')]);
    expect(html).toContain('return 1');
    expect(html).toContain('The caller expects two');
  });

  it('gives commands of the same name their own feedback item', () => {
    const result = (name: string) => ({
      name,
      exit_code: 1,
      timed_out: false,
      output_tail: `${name} failed`,
    });
    const first = checkItem(result('test'), 1000, 0);
    const second = checkItem(result('test'), 1000, 1);
    expect(first.id).not.toBe(second.id);
    expect(checkItem(result('test'), 1000, 0).id).toBe(first.id);
  });

  const checks = (gates: SessionGates, readOnly = false) =>
    renderToStaticMarkup(
      createElement(ChecksTab, {
        gates: read(gates),
        readOnly,
        merging: false,
        busy: false,
        attached: new Set<string>(),
        onAttach: () => {},
        onRun: () => {},
        onSettings: () => {},
      }),
    );

  it('points to the settings when the project has no gate commands', () => {
    const none = { configured: false, running: false, last: null };
    expect(checks(none)).toContain(zh('sessions.panel.checks.noGates'));
    expect(checks(none)).toContain(`${zh('sessions.panel.checks.openSettings')}</button>`);
    expect(checks(none, true)).not.toContain(zh('sessions.panel.checks.openSettings'));
  });

  it('lists the newest gate result and folds the output of a failed command', () => {
    const gates: SessionGates = {
      configured: true,
      running: false,
      last: {
        commit: 'abcdef1234567890',
        checked_at: Date.now(),
        results: [
          { name: 'Lint', exit_code: 0, timed_out: false, output_tail: '' },
          { name: 'Unit tests', exit_code: 1, timed_out: false, output_tail: '1 failed' },
        ],
      },
    };
    const html = checks(gates);
    expect(html).toContain('aria-label="通过"');
    expect(html).toContain('aria-label="失败"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('1 failed');
    expect(html).toContain('>重跑</button>');
    expect(checks({ ...gates, running: true })).toMatch(/<button[^>]*disabled=""[^>]*>运行中</);
  });
});

describe('baseline sessions', () => {
  const baseline = session('b', 'done', { title: '摸底', workspace_id: null });
  const open: Session = {
    id: 'b',
    revision: 2,
    project_id: 'project-a',
    runtime: 'claude',
    state: 'open',
    turn_count: 1,
    baseline: { baseline_id: 'baseline-a' },
  };

  it('puts a finished baseline session with the ended sessions', () => {
    expect(groupWorkbenchSessions([baseline]).map((g) => g.key)).toEqual(['ended']);
  });

  it('names the finish in the composer and offers no permission mode', () => {
    const html = renderToStaticMarkup(
      createElement(SessionCompose, { session: open, listed: baseline, title: '摸底' }),
    );
    expect(html).toContain(`placeholder="${zh('sessions.model.ended.done')}"`);
    expect(html).not.toContain(zh('sessions.composer.permissionMode'));
  });

  it('reads the list again after an event of a baseline session the list does not name yet', () => {
    const board = { sessions: [open], session_turns: [] };
    expect(sessionScope(event('turn.started', 'b'), [], board)).toEqual(['b']);
  });

  it('reads the list again after an event of a resident session the list does not name yet', () => {
    const resident: Session = {
      ...open,
      id: 'r',
      baseline: undefined,
      resident: { kind: 'assistant' },
    };
    const board = { sessions: [resident], session_turns: [] };
    expect(sessionScope(event('turn.started', 'r'), [], board)).toEqual(['r']);
  });
});

describe('reading the worktree changes', () => {
  const listed = (state: WorkbenchSession['state']) => ({ state }) as WorkbenchSession;

  it('waits until the worktree exists and stops once it is removed', () => {
    expect(readsDiff(listed('starting'))).toBe(false);
    expect(readsDiff(listed('discarded'))).toBe(false);
    expect(readsDiff(listed('running'))).toBe(true);
    expect(readsDiff(listed('merged'))).toBe(true);
    expect(readsDiff(null)).toBe(false);
  });
});
