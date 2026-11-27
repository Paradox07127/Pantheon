import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { Principal, Project, Session, SettingProposal } from '@pantheon/domain';
import { settle, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const proposal = (
  f: Fixture,
  id: string,
  project_id: string,
  state: SettingProposal['state'],
  decided_at?: number,
) =>
  f.store.insert<SettingProposal>('setting_change_proposals', {
    id,
    revision: 1,
    project_id,
    session_id: 'conductor',
    command: 'project.gate.set',
    input: {},
    reason: `Proposal ${id}`,
    before: {},
    state,
    created_at: 0,
    ...(decided_at === undefined ? {} : { decided_at }),
  });

const otherProject = (f: Fixture) => {
  const root = path.join(f.root, 'other');
  mkdirSync(root);
  return f.call<Promise<Project>>('project.open', { name: 'Other', roots: [root] });
};

it("lists only the project's approved proposals, latest approval first", async () => {
  const f = await workbenchFixture();
  const other = await otherProject(f);
  proposal(f, 'older', f.project.id, 'approved', 10);
  proposal(f, 'pending', f.project.id, 'pending');
  proposal(f, 'newer', f.project.id, 'approved', 30);
  proposal(f, 'rejected', f.project.id, 'rejected', 40);
  proposal(f, 'failed', f.project.id, 'failed', 50);
  proposal(f, 'middle', f.project.id, 'approved', 20);
  proposal(f, 'elsewhere', other.id, 'approved', 60);

  const read = f.control.projectSettingProposals(user, f.project.id);

  expect(read.proposals.map((row) => row.id)).toEqual(['newer', 'middle', 'older']);
  expect(read.proposals[0]).toMatchObject({ reason: 'Proposal newer', decided_at: 30 });
  expect(f.control.projectSettingProposals(user, other.id).proposals.map((row) => row.id)).toEqual([
    'elsewhere',
  ]);
});

it('refuses a principal of another project', async () => {
  const f = await workbenchFixture();
  const other = await otherProject(f);
  proposal(f, 'elsewhere', other.id, 'approved', 60);
  const conductor = await f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Plan the export',
    purpose: 'conductor',
  });
  await settle(f, conductor);
  const principal: Principal = {
    id: `session:${conductor.id}`,
    role: 'conductor',
    project_id: f.project.id,
    session_id: conductor.id,
    expires_at: f.store.now() + 60000,
  };

  expect(f.control.projectSettingProposals(principal, f.project.id).proposals).toEqual([]);
  expect(() => f.control.projectSettingProposals(principal, other.id)).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
});
