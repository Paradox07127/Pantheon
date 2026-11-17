import { expect, it } from 'vitest';
import { DomainError } from '@pantheon/domain';
import {
  approvalQuestions,
  command,
  inputSchemas,
  querySchemas,
  type CommandType,
} from '@pantheon/protocol';
import { fixture, user } from '../helpers.js';

/** A valid input for each command that control does not handle yet; the task that implements one removes its entry. */
const unimplemented: [CommandType, Record<string, unknown>][] = [];

it('defines a strict input schema for each unimplemented command and the queries', () => {
  for (const [type, input] of unimplemented) {
    expect(Object.hasOwn(inputSchemas, type), type).toBe(true);
    expect(inputSchemas[type].safeParse(input).success, type).toBe(true);
    expect(inputSchemas[type].safeParse({ ...input, extra: 1 }).success, type).toBe(false);
  }
  expect(Object.keys(querySchemas).sort()).toEqual([
    'agent.list',
    'agent.proposal',
    'agent.templates',
    'app.settings',
    'backend.list',
    'board.history',
    'board.view',
    'change_story.diff',
    'change_story.list',
    'connections.status',
    'device.list',
    'device.probe',
    'device.ssh_hosts',
    'extensions.inventory',
    'external.read',
    'files.list',
    'files.read',
    'files.search',
    'github.items',
    'github.pr.detail',
    'import.candidates',
    'improvement.list',
    'improvement.sessions',
    'improvement.signals',
    'mcp.app.resource',
    'mcp.status',
    'memory.document',
    'memory.graph',
    'memory.item',
    'memory.read',
    'memory.recent',
    'memory.session_turns',
    'memory.turn',
    'needs_you.list',
    'permission.rules',
    'project.baseline.read',
    'project.branches',
    'project.brief',
    'project.collab',
    'project.defaults',
    'project.facts.read',
    'project.gates.history',
    'project.head',
    'project.heatmap',
    'project.intro.read',
    'project.read',
    'project.review.metrics',
    'project.timeline',
    'project.trace',
    'project.trace.stats',
    'project.usage.read',
    'projects.summary',
    'range_story.list',
    'repo.blame',
    'repo.commit_after',
    'repo.commit_diff',
    'repo.compare',
    'repo.file_history',
    'repo.log',
    'repo.status',
    'repo.timeline',
    'repo.working_diff',
    'repo.worktrees',
    'retrospective.list',
    'routing.table',
    'runtime.models',
    'runtime.status',
    'session.activity',
    'session.comments',
    'session.create.preview',
    'session.diff',
    'session.gates',
    'session.gates.history',
    'session.importable',
    'session.list',
    'session.mcp_servers',
    'session.preflight',
    'session.reviews',
    'session.search',
    'session.step_diff',
    'session.tasks',
    'session.tool_image',
    'session.trace',
    'session.turn_diff',
    'signal.list',
    'style.read',
    'symbols.search',
    'task.trace',
    'theme.get',
    'theme.list',
    'tool.calls',
    'trace.time',
    'workflow.definition',
    'workflow.definition.list',
    'workflow.policy',
    'workspace.stale',
  ]);
});

it('validates cancellation commands without granting session or revision overrides in their input', () => {
  for (const type of ['session.gates.cancel', 'session.merge.cancel'] as const) {
    expect(inputSchemas[type].safeParse({ session_id: 'session' }).success).toBe(true);
    expect(
      inputSchemas[type].safeParse({ session_id: 'session', actor: 'lead', force: true }).success,
    ).toBe(false);
    expect(inputSchemas[type].safeParse({}).success).toBe(false);
  }
});

it('rejects a defined but unimplemented command with unsupported_command and keeps no receipt', async () => {
  const f = await fixture();
  try {
    for (const [type, input] of unimplemented) {
      const sent = command(user.id, type, input);
      for (let attempt = 0; attempt < 2; attempt++) {
        let error: unknown;
        try {
          f.control.execute(user, sent);
        } catch (e) {
          error = e;
        }
        expect(error, type).toBeInstanceOf(DomainError);
        expect((error as DomainError).code, type).toBe('unsupported_command');
      }
    }
  } finally {
    await f.close();
  }
});

