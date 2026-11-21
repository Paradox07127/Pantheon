import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { workbenchFixture } from './workbench-fixture.js';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { MEMORY_INSTRUCTIONS, syncMemoryFiles } from '../../packages/control/src/memory.js';

/** A project setup session, whose planner tools include memory and which project memory is delivered to. */
const withTools = (f: Awaited<ReturnType<typeof workbenchFixture>>) =>
  f.call<Promise<import('@pantheon/domain').Session>>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Rename the answer file and explain why',
    purpose: 'project_setup',
  });

it('replaces decisions atomically, hides archived ids and dependent reports, and restores only as a proposal', async () => {
  const f = await workbenchFixture();
  const propose = (key: string, text: string, dependencies: string[] = []) =>
    f.call<any>('memory.propose', {
      project_id: f.project.id,
      key,
      text,
      kind: dependencies.length ? 'report' : 'decision',
      dependencies,
    });
  const commit = (r: any) => f.call<any>('memory.commit', { memory_id: r.id }, r.revision);
  const a = commit(propose('database', 'Use old-engine-unique'));
  const report = commit(propose('analysis', 'Analysis depends on the old engine', [a.id]));
  const b = commit(propose('database', 'Use SQLite'));
  expect(
    f.call<any>('memory.search', { project_id: f.project.id, q: 'old-engine-unique' }).items,
  ).toEqual([]);
  expect(() => f.call('memory.get', { memory_id: a.id })).toThrow();
  expect(() => f.call('memory.get', { memory_id: report.id })).toThrow();
  expect(f.call<any>('memory.get', { memory_id: b.id }).text).toBe('Use SQLite');
  const restored = f.call<any>(
    'memory.restore',
    { memory_id: a.id },
    f.store.must<any>('memory_records', a.id).revision,
  );
  expect(restored.state).toBe('draft');
  expect(
    f.call<any>('memory.context', { project_id: f.project.id }).items.map((x: any) => x.text),
  ).toEqual(['Use SQLite']);
});

it('delivers current scoped memory to the actual adapter on every send', async () => {
  const f = await workbenchFixture({ delay: 10 });
  const send = vi.spyOn(f.adapter, 'send');
  const draft = f.call<any>('memory.propose', {
    project_id: f.project.id,
    key: 'language',
    kind: 'decision',
    text: 'Use precise terminology',
  });
  f.call('memory.commit', { memory_id: draft.id }, draft.revision);
  const session = await withTools(f);
  await f.control.tick();
  await eventually(
    () => send.mock.calls.length > 0,
    () => f.control.tick(),
  );
  expect(JSON.stringify(send.mock.calls)).toContain('Use precise terminology');
  const marker = '[Pantheon current project memory]\n',
    input = send.mock.calls[0]![1].input as string,
    packet = JSON.parse(input.slice(input.indexOf(marker) + marker.length).split('\n\n')[0]!);
  // The system prompt carries the memory instructions; the packet only the entries.
  expect(packet).not.toHaveProperty('instructions');
  expect(input).not.toContain(MEMORY_INSTRUCTIONS);
  const system = f.start.mock.calls.find(([spec]) => spec.platform_session_id === session.id)![0]
    .control_instructions!;
  expect(system.split(MEMORY_INSTRUCTIONS)).toHaveLength(2);
  await eventually(
    () => !!f.store.must<any>('sessions', session.id).memory_delivery?.delivered_signature,
  );
});

it('never replays a cached current-read receipt after a decision is replaced', async () => {
  const { command } = await import('@pantheon/protocol');
  const f = await workbenchFixture();
  const draft = f.call<any>('memory.propose', {
    project_id: f.project.id,
    key: 'db',
    kind: 'decision',
    text: 'old cached text',
  });
  const active = f.call<any>('memory.commit', { memory_id: draft.id }, draft.revision);
  const read = command(user.id, 'memory.get', { memory_id: active.id });
  expect((f.control.execute(user, read) as any).text).toContain('old cached');
  f.call('memory.archive', { memory_id: active.id }, active.revision);
  expect(() => f.control.execute(user, read)).toThrow();
});

