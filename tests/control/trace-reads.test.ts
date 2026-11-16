import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TraceIndex } from '@pantheon/control';
import type { Session, SessionTurn } from '@pantheon/domain';
import { fixture, user } from '../helpers.js';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { traceProjects } from '../../packages/control/dist/trace-view.js';

const base = Date.parse('2026-01-01T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('trace reads', () => {
  it('keeps a turn queued long before the window that never ran', async () => {
    let clock = base;
    const f = fixture({ now: () => clock });
    cleanups.push(() => f.close());
    const session = f.store.insert<Session>('sessions', {
      id: 'waiting',
      revision: 1,
      project_id: f.project.id,
      runtime: f.adapter.name,
      title: 'Waiting',
      state: 'open',
      turn_count: 0,
    });
    const turn = (id: string, state: SessionTurn['state']) =>
      f.store.insert<SessionTurn>('session_turns', {
        id,
        revision: 1,
        project_id: f.project.id,
        session_id: session.id,
        input: 'Check the project',
        kind: 'send',
        delivery: state === 'queued' ? 'queued' : 'delivered',
        state,
      });
    const stuck = turn('stuck-turn', 'queued');
    f.store.event('turn.queued', stuck, f.project.id, {});
    const recent = turn('recent-turn', 'completed');
    clock = base + 10 * DAY;
    f.store.event('turn.running', recent, f.project.id, {});
    clock += 60_000;
    f.store.event('turn.completed', recent, f.project.id, {});
    const trace = await f.control.projectTrace(
      user,
      f.project.id,
      iso(base + 10 * DAY - 3_600_000),
      iso(base + 10 * DAY + 3_600_000),
    );
    expect(trace.lanes[0]!.turns.map((row) => [row.id, row.start, row.status])).toEqual([
      ['stuck-turn', base, 'running'],
      ['recent-turn', base + 10 * DAY, 'ok'],
    ]);
  });

  it('indexes an appended transcript as a fresh index reads the whole file', async () => {
    const homes = mkdtempSync(path.join(os.tmpdir(), 'trace-reads-'));
    cleanups.push(() => rmSync(homes, { recursive: true, force: true }));
    const claudeHome = path.join(homes, 'claude');
    const index = (name: string) => {
      const trace = new TraceIndex({
        file: path.join(homes, `${name}.sqlite`),
        claudeHomes: [claudeHome],
        codexHomes: [],
      });
      cleanups.push(() => trace.close());
      return trace;
    };
    const growing = index('growing');
    const f = fixture({ now: () => base, controlOptions: { trace: growing } });
    cleanups.push(() => f.close());
    const nativeId = 'b1c2d3e4-0000-4000-8000-000000000001';
    const file = path.join(claudeHome, 'projects/-repo', `${nativeId}.jsonl`);
    const row = (second: number, extra: object) =>
      JSON.stringify({
        cwd: f.projectRoot,
        sessionId: nativeId,
        timestamp: iso(base + second * 1000),
        ...extra,
      }) + '\n';
    const start = (id: string, second: number) =>
      row(second, {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: id } }] },
      });
    const end = (id: string, second: number) =>
      row(second, {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true }] },
      });
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      row(0, { type: 'user', message: { content: 'Run it' }, turnPosition: { turnIndex: 1 } }) +
        start('first-call', 1),
    );
    await f.control.traceScan(1000);
    appendFileSync(file, end('first-call', 2) + start('second-call', 3));
    await f.control.traceScan(1000);
    const fresh = index('fresh');
    await fresh.scan(traceProjects((f.control as unknown as { ctx: ControlContext }).ctx), 1000);
    const spans = growing.lanes(f.project.id)[0]!.spans;
    expect(spans.find((span) => span.id === 'first-call')).toMatchObject({
      end: base + 2000,
      status: 'error',
    });
    expect(spans).toEqual(fresh.lanes(f.project.id)[0]!.spans);
  });
});
