import { expect, it } from 'vitest';
import type { AgentProfile, Session, SessionTurn, SignalIssue } from '@pantheon/domain';
import { workbenchFixture } from './workbench-fixture.js';

it('records a runtime finding once across scans and restarts, and groups one rule of one agent across its sessions', async () => {
  const f = await workbenchFixture({ adoptable: true });
  const project = f.project.id;
  const triage = f.store
    .list<AgentProfile>('agents')
    .find((agent) => agent.project_id === project && agent.template === 'triage')!;
  const session = (id: string) =>
    f.store.insert<Session>('sessions', {
      id,
      revision: 1,
      project_id: project,
      runtime: 'fixture',
      state: 'closed',
      turn_count: 1,
      resident: { kind: 'triage', agent_id: triage.id },
    });
  const failTurn = (sessionId: string, turnId: string) => {
    const turn = f.store.insert<SessionTurn>('session_turns', {
      id: turnId,
      revision: 1,
      project_id: project,
      session_id: sessionId,
      state: 'failed',
      input: 'Check the board',
      kind: 'send',
      delivery: 'delivered',
    });
    f.store.event('turn.failed', turn, project, { error: 'Runtime exited with code 1' });
  };
  const findings = () =>
    f.store.list<SignalIssue>('signal_issues').filter((issue) => issue.source === 'trace_findings');

  failTurn(session('triage-first').id, 'first-turn');
  for (let scan = 0; scan < 3; scan++) await f.control.traceScan(150);
  expect(findings()).toHaveLength(1);
  expect(findings()[0]).toMatchObject({ count: 1, state: 'new', priority: 'digest' });
  expect(findings()[0]!.fingerprint).toContain('turn_failure');
  expect(findings()[0]!.fingerprint).toContain(triage.id);

  await f.restart();
  await f.control.traceScan(150);
  expect(findings()).toHaveLength(1);
  expect(findings()[0]!.count).toBe(1);

  failTurn(session('triage-second').id, 'second-turn');
  await f.control.traceScan(150);
  await f.control.traceScan(150);
  expect(findings()).toHaveLength(1);
  expect(findings()[0]!.count).toBe(2);
});