it('rejects stale proposals and concurrent commits without overwriting the current choice', async () => {
  const f = await workbenchFixture();
  const propose = (text: string) =>
    f.call<any>('memory.propose', { project_id: f.project.id, key: 'db', kind: 'decision', text });
  const a = propose('first'),
    b = propose('second');
  f.call('memory.commit', { memory_id: a.id }, a.revision);
  expect(() => f.call('memory.commit', { memory_id: b.id }, b.revision)).toThrowError(
    expect.objectContaining({ code: 'revision_conflict' }),
  );
  expect(
    f.call<any>('memory.context', { project_id: f.project.id }).items.map((r: any) => r.text),
  ).toEqual(['first']);
});

it('reads the named records of a key past its newest fifty', async () => {
  const f = await workbenchFixture();
  const ids = Array.from({ length: 51 }, (_, n) => {
    const r = f.call<any>('memory.propose', {
      project_id: f.project.id,
      key: 'handoff/agent-triage',
      kind: 'note',
      text: `handoff ${n}`,
    });
    f.call('memory.commit', { memory_id: r.id }, r.revision);
    return r.id as string;
  });
  const items = f.call<any>('memory.history', {
    project_id: f.project.id,
    key: 'handoff/agent-triage',
    ids: [ids[0]],
  }).items;
  expect(items.map((r: any) => r.id)).toEqual([ids[0]]);
});

it('expires memory at read time without relying on a scheduler and retains immutable history', async () => {
  const { fixture } = await import('../helpers.js');
  let now = 1000;
  const f = await fixture({ now: () => now });
  try {
    const r = f.call<any>('memory.propose', {
      project_id: f.project.id,
      key: 'temporary',
      kind: 'note',
      text: 'temporary-unique',
      expires_at: 2000,
    });
    f.call('memory.commit', { memory_id: r.id }, r.revision);
    now = 2001;
    expect(
      f.call<any>('memory.search', { project_id: f.project.id, q: 'temporary-unique' }).items,
    ).toEqual([]);
    expect(() => f.call('memory.get', { memory_id: r.id })).toThrow();
    expect(f.control.memoryRead(user, f.project.id).records).toEqual([]);
    expect(() =>
      f.control.memoryGraph(user, { project_id: f.project.id, memory_id: r.id }),
    ).toThrow();
    expect(() => f.call('memory.related', { project_id: f.project.id, memory_id: r.id })).toThrow();
    expect(f.control.memoryRead(user, f.project.id, { state: 'archived' }).records[0]?.reason).toBe(
      'expired',
    );
    await f.control.tick();
    expect(f.store.must<any>('memory_records', r.id).reason).toBe('expired');
    expect(f.call<any>('memory.history', { project_id: f.project.id }).items[0].text).toBe(
      'temporary-unique',
    );
  } finally {
    await f.close();
  }
});

it('makes an agent report current at once, keeps its decisions as drafts, and prevents cross-project or task reads', async () => {
  const f = await workbenchFixture();
  const s = await withTools(f);
  const p = {
    id: 'agent',
    role: 'planner' as const,
    session_id: s.id,
    project_id: f.project.id,
    expires_at: Date.now() + 60000,
  };
  const propose = (key: string, kind: string, text: string) =>
    f.call<any>(
      'memory.propose',
      {
        project_id: f.project.id,
        key,
        kind,
        text,
        based_on: f.call<any>('memory.context', { project_id: f.project.id }, null, p).signature,
      },
      null,
      p,
    );
  const report = propose('tests', 'report', 'All tests passed (an unverified claim)');
  expect(report).toMatchObject({ state: 'active', authority: 'agent_reported' });
  const decision = propose('db', 'decision', 'Use SQLite');
  expect(decision.state).toBe('draft');
  expect(
    f.call<any>('memory.context', { project_id: f.project.id }).items.map((i: any) => i.id),
  ).toEqual([report.id]);
  expect(() => f.call('memory.commit', { memory_id: decision.id }, decision.revision, p)).toThrow();
  expect(() => f.call('memory.history', { project_id: f.project.id }, null, p)).toThrow();
  expect(() => f.call('memory.context', { project_id: 'other-project' }, null, p)).toThrow();
});

