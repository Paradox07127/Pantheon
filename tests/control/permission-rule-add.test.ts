import { expect, it } from 'vitest';
import type { AgentEvent, Approval, Principal, Project } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { requestApproval } from '../../packages/control/dist/approvals.js';
import { user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

it('adds a rule once, lists it and answers later requests', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
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
  async (role) => {
    const f = await workbenchFixture();
    const session = await f.create();
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