it('accepts only the known effort levels when creating a session or changing its model', () => {
  const create = { project_id: 'project', runtime: 'claude', input: 'Fix the test' },
    change = { session_id: 'session', model: 'sonnet' };
  expect(inputSchemas['session.create'].safeParse({ ...create, effort: 'high' }).success).toBe(
    true,
  );
  expect(inputSchemas['session.create'].safeParse({ ...create, effort: 'huge' }).success).toBe(
    false,
  );
  expect(inputSchemas['session.setModel'].safeParse({ ...change, effort: 'high' }).success).toBe(
    true,
  );
  expect(inputSchemas['session.setModel'].safeParse({ ...change, effort: 'huge' }).success).toBe(
    false,
  );
});

it('accepts the device a new session runs on', () => {
  expect(
    inputSchemas['session.create'].parse({
      project_id: 'project',
      runtime: 'claude',
      input: 'Fix the test',
      device_id: 'build-box',
    }),
  ).toMatchObject({ device_id: 'build-box' });
});

it('opens an app debug session without a CDP port and refuses one', () => {
  const create = { project_id: 'project', runtime: 'claude', input: 'Fix the error' };
  const parse = (extra: Record<string, unknown>) =>
    inputSchemas['session.create'].safeParse({ ...create, ...extra }).success;
  expect(parse({ purpose: 'app_debug' })).toBe(true);
  expect(parse({ purpose: 'app_debug', cdp_port: 9333 })).toBe(false);
});

it('defines strict session pin, archive, unarchive and delete commands', () => {
  expect(inputSchemas['session.pin'].safeParse({ session_id: 's', pinned: true }).success).toBe(
    true,
  );
  expect(inputSchemas['session.pin'].safeParse({ session_id: 's' }).success).toBe(false);
  for (const type of ['session.archive', 'session.unarchive', 'session.delete'] as const) {
    expect(inputSchemas[type].safeParse({ session_id: 's' }).success, type).toBe(true);
    expect(inputSchemas[type].safeParse({ session_id: 's', extra: 1 }).success, type).toBe(false);
  }
});

it('defines a strict session snooze command', () => {
  const schema = inputSchemas['session.snooze'];
  expect(schema.safeParse({ session_id: 's', snoozed: true }).success).toBe(true);
  expect(schema.safeParse({ session_id: 's' }).success).toBe(false);
  expect(schema.safeParse({ session_id: 's', snoozed: false, extra: 1 }).success).toBe(false);
});

it('defines a strict session rollback command that names the turn', () => {
  const rollback = inputSchemas['session.rollback'];
  expect(rollback.safeParse({ session_id: 's', turn_id: 't' }).success).toBe(true);
  expect(rollback.safeParse({ session_id: 's' }).success).toBe(false);
  expect(rollback.safeParse({ session_id: 's', turn_id: 't', extra: 1 }).success).toBe(false);
});

it('defines strict device list, probe, SSH host, save and remove inputs', () => {
  expect(querySchemas['device.list'].parse({ refresh: 'true' })).toEqual({ refresh: true });
  expect(querySchemas['device.list'].safeParse({ extra: 'field' }).success).toBe(false);
  expect(querySchemas['device.probe'].parse({ id: 'build-box' })).toEqual({ id: 'build-box' });
  expect(querySchemas['device.probe'].safeParse({}).success).toBe(false);
  expect(querySchemas['device.ssh_hosts'].parse({})).toEqual({});
  expect(querySchemas['device.ssh_hosts'].safeParse({ path: '/etc/ssh' }).success).toBe(false);
  const save = inputSchemas['device.save'];
  expect(
    save.safeParse({ id: 'build-box', ssh: 'build-box', resources: { gpu: 2 }, max_sessions: 4 })
      .success,
  ).toBe(true);
  expect(save.safeParse({ id: 'local', ssh: 'build-box' }).success).toBe(false);
  expect(save.safeParse({ id: 'build-box', ssh: '' }).success).toBe(false);
  expect(save.safeParse({ id: 'build-box', ssh: 'build-box', max_sessions: 0 }).success).toBe(
    false,
  );
  expect(inputSchemas['device.remove'].safeParse({ id: 'build-box' }).success).toBe(true);
  expect(inputSchemas['device.remove'].safeParse({ id: 'build-box', extra: 1 }).success).toBe(
    false,
  );
});