it('maintains current documents, rejects late jobs, and does not advance the source epoch when publishing', async () => {
  const f = await workbenchFixture();
  const save = (text: string) => {
    const r = f.call<any>('memory.propose', {
      project_id: f.project.id,
      key: 'db',
      kind: 'decision',
      text,
    });
    return f.call<any>('memory.commit', { memory_id: r.id }, r.revision);
  };
  save('old choice');
  let replaced = false;
  const failpoint = vi
    .spyOn((f.control as any).ctx, 'failpoint')
    .mockImplementation((name: unknown) => {
      if (name === 'memory_before_publish' && !replaced) {
        replaced = true;
        save('new choice');
      }
    });
  await f.control.tick();
  expect(f.store.list<any>('memory_jobs').some((j) => j.state === 'obsolete')).toBe(true);
  failpoint.mockRestore();
  await f.control.tick();
  const read = f.control.memoryRead(user, f.project.id);
  expect(f.control.memoryDocument(user, f.project.id).text).toContain('new choice');
  expect(f.control.memoryDocument(user, f.project.id).text).not.toContain('old choice');
  const epoch = read.epoch,
    jobs = f.store.list('memory_jobs').length;
  await f.control.tick();
  expect(f.control.memoryRead(user, f.project.id).epoch).toBe(epoch);
  expect(f.store.list('memory_jobs')).toHaveLength(jobs);
});

it('does not mistake a delayed delivery receipt for acknowledgement of a newer decision', async () => {
  const f = await workbenchFixture({ delay: 10 });
  const save = (text: string) => {
    const r = f.call<any>('memory.propose', {
      project_id: f.project.id,
      key: 'db',
      kind: 'decision',
      text,
    });
    return f.call<any>('memory.commit', { memory_id: r.id }, r.revision);
  };
  save('first');
  const actual = f.adapter.send.bind(f.adapter);
  vi.spyOn(f.adapter, 'send').mockImplementation(async (handle, input) => {
    save('changed during send');
    return actual(handle, input);
  });
  const s = await withTools(f);
  await eventually(
    () => !!f.store.must<any>('sessions', s.id).memory_delivery?.delivered_signature,
    () => f.control.tick(),
  );
  const read = f.control.memoryRead(user, f.project.id);
  expect(read.sessions.find((x) => x.id === s.id)?.delivered).toBe(false);
});

it('rolls back an interrupted commit and reclaims an abandoned maintenance lease after restart', async () => {
  const f = await workbenchFixture();
  const r = f.call<any>('memory.propose', {
    project_id: f.project.id,
    key: 'db',
    kind: 'decision',
    text: 'durable choice',
  });
  const failpoint = vi.spyOn(f.control, 'failpoint').mockImplementation((name) => {
    if (name === 'before_transaction_commit') throw new Error('simulated crash');
  });
  expect(() => f.call('memory.commit', { memory_id: r.id }, r.revision)).toThrow('simulated crash');
  expect(f.store.must<any>('memory_records', r.id).state).toBe('draft');
  expect(f.store.list('memory_jobs')).toEqual([]);
  failpoint.mockRestore();
  f.call('memory.commit', { memory_id: r.id }, r.revision);
  const job = f.store.list<any>('memory_jobs')[0];
  f.store.update(
    'memory_jobs',
    { ...job, state: 'running', lease_until: Date.now() - 1 },
    job.revision,
  );
  await f.restart();
  await f.control.tick();
  expect(f.control.memoryDocument(user, f.project.id).text).toContain('durable choice');
});

it('rejects a decision commit over budget with the largest records and rolls back replacements', async () => {
  const f = await workbenchFixture();
  const save = (key: string, text: string, kind = 'decision') => {
    const draft = f.call<any>('memory.propose', {
      project_id: f.project.id,
      key,
      title: key,
      kind,
      text,
    });
    return f.call<any>('memory.commit', { memory_id: draft.id }, draft.revision);
  };
  save('optional-evidence', 'Large optional evidence '.repeat(700), 'note');
  const decisions = Array.from({ length: 6 }, (_, index) =>
    save('rule-' + index, 'Confirmed rule '.repeat(30 + index)),
  );
  const draft = f.call<any>('memory.propose', {
    project_id: f.project.id,
    key: decisions[0].key,
    title: 'Large replacement',
    kind: 'decision',
    text: '多字节 "rule"\n'.repeat(600),
  });
  const candidate = {
    ...draft,
    revision: draft.revision + 1,
    state: 'active',
    committed_at: f.store.now(),
  };
  vi.spyOn(f.store, 'now').mockReturnValue(candidate.committed_at);
  const counted = [...decisions.slice(1), candidate].map((record) => ({
    id: record.id,
    title: record.title,
    bytes: Buffer.byteLength(JSON.stringify(record)),
  }));
  const before = f.control.memoryRead(user, f.project.id);
  const events = f.store.events(0, f.project.id);
  expect(() => f.call('memory.commit', { memory_id: draft.id }, draft.revision)).toThrowError(
    expect.objectContaining({
      code: 'memory_budget_exceeded',
      details: {
        used_bytes: counted.reduce((sum, record) => sum + record.bytes, 0),
        limit_bytes: 12000,
        largest_records: counted.sort((a, b) => b.bytes - a.bytes).slice(0, 5),
      },
    }),
  );
  expect(f.store.must<any>('memory_records', draft.id).state).toBe('draft');
  expect(f.store.must<any>('memory_records', decisions[0].id).state).toBe('active');
  expect(f.control.memoryRead(user, f.project.id).signature).toBe(before.signature);
  expect(f.store.events(0, f.project.id)).toEqual(events);
});

