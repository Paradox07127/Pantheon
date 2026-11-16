import { describe, expect, it } from 'vitest';
import type { Improvement } from '@pantheon/domain';
import { learnedEffect } from '@/screens/memory/learned-effect';
import { zh } from './i18n-setup.js';

const experience = (
  scope: Partial<Extract<Improvement['change'], { type: 'experience' }>> = {},
): Improvement['change'] => ({ type: 'experience', procedure: 'Run the webhook tests', ...scope });
const policy = (
  param: Extract<Improvement['change'], { type: 'policy_change' }>['param'],
  from: unknown,
  to: unknown,
  tier?: 't1' | 't2' | 't3',
): Improvement['change'] => ({ type: 'policy_change', param, from, to, ...(tier && { tier }) });

describe('where a learned improvement takes effect', () => {
  it('says which sessions an experience goes to once its trial starts', () => {
    expect(
      learnedEffect({
        status: 'candidate',
        change: experience({ domain: 'backend-logic', tier: 't2', runtime: 'codex' }),
      }),
    ).toEqual({
      label: zh('memory.learnedDetail.effect.injectLabel'),
      text: '开始试用后，后端逻辑 T2 的 Codex 会话每轮发送前，上下文预算放得下时会带上这条，标为试用。',
    });
  });

  it('marks an experience on trial and drops the mark once it is in force', () => {
    expect(learnedEffect({ status: 'trial', change: experience({ runtime: 'claude' }) }).text).toBe(
      'Claude 会话每轮发送前，上下文预算放得下时会带上这条，标为试用。',
    );
    expect(learnedEffect({ status: 'active', change: experience({ domain: 'review' }) }).text).toBe(
      '审查任务的会话每轮发送前，上下文预算放得下时会带上这条。',
    );
    expect(learnedEffect({ status: 'active', change: experience() }).text).toBe(
      '所有会话每轮发送前，上下文预算放得下时会带上这条。',
    );
  });

  it('conditions an experience in use on the context budget it has to fit', () => {
    for (const status of ['candidate', 'trial', 'active'] as const)
      expect(learnedEffect({ status, change: experience() }).text).toContain('上下文预算放得下时');
  });

  it('says a reverted or rejected experience goes to no session', () => {
    for (const status of ['reverted', 'rejected'] as const)
      expect(learnedEffect({ status, change: experience() }).text).toBe(
        zh('memory.learnedDetail.effect.experienceEnded'),
      );
  });

  it('says how a policy change applies, by its parameter', () => {
    expect(learnedEffect({ status: 'trial', change: policy('max_parallel', 3, 4) })).toEqual({
      label: zh('memory.learnedDetail.effect.applyLabel'),
      text: '改的是流程参数，不注入会话；派发新任务会话时按 4 个并发算。',
    });
    expect(learnedEffect({ status: 'active', change: policy('handback_limit', 3, 2) }).text).toBe(
      '改的是流程参数，不注入会话；同一个问题最多交回 2 次。',
    );
    expect(
      learnedEffect({ status: 'active', change: policy('path', 'dispatch', 'direct', 't1') }).text,
    ).toBe('改的是流程参数，不注入会话；T1 任务按「主会话直接做」走。');
    expect(
      learnedEffect({
        status: 'trial',
        change: policy('acceptance_wake', 'each_merge', 'milestone'),
      }).text,
    ).toBe('改的是流程参数，不注入会话；验收改在里程碑结束后。');
  });

  it.each([
    [
      'says a policy change waits for its trial while it is a candidate',
      'candidate',
      policy('max_parallel', 3, 4),
      '改的是流程参数，不注入会话；开始试用后，派发新任务会话时按 4 个并发算。',
    ],
    [
      'falls back to the change itself for a parameter without its own sentence',
      'active',
      policy('budget', { input_tokens: 1 }, { input_tokens: 2 }),
      '改的是流程参数，不注入会话；任务预算从 {"input_tokens":1} 改成 {"input_tokens":2}。',
    ],
    [
      'says a reverted policy change has no effect now',
      'reverted',
      policy('max_parallel', 3, 4),
      zh('memory.learnedDetail.effect.policyEnded'),
    ],
  ] as const)('%s', (_name, status, change, text) => {
    expect(learnedEffect({ status, change }).text).toBe(text);
  });
});
