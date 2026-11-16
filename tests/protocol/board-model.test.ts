import { expect, expectTypeOf, it } from 'vitest';
import {
  querySchemas,
  type BoardActivity,
  type BoardHistory,
  type BoardModel,
  type BoardSegment,
  type BoardWaiting,
  type ImprovementSignalFinding,
  type StaleWorkspaces,
  type WorkbenchSession,
} from '@pantheon/protocol';

type Task = BoardModel['tasks'][number];
type Lead = NonNullable<BoardModel['leads']>[number];

it('types the optional facts of a plan task', () => {
  expectTypeOf<Task['context']>().toEqualTypeOf<
    { used_tokens: number; window_tokens: number } | undefined
  >();
  expectTypeOf<Task['acceptance_checks']>().toEqualTypeOf<
    { text: string; state: 'pending' | 'passed' | 'failed' }[] | undefined
  >();
  expectTypeOf<Task['gate_steps']>().toEqualTypeOf<
    | {
        name: string;
        state: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
        tests?: { passed: number; failed: number; skipped: number };
        carried?: boolean;
      }[]
    | undefined
  >();
  expectTypeOf<Task['successors']>().toEqualTypeOf<number | undefined>();
  expectTypeOf<Task['external_review']>().toEqualTypeOf<
    | {
        rounds: number;
        verdict: 'pending' | 'passed' | 'failed';
        started_at?: number;
        ended_at?: number;
        findings?: { blocking: number; other: number };
      }
    | undefined
  >();
});

it('types pending user edits and their nullable delivery times on each lead', () => {
  expectTypeOf<NonNullable<Lead['pending_edits']>[number]['id']>().toEqualTypeOf<string>();
  expectTypeOf<Lead['recent_edits']>().toEqualTypeOf<
    | {
        id: string;
        created_at: number;
        plan_written_at: number | null;
        lead_read_at: number | null;
        sessions_notified_at: number | null;
      }[]
    | undefined
  >();
});

it('accepts three days as a board range and requires a supported range', () => {
  const schema = querySchemas['board.view'];
  expect(schema.parse({ project_id: 'project', days: '3' }).days).toBe('3');
  expect(schema.safeParse({ project_id: 'project' }).success).toBe(false);
  expect(schema.safeParse({ project_id: 'project', days: '2' }).success).toBe(false);
});

it('types task drawer facts and optional attempt facts', () => {
  expectTypeOf<Task['task_type']>().toEqualTypeOf<
    'feature' | 'fix' | 'research' | 'infra' | 'docs' | undefined
  >();
  expectTypeOf<Task['scope']>().toEqualTypeOf<string[]>();
  expectTypeOf<Task['token_budget']>().toEqualTypeOf<number | undefined>();
  expectTypeOf<Task['subagents']>().toEqualTypeOf<number | undefined>();
  expectTypeOf<BoardActivity['repeated_failure']>().toEqualTypeOf<boolean | undefined>();
  expectTypeOf<BoardWaiting['options']>().toEqualTypeOf<string[] | undefined>();
  expectTypeOf<BoardSegment['additions']>().toEqualTypeOf<number | undefined>();
  expectTypeOf<BoardSegment['deletions']>().toEqualTypeOf<number | undefined>();
});

it('types whole course task facts, daily counts and decisions', () => {
  type HistoryTask = BoardHistory['tasks'][number];
  type HistoryDay = BoardHistory['days'][number];
  expectTypeOf<HistoryTask['depends_on']>().toEqualTypeOf<string[]>();
  expectTypeOf<HistoryTask['task_type']>().toEqualTypeOf<Task['task_type']>();
  expectTypeOf<HistoryTask['runtime']>().toEqualTypeOf<string | undefined>();
  expectTypeOf<HistoryTask['model']>().toEqualTypeOf<string | undefined>();
  expectTypeOf<HistoryTask['handback_reasons']>().toEqualTypeOf<
    { gate: number; review: number; other: number } | undefined
  >();
  expectTypeOf<HistoryTask['gate_passed_on_attempt']>().toEqualTypeOf<number | undefined>();
  expectTypeOf<HistoryDay['failed']>().toEqualTypeOf<number>();
  expectTypeOf<HistoryDay['waited']>().toEqualTypeOf<number>();
  expectTypeOf<BoardHistory['decisions']>().toEqualTypeOf<
    {
      at: number;
      lane_id: string | null;
      kind: 'plan' | 'start' | 'stop' | 'accept';
      title?: string;
    }[]
  >();
});