it('commits decisions within budget and measures replacements without their superseded versions', async () => {
  const f = await workbenchFixture();
  for (const text of ['Original '.repeat(700), 'Replacement '.repeat(700)]) {
    const draft = f.call<any>('memory.propose', {
      project_id: f.project.id,
      key: 'rule',
      kind: 'decision',
      text,
    });
    const committed = f.call<any>('memory.commit', { memory_id: draft.id }, draft.revision);
    const context = f.call<any>('memory.context', { project_id: f.project.id });
    expect(context.items).toEqual([committed]);
    expect(context.bytes).toBe(Buffer.byteLength(JSON.stringify(committed)));
    expect(context.bytes).toBeLessThanOrEqual(12000);
  }
});

it('bounds maintenance retries and supports an explicit local retry without model calls', async () => {
  const { fixture } = await import('../helpers.js');
  let now = 1000,
    fail = true;
  const f = await fixture({
    now: () => now,
    failpoint: (name) => {
      if (fail && name === 'memory_before_projection') throw new Error('storage unavailable');
    },
  });
  try {
    const r = f.call<any>('memory.propose', {
      project_id: f.project.id,
      key: 'rule',
      kind: 'decision',
      text: 'Keep evidence',
    });
    f.call('memory.commit', { memory_id: r.id }, r.revision);
    for (let i = 0; i < 4; i++) {
      await f.control.tick();
      now += 20000;
    }
    expect(f.store.list<any>('memory_jobs')).toMatchObject([{ state: 'failed', attempts: 3 }]);
    fail = false;
    f.call('memory.maintain', { project_id: f.project.id });
    await f.control.tick();
    expect(f.control.memoryDocument(user, f.project.id).text).toContain('Keep evidence');
  } finally {
    await f.close();
  }
});

it('rejects a replacement that would archive its own dependency', async () => {
  const f = await workbenchFixture();
  const a = f.call<any>('memory.propose', {
    project_id: f.project.id,
    key: 'report',
    kind: 'report',
    text: 'Original analysis',
  });
  f.call('memory.commit', { memory_id: a.id }, a.revision);
  const b = f.call<any>('memory.propose', {
    project_id: f.project.id,
    key: 'report',
    kind: 'report',
    text: 'Updated analysis',
    dependencies: [a.id],
  });
  expect(() => f.call('memory.commit', { memory_id: b.id }, b.revision)).toThrowError(
    expect.objectContaining({ code: 'invalid_input' }),
  );
  expect(f.call<any>('memory.get', { memory_id: a.id }).text).toBe('Original analysis');
});

it('bounds multilingual search excerpts and preserves the complete current body for targeted get', async () => {
  const f = await workbenchFixture();
  const text = '需要复查的研究报告'.repeat(500);
  const r = f.call<any>('memory.propose', {
    project_id: f.project.id,
    key: 'research',
    kind: 'report',
    text,
  });
  f.call('memory.commit', { memory_id: r.id }, r.revision);
  const result = f.call<any>('memory.search', { project_id: f.project.id, q: '研究报告' });
  expect(result.items[0]).not.toHaveProperty('text');
  expect(Buffer.byteLength(result.items[0].summary)).toBeLessThanOrEqual(1200);
  expect(result.items[0].summary).not.toContain('�');
  expect(f.call<any>('memory.get', { memory_id: r.id }).text).toBe(text);
});

