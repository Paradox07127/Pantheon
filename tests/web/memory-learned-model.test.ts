import { describe, expect, it } from 'vitest';
import type { Improvement } from '@pantheon/domain';
import type { ImprovementListItem } from '@pantheon/protocol';
import { ruleParts, scopeParts, statusText } from '@/screens/memory/learned-model';
import { zh } from './i18n-setup.js';

const NOW = new Date(2026, 10, 13, 15, 0).getTime();
const at = (day: number, hour: number, minute: number) =>
  new Date(2026, 10, day, hour, minute).getTime();

const experience = (
  over: Partial<Extract<Improvement['change'], { type: 'experience' }>> = {},
): Improvement['change'] => ({ type: 'experience', procedure: 'run the tests', ...over });

const policy: Improvement['change'] = {
  type: 'policy_change',
  param: 'max_parallel',
  from: 3,
  to: 4,
};

const item = (over: Partial<ImprovementListItem> = {}): ImprovementListItem => ({
  id: 'i1',
  revision: 1,
  project_id: 'p1',
  source: 'daemon',
  retrospective_ids: [],
  status: 'candidate',
  grade: 'trial',
  change: experience(),
  proposed_at: at(13, 14, 33),
  ...over,
});

describe('learned rule text', () => {
  it.each([
    [
      'cuts the backticked commands out of an experience',
      experience({ procedure: 'run `pnpm test webhook` first, then `pnpm lint`' }),
      [
        { text: 'run ', code: false },
        { text: 'pnpm test webhook', code: true },
        { text: ' first, then ', code: false },
        { text: 'pnpm lint', code: true },
      ],
    ],
    [
      'keeps an unpaired backtick as text',
      experience({ procedure: 'read `a.ts` and the ` mark' }),
      [
        { text: 'read ', code: false },
        { text: 'a.ts', code: true },
        { text: ' and the ` mark', code: false },
      ],
    ],
    [
      'words a policy change as a parameter going from one value to another',
      policy,
      [{ text: '并发上限从 3 改成 4', code: false }],
    ],
  ])('%s', (_name, change, parts) => {
    expect(ruleParts(change)).toEqual(parts);
  });
});

describe('learned scope', () => {
  it('gives the domain, the tier and the runtime each their own part', () => {
    expect(
      scopeParts(experience({ domain: 'backend-logic', tier: 't2', runtime: 'codex' })),
    ).toEqual([
      { kind: 'text', text: zh('data.workflowPolicy.domain.backendLogic') },
      { kind: 'tier', text: 'T2' },
      { kind: 'runtime', runtime: 'codex', text: 'Codex' },
    ]);
    expect(scopeParts(experience({ runtime: 'claude' }))).toEqual([
      { kind: 'runtime', runtime: 'claude', text: 'Claude' },
    ]);
  });

  it('says the whole project for a policy change and all tasks for an unscoped experience', () => {
    expect(scopeParts(policy)).toEqual([
      { kind: 'text', text: zh('data.workflowPolicy.wholeProject') },
    ]);
    expect(scopeParts(experience())).toEqual([
      { kind: 'text', text: zh('data.workflowPolicy.allTasks') },
    ]);
  });

  it('gives the tier of a per-tier policy change the tier part', () => {
    expect(scopeParts({ ...policy, param: 'path', tier: 't3' })).toEqual([
      { kind: 'tier', text: 'T3' },
    ]);
  });
});

describe('learned status column', () => {
  const trial = { status: 'trial' as const, trial_started_at: at(11, 16, 40) };
  const reading = { tasks_seen: 2, tasks_required: 5, baseline_tasks: 4, metrics: [] };
  const kept = { status: 'active', decided_at: at(6, 9, 0) } as const;
  const sample = { tasks_seen: 10, tasks_required: 10, baseline_tasks: 10, metrics: [] };
  const reverted = { status: 'reverted' as const, decided_at: at(12, 9, 0) };
  const rejected = { status: 'rejected' as const, decided_at: at(12, 9, 0) };
  it.each<[string, [Partial<ImprovementListItem>, string][]]>([
    [
      'says how long ago a candidate was proposed',
      [
        [{ proposed_at: NOW - 20_000 }, zh('data.age.justNow')],
        [{ proposed_at: at(13, 14, 33) }, '27 分钟'],
        [{ proposed_at: at(13, 9, 10) }, '5 小时'],
        [{ proposed_at: at(12, 23, 50) }, zh('lib.time.yesterday')],
        [{ proposed_at: at(6, 10, 0) }, '11月6日'],
      ],
    ],
    [
      'counts the days of a trial, or says it has no baseline to compare with',
      [
        [trial, '第 3 天'],
        [{ ...trial, trial_started_at: at(13, 9, 0) }, '第 1 天'],
        [{ ...trial, status_reason: 'no_baseline' }, zh('memory.learned.noBaseline')],
      ],
    ],
    [
      "reads the trial's current baseline before the reason stored with the status",
      [
        [{ ...trial, status_reason: 'no_baseline', trial: reading }, '第 3 天'],
        [
          { ...trial, trial: { ...reading, baseline_tasks: 0, status_reason: 'no_baseline' } },
          zh('memory.learned.noBaseline'),
        ],
      ],
    ],
    ['says since when an improvement is in force', [[kept, '11月6日起']]],
    [
      'gives the sample of a before/after comparison when the trial kept the improvement',
      [
        [{ ...kept, status_reason: 'trial_passed', trial: sample }, '11月6日起 · 前后对比，n = 10'],
        [{ ...kept, trial: sample }, '11月6日起'],
      ],
    ],
    [
      'says why an improvement was reverted, or only that it was',
      [
        [{ ...reverted, status_reason: 'not_better' }, '撤回：没变好'],
        [{ ...reverted, status_reason: 'insufficient_sample' }, '撤回：任务不够'],
        [reverted, zh('memory.learned.reverted')],
        [{ ...reverted, status_reason: 'no_baseline' }, zh('memory.learned.reverted')],
      ],
    ],
    [
      'says why the screening rejected an experience, and only that the user rejected one',
      [
        [{ ...rejected, status_reason: 'network_access' }, '拒绝：要联网'],
        [{ ...rejected, status_reason: 'credentials' }, '拒绝：涉及凭据'],
        [{ ...rejected, status_reason: 'destructive_command' }, '拒绝：有破坏性命令'],
        [{ ...rejected, status_reason: 'guardrail_relaxation' }, '拒绝：放宽护栏'],
        [{ ...rejected, status_reason: 'duplicate_instruction' }, '拒绝：规则重复'],
        [{ ...rejected, status_reason: 'invalid_reference' }, '拒绝：引用对不上'],
        [rejected, zh('memory.learned.rejected')],
      ],
    ],
    [
      'says why the user rejected a candidate when they gave a reason',
      [
        [{ ...rejected, reject_reason: 'duplicate' }, '拒绝：规则重复'],
        [{ ...rejected, reject_reason: 'not_useful' }, '拒绝：没有用'],
      ],
    ],
  ])('%s', (_name, cases) => {
    for (const [over, text] of cases) expect(statusText(item(over), NOW)).toBe(text);
  });
});
