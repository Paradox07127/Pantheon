import { afterEach, expect, it } from 'vitest';
import type { Project } from '@pantheon/domain';
import { sessionTools, type BoardSnapshot } from '@pantheon/protocol';
import { fixture, user } from '../helpers.js';

let f: Awaited<ReturnType<typeof fixture>>;
afterEach(() => f.close());

const read = () =>
  (f.control.snapshot(user, f.project.id) as BoardSnapshot).projects.find(
    (project) => project.id === f.project.id,
  )!;
const events = () =>
  f.store.db
    .prepare("SELECT payload FROM events WHERE kind='project.gate_gpu_set' ORDER BY sequence")
    .all()
    .map((row) => JSON.parse((row as { payload: string }).payload) as unknown);

it('keeps the GPU closed to gate commands until the user opens it for the project', async () => {
  f = await fixture();
  expect(read().gate_gpu ?? false).toBe(false);
  const before = read();
  const on = f.call<Project>(
    'project.gateGpu.set',
    { project_id: f.project.id, enabled: true },
    before.revision,
  );
  expect(on).toMatchObject({ gate_gpu: true, revision: before.revision + 1 });
  expect(read()).toEqual(on);
  const off = f.call<Project>(
    'project.gateGpu.set',
    { project_id: f.project.id, enabled: false },
    on.revision,
  );
  expect(read()).toMatchObject({ gate_gpu: false, revision: on.revision + 1 });
  expect(read()).toEqual(off);
  expect(events()).toEqual([{ enabled: true }, { enabled: false }]);
});

it.each([
  { id: 'agent', role: 'lead' as const },
  { id: 'agent', role: 'planner' as const },
])('refuses a $role that turns on the GPU for gate commands', async (principal) => {
  f = await fixture();
  const before = read();
  expect(() =>
    f.call(
      'project.gateGpu.set',
      { project_id: f.project.id, enabled: true },
      before.revision,
      principal,
    ),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
  expect(read()).toEqual(before);
});

it('gives agents no tool that opens the GPU to gate commands', async () => {
  f = await fixture();
  const tools = Object.values(sessionTools).flatMap((tools) => Object.values(tools));
  expect(tools).not.toContain('project.gateGpu.set');
});