it('never replaces a decision by confirming a report with the same key and does not invalidate context when rejecting a draft', async () => {
  const f = await workbenchFixture();
  const a = f.call<any>('memory.propose', {
    project_id: f.project.id,
    key: 'database',
    kind: 'decision',
    text: 'Use SQLite',
  });
  f.call('memory.commit', { memory_id: a.id }, a.revision);
  const b = f.call<any>('memory.propose', {
    project_id: f.project.id,
    key: 'database',
    kind: 'report',
    text: 'A report claiming a different choice',
  });
  const before = f.call<any>('memory.context', { project_id: f.project.id });
  expect(() => f.call('memory.commit', { memory_id: b.id }, b.revision)).toThrowError(
    expect.objectContaining({ code: 'invalid_input' }),
  );
  f.call('memory.archive', { memory_id: b.id }, b.revision);
  expect(f.call<any>('memory.context', { project_id: f.project.id }).signature).toBe(
    before.signature,
  );
  expect(f.call<any>('memory.get', { memory_id: a.id }).text).toBe('Use SQLite');
});

it('leaves an adopted project improvement out of a new session memory packet and first turn', async () => {
  const f = await workbenchFixture({ delay: 10 });
  const send = vi.spyOn(f.adapter, 'send');
  const draft = f.call<any>('memory.propose', {
    project_id: f.project.id,
    key: 'language',
    kind: 'decision',
    text: 'Use precise terminology',
  });
  f.call('memory.commit', { memory_id: draft.id }, draft.revision);
  f.store.db.prepare('INSERT INTO improvements VALUES(?,?,?)').run(
    'adopted-procedure',
    1,
    JSON.stringify({
      id: 'adopted-procedure',
      revision: 1,
      project_id: f.project.id,
      retrospective_ids: [],
      status: 'active',
      change: { type: 'experience', procedure: 'Distinct adopted procedure' },
      proposed_at: Date.now(),
    }),
  );
  const packet = f.call<any>('memory.context', { project_id: f.project.id });
  expect(JSON.stringify(packet)).not.toContain('Distinct adopted procedure');
  expect(packet).not.toHaveProperty('experiences');
  const session = await withTools(f);
  await eventually(
    () => send.mock.calls.length > 0,
    () => f.control.tick(),
  );
  const input = send.mock.calls[0]![1].input as string;
  expect(input).toContain('Use precise terminology');
  expect(input).not.toContain('Distinct adopted procedure');
  const system = f.start.mock.calls.find(([spec]) => spec.platform_session_id === session.id)![0]
    .control_instructions!;
  expect(system).not.toContain('Distinct adopted procedure');
});

it('exposes delivery capability, stale packages and the records delivered for a turn', async () => {
  const f = await workbenchFixture({ delay: 10 });
  const draft = f.call<any>('memory.propose', {
    project_id: f.project.id,
    key: 'delivery-note',
    kind: 'note',
    title: 'Delivered note',
    text: 'Delivered evidence',
  });
  const active = f.call<any>('memory.commit', { memory_id: draft.id }, draft.revision);
  const s = await withTools(f);
  expect(
    f.control.memoryRead(user, f.project.id).sessions.find((x) => x.id === s.id),
  ).toMatchObject({
    memory_tool: true,
    stale: false,
    delivered: false,
  });
  await eventually(
    () => !!f.store.must<any>('sessions', s.id).memory_delivery?.delivered_signature,
    () => f.control.tick(),
  );
  const delivery = f.store.must<any>('sessions', s.id).memory_delivery;
  expect(
    f.store.events(0, f.project.id).find((e) => e.kind === 'memory.delivered')?.payload,
  ).toMatchObject({
    memory_ids: [active.id],
  });
  expect((f.control as any).memoryTurn(user, s.id, delivery.turn_id).items).toEqual([
    {
      id: active.id,
      key: 'delivery-note',
      title: 'Delivered note',
      kind: 'note',
      state: 'active',
      version: 1,
    },
  ]);
  expect(
    f.control.memoryRead(user, f.project.id).sessions.find((x) => x.id === s.id),
  ).toMatchObject({
    memory_tool: true,
    stale: false,
    delivered: true,
  });
  f.call('memory.archive', { memory_id: active.id }, active.revision);
  expect(
    f.control.memoryRead(user, f.project.id).sessions.find((x) => x.id === s.id),
  ).toMatchObject({
    memory_tool: true,
    stale: true,
    delivered: false,
  });
  expect((f.control as any).memoryTurn(user, s.id, delivery.turn_id).items[0].state).toBe(
    'archived',
  );
  f.store.event('memory.delivered', s, f.project.id, {
    turn_id: 'legacy-turn',
    signature: 'legacy',
  });
  expect((f.control as any).memoryTurn(user, s.id, 'legacy-turn').items).toEqual([]);
  expect((f.control as any).memoryTurn(user, s.id, 'undelivered-turn').items).toEqual([]);
  const fresh = f.store.must<any>('sessions', s.id);
  f.store.update('sessions', { ...fresh, runtime_review: {} }, fresh.revision);
  expect(
    f.control.memoryRead(user, f.project.id).sessions.find((x) => x.id === s.id)?.memory_tool,
  ).toBe(false);
});