it('defines strict optional project parameters for needs_you.list', () => {
  expect(querySchemas['needs_you.list'].parse({})).toEqual({});
  expect(querySchemas['needs_you.list'].parse({ project_id: 'project' })).toEqual({
    project_id: 'project',
  });
  expect(querySchemas['needs_you.list'].safeParse({ project_id: '' }).success).toBe(false);
  expect(querySchemas['needs_you.list'].safeParse({ extra: 'field' }).success).toBe(false);
});

it('defines strict session and bounded limit parameters for session.gates.history', () => {
  expect(querySchemas['session.gates.history'].parse({ session_id: 'session' })).toEqual({
    session_id: 'session',
    limit: 20,
  });
  expect(
    querySchemas['session.gates.history'].parse({ session_id: 'session', limit: '50' }),
  ).toEqual({
    session_id: 'session',
    limit: 50,
  });
  expect(querySchemas['session.gates.history'].safeParse({ session_id: '' }).success).toBe(false);
  expect(
    querySchemas['session.gates.history'].safeParse({ session_id: 'session', limit: '0' }).success,
  ).toBe(false);
  expect(
    querySchemas['session.gates.history'].safeParse({ session_id: 'session', limit: '101' })
      .success,
  ).toBe(false);
  expect(
    querySchemas['session.gates.history'].safeParse({ session_id: 'session', extra: '1' }).success,
  ).toBe(false);
});

it('defines strict project and bounded limit parameters for project.gates.history', () => {
  expect(querySchemas['project.gates.history'].parse({ project_id: 'project' })).toEqual({
    project_id: 'project',
    limit: 30,
  });
  for (const limit of ['1', '50', '100'])
    expect(querySchemas['project.gates.history'].parse({ project_id: 'project', limit })).toEqual({
      project_id: 'project',
      limit: Number(limit),
    });
  expect(querySchemas['project.gates.history'].safeParse({}).success).toBe(false);
  expect(querySchemas['project.gates.history'].safeParse({ project_id: '' }).success).toBe(false);
  for (const limit of ['0', '501', '1.5', 'invalid'])
    expect(
      querySchemas['project.gates.history'].safeParse({ project_id: 'project', limit }).success,
    ).toBe(false);
  expect(
    querySchemas['project.gates.history'].safeParse({ project_id: 'project', extra: '1' }).success,
  ).toBe(false);
});

it('defines strict project timeline parameters with an optional ISO time', () => {
  const schema = querySchemas['project.timeline'];
  expect(schema.parse({ project_id: 'project' })).toEqual({ project_id: 'project' });
  for (const since of ['2026-01-01T12:00:00Z', '2026-01-01T07:00:00-05:00'])
    expect(schema.parse({ project_id: 'project', since })).toEqual({
      project_id: 'project',
      since,
    });
  expect(schema.safeParse({}).success).toBe(false);
  expect(schema.safeParse({ project_id: '' }).success).toBe(false);
  expect(schema.safeParse({ project_id: 'project', extra: 'field' }).success).toBe(false);
  for (const since of ['', 'yesterday', '2026-01-01', '2026-02-30T12:00:00Z'])
    expect(schema.safeParse({ project_id: 'project', since }).success).toBe(false);
});

it('defines projects.summary with no query parameters', () => {
  expect(querySchemas['projects.summary'].parse({})).toEqual({});
  expect(querySchemas['projects.summary'].safeParse({ project_id: 'project' }).success).toBe(false);
});