it.each(['30', 'all'])('accepts the longer board range %s', (days) => {
  expect(querySchemas['board.view'].parse({ project_id: 'project', days }).days).toBe(days);
});

it('accepts an optional local calendar day for the board range', () => {
  const schema = querySchemas['board.view'];
  expect(schema.parse({ project_id: 'project', days: '7', until: '2026-11-01' }).until).toBe(
    '2026-11-01',
  );
  for (const until of ['2026-02-30', '2026-1-01', '2026-11-01T00:00:00Z'])
    expect(schema.safeParse({ project_id: 'project', days: '7', until }).success).toBe(false);
});

it('types cached repository facts and range gate failures as optional additions', () => {
  expectTypeOf<WorkbenchSession['predicted_conflicts']>().toEqualTypeOf<
    { files: string[]; total: number } | undefined
  >();
  expectTypeOf<StaleWorkspaces['worktree_disk']>().toEqualTypeOf<
    { count: number; size_bytes: number; unmeasured: number } | undefined
  >();
  expectTypeOf<StaleWorkspaces['shared_files']>().toEqualTypeOf<
    { files: { path: string; session_ids: string[] }[]; total: number } | undefined
  >();
  expectTypeOf<BoardModel['gate_failures']>().toEqualTypeOf<
    { name: string; failed_runs: number; runs: number; flaky: boolean }[] | undefined
  >();
});

it('types optional digest time partitions and user wait reasons', () => {
  type Time = {
    sessions: number;
    working_ms: number;
    waiting_ms: number;
    gate_ms: number;
    queue_ms: number;
  };
  expectTypeOf<BoardModel['counts']['session_time']>().toEqualTypeOf<Time | undefined>();
  expectTypeOf<NonNullable<BoardModel['counts']['previous']>['session_time']>().toEqualTypeOf<
    Time | undefined
  >();
  expectTypeOf<BoardModel['counts']['wait_by_reason_ms']>().toEqualTypeOf<
    { approval?: number; review?: number; question?: number } | undefined
  >();
});

it('types optional command approval and late gate evidence on signal findings', () => {
  expectTypeOf<ImprovementSignalFinding['evidence']>().toEqualTypeOf<
    | {
        kind: 'always_approved_command';
        command: string;
        approvals: number;
        rule?: string;
        session_id?: string;
      }
    | { kind: 'late_gate_failure'; name: string; runs: number; median_prior_ms: number }
    | undefined
  >();
});

it('types optional collaboration counts, moving lines and daily events', () => {
  type Lead = NonNullable<BoardModel['leads']>[number];
  type Messages = NonNullable<Lead['messages_today']>[number];
  expectTypeOf<Messages['subagents']>().toEqualTypeOf<number | undefined>();
  expectTypeOf<Messages['reviews']>().toEqualTypeOf<number | undefined>();
  expectTypeOf<Messages['gates']>().toEqualTypeOf<number | undefined>();
  expectTypeOf<Messages['in_flight']>().toEqualTypeOf<
    ('lead' | 'subagent' | 'review' | 'gate')[] | undefined
  >();
  expectTypeOf<Lead['events_today']>().toEqualTypeOf<
    { at: number; kind: 'handback' | 'model_change'; session_id: string }[] | undefined
  >();
});