it('reads memory counts for a session in turn order using the latest delivery of each turn', async () => {
  const f = await workbenchFixture();
  const draft = f.call<any>('memory.propose', {
    project_id: f.project.id,
    key: 'delivered-note',
    kind: 'note',
    text: 'Delivered evidence',
  });
  const active = f.call<any>('memory.commit', { memory_id: draft.id }, draft.revision);
  const otherDraft = f.call<any>('memory.propose', {
    project_id: f.project.id,
    key: 'other-note',
    kind: 'note',
    text: 'Other evidence',
  });
  const other = f.call<any>('memory.commit', { memory_id: otherDraft.id }, otherDraft.revision);
  const session = await f.create();
  const otherSession = await f.create();
  expect(f.control.memorySessionTurns(user, session.id)).toEqual({ turns: [] });
  f.store.event('memory.delivered', session, f.project.id, {
    turn_id: 'first-turn',
    memory_ids: [active.id],
  });
  f.store.event('memory.delivered', session, f.project.id, {
    turn_id: 'empty-turn',
    memory_ids: [],
  });
  f.store.event('memory.delivered', session, f.project.id, {
    turn_id: 'last-turn',
    memory_ids: [other.id],
  });
  f.store.event('memory.delivered', session, f.project.id, {
    turn_id: 'first-turn',
    memory_ids: [active.id, other.id],
  });
  f.store.event('memory.delivered', session, f.project.id, { turn_id: 'legacy-turn' });
  f.store.event('memory.delivered', otherSession, f.project.id, {
    turn_id: 'other-session-turn',
    memory_ids: [active.id],
  });
  const result = f.control.memorySessionTurns(user, session.id);
  expect(result).toEqual({
    turns: [
      { turn_id: 'first-turn', count: 2 },
      { turn_id: 'last-turn', count: 1 },
    ],
  });
  for (const turn of result.turns)
    expect(turn.count).toBe(f.control.memoryTurn(user, session.id, turn.turn_id).items.length);
  expect(f.control.memoryTurn(user, session.id, 'empty-turn').items).toEqual([]);
});

it('refuses session memory counts for the principals refused by the single-turn read', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
  const principal = {
    id: 'agent',
    role: 'conductor' as const,
    session_id: session.id,
    project_id: f.project.id,
    expires_at: Date.now() + 60000,
  };
  expect(() => f.control.memoryTurn(principal, session.id, 'first-turn')).toThrowError(
    expect.objectContaining({ code: 'permission_denied' }),
  );
  expect(() => f.control.memorySessionTurns(principal, session.id)).toThrowError(
    expect.objectContaining({ code: 'permission_denied' }),
  );
});

it('reports serialized record bytes and the full context budget even when decisions overflow', async () => {
  const f = await workbenchFixture();
  const items: any[] = [];
  for (let i = 0; i < 3; i++) {
    const draft = f.call<any>('memory.propose', {
      project_id: f.project.id,
      key: 'budget-rule-' + i,
      kind: 'decision',
      text: '多字节 "rule"\n'.repeat(200),
    });
    const stored = f.store.must<any>('memory_records', draft.id);
    const committed = f.store.update(
      'memory_records',
      { ...stored, state: 'active', committed_at: f.store.now() },
      stored.revision,
    );
    items.push({ ...committed, text: draft.text });
    const used = items.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);
    const read = f.control.memoryRead(user, f.project.id);
    expect(read.budget).toEqual({ used_bytes: used, limit_bytes: 12000 });
    for (const record of read.records)
      expect(record.bytes).toBe(
        Buffer.byteLength(JSON.stringify(items.find((item) => item.id === record.id))),
      );
    if (used <= 12000)
      expect(f.call<any>('memory.context', { project_id: f.project.id }).bytes).toBe(used);
    else
      expect(() => f.call('memory.context', { project_id: f.project.id })).toThrowError(
        expect.objectContaining({ code: 'memory_budget_exceeded', details: read.budget }),
      );
  }
});