it('accepts at most ten attachments and ten skills on a session turn', () => {
  const ids = (count: number) => Array.from({ length: count }, (_, index) => `attachment-${index}`);
  const skills = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      name: `skill-${index}`,
      path: `/skills/${index}`,
    }));
  const send = { session_id: 'session', input: 'Read these' },
    create = { project_id: 'project', runtime: 'claude', input: 'Read these' };
  for (const schema of [inputSchemas['session.send'], inputSchemas['session.steer']]) {
    expect(schema.safeParse({ ...send, attachments: ids(10), skills: skills(10) }).success).toBe(
      true,
    );
    expect(schema.safeParse({ ...send, attachments: ids(11) }).success).toBe(false);
    expect(schema.safeParse({ ...send, skills: skills(11) }).success).toBe(false);
  }
  expect(
    inputSchemas['session.create'].safeParse({ ...create, attachments: ids(10) }).success,
  ).toBe(true);
  expect(
    inputSchemas['session.create'].safeParse({ ...create, attachments: ids(11) }).success,
  ).toBe(false);
});

it('defines board history with only the project parameter', () => {
  const schema = querySchemas['board.history'];
  expect(schema.parse({ project_id: 'project' })).toEqual({ project_id: 'project' });
  expect(schema.safeParse({}).success).toBe(false);
  expect(schema.safeParse({ project_id: 'project', days: '7' }).success).toBe(false);
});

it('accepts whole-project memory graphs with contextual defaults and bounded node limits', () => {
  const schema = querySchemas['memory.graph'];
  expect(schema.parse({ project_id: 'project' })).toMatchObject({ max_nodes: 80 });
  expect(schema.parse({ project_id: 'project', memory_id: 'record' })).toMatchObject({
    max_nodes: 40,
  });
  expect(schema.parse({ project_id: 'project', max_nodes: '200' })).toMatchObject({
    max_nodes: 200,
  });
  expect(schema.safeParse({ project_id: 'project', max_nodes: 201 }).success).toBe(false);
});

it('validates the session memory turns query input', () => {
  const schema = querySchemas['memory.session_turns'];
  expect(schema.parse({ session_id: 'session' })).toEqual({ session_id: 'session' });
  expect(schema.safeParse({}).success).toBe(false);
  expect(schema.safeParse({ session_id: '' }).success).toBe(false);
  expect(schema.safeParse({ session_id: 'session', turn_id: 'turn' }).success).toBe(false);
});

it('validates memory turn and recent query inputs', () => {
  const schemas = querySchemas as any;
  expect(schemas['memory.turn'].parse({ session_id: 'session', turn_id: 'turn' })).toEqual({
    session_id: 'session',
    turn_id: 'turn',
  });
  expect(schemas['memory.turn'].safeParse({ session_id: 'session' }).success).toBe(false);
  expect(
    schemas['memory.turn'].safeParse({ session_id: 'session', turn_id: 'turn', extra: true })
      .success,
  ).toBe(false);
  expect(schemas['memory.recent'].parse({ project_id: 'project' })).toEqual({
    project_id: 'project',
    limit: 10,
  });
  expect(schemas['memory.recent'].parse({ project_id: 'project', limit: '50' }).limit).toBe(50);
  for (const limit of [0, 51, 1.5])
    expect(schemas['memory.recent'].safeParse({ project_id: 'project', limit }).success).toBe(
      false,
    );
});

it('accepts creation start points and refuses them for in-place sessions and previews', () => {
  expect(
    querySchemas['session.create.preview'].parse({
      project_id: 'project',
      from: JSON.stringify({ branch: 'main' }),
    }),
  ).toMatchObject({ from: { branch: 'main' } });
  expect(
    querySchemas['session.create.preview'].safeParse({ project_id: 'project', from: '{bad json' })
      .success,
  ).toBe(false);
  for (const schema of [inputSchemas['session.create'], querySchemas['session.create.preview']]) {
    const base =
      schema === inputSchemas['session.create']
        ? { project_id: 'project', input: 'Start' }
        : { project_id: 'project' };
    expect(schema.safeParse({ ...base, workspace: 'in_place' }).success).toBe(true);
    for (const from of [{ branch: 'feature' }, { session_id: 'source' }]) {
      expect(schema.safeParse({ ...base, from }).success).toBe(true);
      expect(schema.safeParse({ ...base, from, workspace: 'in_place' }).success).toBe(false);
    }
    expect(
      schema.safeParse({ ...base, from: { branch: 'main', session_id: 'source' } }).success,
    ).toBe(false);
  }
});

