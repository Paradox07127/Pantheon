import { expect, it } from 'vitest';
import type { Session } from '@pantheon/domain';
import { coordinationTools, sessionTools } from '@pantheon/protocol';
import { appDebugSkill, appDiagnoseSkill } from '../../packages/control/src/app-debug-skill.js';
import { baselineSkill } from '../../packages/control/src/baseline-skill.js';
import type { ControlContext } from '../../packages/control/src/context.js';
import { purposeSessionInstructions } from '../../packages/control/src/context.js';
import {
  MEMORY_INSTRUCTIONS,
  MEMORY_READ_INSTRUCTIONS,
} from '../../packages/control/src/memory.js';
import { projectSetupSkill } from '../../packages/control/src/project-setup-skill.js';
import { LEAD_INSTRUCTIONS } from '../../packages/control/src/agent-prompts.js';
import { workerInstructions } from '../../packages/control/src/workbench-session.js';

const known = new Set([
  ...Object.values(sessionTools).flatMap((tools) => Object.keys(tools)),
  ...Object.keys(coordinationTools),
  'project_extensions_inventory',
]);

// A snake_case or dotted name, alone or in a list, right after call, use, "tools are" or "tools and".
const NAME = String.raw`[a-z][a-z0-9]*(?:[_.][a-z0-9]+)+`;
const LIST = new RegExp(
  String.raw`\b(?:call|use|tools? (?:are|and))\s+(${NAME}(?:(?:,\s*|\s+and\s+|\s+or\s+)${NAME})*)`,
  'gi',
);

const toolNames = (text: string) =>
  [...text.matchAll(LIST)].flatMap((match) => match[1]!.split(/,\s*|\s+and\s+|\s+or\s+/));

const ctx = { store: { get: () => undefined } } as unknown as ControlContext;
const task = { lead_session_id: 'lead-1', id: 'task-1' } as NonNullable<Session['task']>;
const purpose = (tag: Partial<Session>) => purposeSessionInstructions(tag as Session, baseline)!;
const baseline = { rounds: 3, visuals: true };

const injected: Record<string, string> = {
  lead: LEAD_INSTRUCTIONS,
  'worker with a question tool': workerInstructions(ctx, task, 'AskUserQuestion'),
  'worker without a question tool': workerInstructions(ctx, task, undefined),
  'baseline with visuals': baselineSkill({ rounds: 3, visuals: true }),
  'baseline without visuals': baselineSkill({ rounds: 3, visuals: false }),
  intro: purpose({ intro: {} as Session['intro'] }),
  'change story': purpose({ change_story: {} as Session['change_story'] }),
  'range story': purpose({ range_story: {} as Session['range_story'] }),
  reviewer: purpose({ review_id: 'review-1' }),
  memory: MEMORY_INSTRUCTIONS,
  'memory without writing': MEMORY_READ_INSTRUCTIONS,
  'app debug': appDebugSkill,
  'app diagnosis': appDiagnoseSkill,
  'project setup': projectSetupSkill,
};

it.each(Object.entries(injected))(
  'names only tools the model is given in the %s instructions',
  (_, text) => {
    for (const name of toolNames(text)) expect(known, name).toContain(name);
  },
);

it('finds the tool names the instructions call', () => {
  const names = Object.values(injected).flatMap(toolNames);
  for (const name of [
    'project_read',
    'ask_user',
    'request_review',
    'memory_propose',
    'project_baseline_submit',
    'review_finding',
    'review_verdict',
    'style_read',
  ])
    expect(names).toContain(name);
});