it('syncs instruction files and native memory files into current notes and follows their changes', async () => {
  const f = await workbenchFixture();
  const memory = path.join(
    f.protectionPaths.home,
    '.claude/projects',
    f.source.replace(/[^a-zA-Z0-9]/g, '-'),
    'memory',
  );
  mkdirSync(memory, { recursive: true });
  writeFileSync(path.join(f.source, 'CLAUDE.md'), 'Reply in Simplified Chinese.');
  writeFileSync(path.join(memory, 'MEMORY.md'), '- [Gate](gate.md) - index line');
  const gate = path.join(memory, 'gate.md');
  writeFileSync(
    gate,
    '---\nname: gate-machine\ndescription: Gates run on ws\n---\nRun gates on ws.',
  );
  const imported = () =>
    f.store
      .list<any>('memory_records')
      .filter((r) => r.state === 'active' && r.tags?.includes('imported'));
  const ctx = (f.control as any).ctx;
  const sync = () => syncMemoryFiles(ctx, f.store.must<any>('projects', f.project.id));
  sync();
  expect(imported().map((r) => [r.key, r.kind, r.authority, r.title, r.summary])).toEqual(
    expect.arrayContaining([
      ['import:root0/CLAUDE.md', 'note', 'user', 'CLAUDE.md', undefined],
      [
        'import:root0/claude-memory/gate.md',
        'note',
        'agent_reported',
        'gate-machine',
        'Gates run on ws',
      ],
    ]),
  );
  expect(imported()).toHaveLength(2);
  const first = imported().find((r) => r.key === 'import:root0/claude-memory/gate.md');
  const search = f.call<any>('memory.search', { project_id: f.project.id, q: 'gates' });
  expect(search.items.map((i: any) => i.id)).toContain(first.id);
  sync();
  expect(f.store.list('memory_records')).toHaveLength(2);
  writeFileSync(gate, 'Run gates on the Mac Studio.');
  sync();
  expect(f.store.must<any>('memory_records', first.id)).toMatchObject({
    state: 'archived',
    reason: 'superseded',
  });
  const claude = imported().find((r) => r.key === 'import:root0/CLAUDE.md');
  f.call('memory.archive', { memory_id: claude.id }, claude.revision);
  rmSync(gate);
  sync();
  expect(imported()).toEqual([]);
});

it('delivers an unchanged memory packet once and again after the session compacts', async () => {
  const f = await workbenchFixture({ delay: 10 });
  const send = vi.spyOn(f.adapter, 'send');
  const draft = f.call<any>('memory.propose', {
    project_id: f.project.id,
    key: 'style',
    kind: 'decision',
    text: 'Distinct delivered rule',
  });
  f.call('memory.commit', { memory_id: draft.id }, draft.revision);
  const session = await withTools(f);
  const sendTurn = async (input: string, count: number) => {
    await eventually(
      () =>
        !f.store
          .list<any>('session_turns')
          .some((t) => t.state === 'running' || t.state === 'queued'),
      () => f.control.tick(),
    );
    f.call(
      'session.send',
      { session_id: session.id, input },
      f.store.must<any>('sessions', session.id).revision,
    );
    await eventually(
      () => send.mock.calls.length === count,
      () => f.control.tick(),
    );
    return send.mock.calls[count - 1]![1].input;
  };
  await eventually(
    () =>
      f.store.must<any>('sessions', session.id).state === 'open' &&
      !!f.store.must<any>('sessions', session.id).memory_delivery?.delivered_signature,
    () => f.control.tick(),
  );
  expect(send.mock.calls[0]![1].input).toContain('Distinct delivered rule');
  expect(await sendTurn('Second turn', 2)).not.toContain('[Pantheon current project memory]');
  f.store.event(
    'agent.context.compacted',
    f.store.must<any>('sessions', session.id),
    f.project.id,
    {},
  );
  expect(await sendTurn('After compaction', 3)).toContain('Distinct delivered rule');
});