it('accepts at most eight session references in turn extras', () => {
  for (const name of ['session.create', 'session.send', 'session.steer', 'session.fork'] as const) {
    const base =
      name === 'session.create'
        ? { project_id: 'project', input: 'Use these' }
        : { session_id: 'session', input: 'Use these' };
    const refs = Array.from({ length: 8 }, (_, index) => ({
      kind: 'session',
      id: `session-${index}`,
    }));
    expect(inputSchemas[name].safeParse({ ...base, refs }).success).toBe(true);
    expect(inputSchemas[name].safeParse({ ...base, refs: [...refs, refs[0]] }).success).toBe(false);
    expect(
      inputSchemas[name].safeParse({ ...base, refs: [{ kind: 'project', id: 'project' }] }).success,
    ).toBe(false);
  }
});

it('accepts runtime, model and effort overrides for forks', () => {
  expect(
    inputSchemas['session.fork'].parse({
      session_id: 'session',
      input: 'Try again',
      runtime: 'codex',
      model: 'model',
      effort: 'high',
    }),
  ).toMatchObject({ runtime: 'codex', model: 'model', effort: 'high' });
});

it('validates project tool filters and bounded limits and numeric diagnosis windows', () => {
  const calls = querySchemas['tool.calls'];
  expect(calls.parse({ project_id: 'project' })).toEqual({ project_id: 'project', limit: 50 });
  expect(calls.parse({ project_id: 'project', command: 'git status', limit: '200' })).toEqual({
    project_id: 'project',
    command: 'git status',
    limit: 200,
  });
  for (const limit of ['0', '201', '1.5'])
    expect(calls.safeParse({ project_id: 'project', limit }).success).toBe(false);
  expect(calls.safeParse({ project_id: 'project', extra: true }).success).toBe(false);
  const stats = querySchemas['project.trace.stats'];
  expect(stats.parse({ project_id: 'project', since: '100', until: '200' })).toEqual({
    project_id: 'project',
    since: 100,
    until: 200,
  });
  expect(stats.safeParse({ project_id: 'project', since: '200', until: '100' }).success).toBe(
    false,
  );
  expect(stats.safeParse({ project_id: 'project', since: 'yesterday', until: '200' }).success).toBe(
    false,
  );
  expect(stats.safeParse({ project_id: 'project' }).success).toBe(false);
});

it('accepts only_failed on the plain session gate command schema', () => {
  const schema = inputSchemas['session.gates.run'];
  expect(schema.parse({ session_id: 'session', only_failed: true })).toEqual({
    session_id: 'session',
    only_failed: true,
  });
  expect(schema.parse({ session_id: 'session', only_failed: false }).only_failed).toBe(false);
  expect(schema.safeParse({ session_id: 'session', only_failed: 'true' }).success).toBe(false);
  expect(schema.omit({ session_id: true }).extend({}).parse({ only_failed: true })).toEqual({
    only_failed: true,
  });
});

it('accepts an epoch start and up to five hundred project gate runs', () => {
  const schema = querySchemas['project.gates.history'];
  expect(schema.parse({ project_id: 'project', since: '123', limit: '500' })).toEqual({
    project_id: 'project',
    since: 123,
    limit: 500,
  });
  for (const input of [{ since: 'invalid' }, { since: '123', limit: '501' }])
    expect(schema.safeParse({ project_id: 'project', ...input }).success).toBe(false);
});

it('accepts a free-text question without options and at most four options per question', () => {
  const question = { question: 'Which name?', header: 'Name', multiSelect: false };
  expect(approvalQuestions.safeParse([{ ...question, options: [], other: true }]).success).toBe(
    true,
  );
  const options = Array.from({ length: 5 }, (_, i) => ({ label: `Option ${i}`, description: '' }));
  expect(approvalQuestions.safeParse([{ ...question, options }]).success).toBe(false);
});
