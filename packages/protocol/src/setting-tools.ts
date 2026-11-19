import { z } from 'zod';
import type { AgentToolGroup, SettingParam } from '@pantheon/domain';

const str = z.string().min(1).max(65536);
const charterMode = z.enum(['on', 'ask', 'off']);

/** The values each setting a proposal changes may take. */
export const settingValues = {
  plan_changes: z.enum(['auto', 'confirm']),
  max_parallel: z.number().int().min(1).max(8),
  dispatch_paused: z.boolean(),
  acceptance_wake: z.enum(['each_merge', 'milestone']),
  external_events: z.enum(['off', 'approve', 'auto']),
  'charter.approve_worker_prompts': charterMode,
  'charter.answer_worker_questions': charterMode,
  // The user approves each agent the lead creates.
  'charter.create_agent': z.enum(['ask', 'off']),
  'charter.accept_milestone': charterMode,
  'charter.merge_out_of_scope': charterMode,
} as const satisfies Record<SettingParam, z.ZodType>;

/** The lead tools that propose a setting change, by tool name. */
export const settingTools = {
  propose_setting: 'setting.propose',
} as const satisfies Record<string, string>;

export const settingToolEffects = {
  propose_setting: 'write',
} as const satisfies Record<keyof typeof settingTools, 'read' | 'write' | 'costly'>;

export const settingToolGroups = {
  propose_setting: 'agents',
} as const satisfies Record<keyof typeof settingTools, AgentToolGroup>;

export const settingInputSchemas = {
  /** SettingProposal; puts one project setting change, with the user's words it rests on, on a card the user decides. The Assistant only. */
  'setting.propose': z.strictObject({
    project_id: str,
    param: z
      .enum(Object.keys(settingValues) as [SettingParam, ...SettingParam[]])
      .describe(
        'The setting: plan_changes (auto or confirm), max_parallel (1-8), dispatch_paused (true or false), acceptance_wake (each_merge or milestone), external_events (off, approve or auto), or charter.<power> (on, ask or off; create_agent only ask or off).',
      ),
    value: z
      .union([z.string().max(20), z.number().int(), z.boolean()])
      .describe('The new value of the setting.'),
    quote: z
      .string()
      .min(1)
      .max(2000)
      .describe(
        "The user's words that ask for the change, copied exactly from one of their messages.",
      ),
  }),
  /** SettingProposal; the user only. approve applies the setting as the user would change it, decline turns it down; the Assistant is told either way. */
  'setting.proposal.resolve': z.strictObject({
    proposal_id: str,
    decision: z.enum(['approve', 'decline']),
  }),
} as const satisfies Record<string, z.ZodType>;
