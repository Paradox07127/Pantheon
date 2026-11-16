import { expect, it } from 'vitest';
import type { AgentEvent, Approval, Principal, Project } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { requestApproval } from '../../packages/control/dist/approvals.js';
import { improvementSignals } from '../../packages/control/dist/improvement-signals.js';
import { user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

it('adds a rule from a finding once, lists it, suppresses the finding and answers later requests', () => {
  const f = workbenchFixture();
  const session = f.create();
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const request = (request_id: string) => {
    const event: Extract<AgentEvent, { kind: 'permission.requested' }> = {
      key: request_id,
      provider_sequence: 1,
      kind: 'permission.requested',
      request_id,
      tool: 'Bash',
      rule: 'Bash(pnpm test)',
      project_rule_supported: true,
      detail: { input: { command: 'pnpm test --filter control' } },
    };
    f.store.transaction(() => {
      f.store.event('agent.permission.requested', session, f.project.id, event);
      requestApproval(ctx, session, event);
    });
    return f.store.list<Approval>('approvals').at(-1)!;
  };
  for (let index = 0; index < 5; index++) {
    const approval = request(`approved-${index}`);
    f.call(
      'approval.respond',
      { approval_id: approval.id, decision: 'approve' },
      approval.revision,
    );
  }
  expect(
    improvementSignals(ctx, f.project.id).find(
      (finding) => finding.signal === 'always_approved_command',
    )?.evidence,
  ).toEqual({
    kind: 'always_approved_command',
    command: 'pnpm test --filter control',
    approvals: 5,
    rule: 'Bash(pnpm test)',
    session_id: session.id,
  });
  const input = { project_id: f.project.id, rule: 'Bash(pnpm test)', session_id: session.id };
  const project = f.call<Project>('permission.rule.add', input);
  expect(project.permission_rules).toEqual([
    { rule: input.rule, session_id: session.id, added_at: expect.any(Number) },
  ]);
  expect(f.call('permission.rule.add', input)).toEqual(project);
  expect(f.control.permissionRules(user, f.project.id)).toEqual([
    { ...project.permission_rules![0], session_title: session.title },
  ]);
  const events = f.store.kindEvents(f.project.id, ['project.rule_allowed']);
  expect(events).toHaveLength(1);
  expect(events[0]!.payload).toEqual(project.permission_rules![0]);
  expect(
    improvementSignals(ctx, f.project.id).filter(
      (finding) => finding.signal === 'always_approved_command',
    ),
  ).toEqual([]);
  const automatic = request('after-rule');
  expect(automatic).toMatchObject({ state: 'approved', answered_by_rule: input.rule });
  expect(f.control.needsYou(user).items.some((item) => item.source.id === automatic.id)).toBe(
    false,
  );
  expect(
    f.store
      .pending()
      .filter((job) => job.kind === 'permission.answer')
      .map((job) => JSON.parse(job.payload)),
  ).toContainEqual(expect.objectContaining({ approval_id: automatic.id, decision: 'allow' }));
});

it.each(['lead', 'worker'] as const)(
  'refuses a %s session adding a project permission rule',
  (role) => {
    const f = workbenchFixture();
    const session = f.create();
    const principal: Principal = {
      id: `session:${session.id}`,
      role,
      project_id: f.project.id,
      session_id: session.id,
      expires_at: f.store.now() + 60000,
    };
    expect(() =>
      f.call(
        'permission.rule.add',
        { project_id: f.project.id, rule: 'Bash(pnpm test)', session_id: session.id },
        null,
        principal,
      ),
    ).toThrow();
    expect(f.store.must<Project>('projects', f.project.id).permission_rules).toBeUndefined();
    expect(f.store.kindEvents(f.project.id, ['project.rule_allowed'])).toEqual([]);
  },
);
