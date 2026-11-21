import { expect, it } from 'vitest';
import type { Session } from '@pantheon/domain';
import { coordinationTools, sessionTools } from '@pantheon/protocol';
import { baselineSkill } from '../../packages/control/src/baseline-skill.js';
import { purposeSessionInstructions } from '../../packages/control/src/context.js';
import {
  MEMORY_INSTRUCTIONS,
  MEMORY_READ_INSTRUCTIONS,
} from '../../packages/control/src/memory.js';
import { projectSetupSkill } from '../../packages/control/src/project-setup-skill.js';
import { CONDUCTOR_INSTRUCTIONS } from '../../packages/control/src/conductor.js';

const known = new Set([
  ...Object.values(sessionTools).flatMap((tools) => Object.keys(tools)),
  ...Object.keys(coordinationTools),
]);

// A snake_case or dotted name, alone or in a list, right after call, use, "tools are" or "tools and".
const NAME = String.raw`[a-z][a-z0-9]*(?:[_.][a-z0-9]+)+`;
const LIST = new RegExp(
  String.raw`\b(?:call|use|tools? (?:are|and))\s+(${NAME}(?:(?:,\s*|\s+and\s+|\s+or\s+)${NAME})*)`,
  'gi',
);

const toolNames = (text: string) =>
  [...text.matchAll(LIST)].flatMap((match) => match[1]!.split(/,\s*|\s+and\s+|\s+or\s+/));

const purpose = (tag: Partial<Session>) => purposeSessionInstructions(tag as Session)!;

const injected: Record<string, string> = {
  conductor: CONDUCTOR_INSTRUCTIONS,
  baseline: baselineSkill,
  intro: purpose({ intro: {} as Session['intro'] }),
  'change story': purpose({ change_story: {} as Session['change_story'] }),
  reviewer: purpose({ review_id: 'review-1' }),
  memory: MEMORY_INSTRUCTIONS,
  'memory without writing': MEMORY_READ_INSTRUCTIONS,
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
    'memory_propose',
    'project_baseline_submit',
    'review_finding',
    'review_verdict',
  ])
    expect(names).toContain(name);
});
