import type { SettingProposal } from '@pantheon/domain';
import { resolvedPath, userOnly, type ControlContext } from './context.js';
import { action, type NeedsYouDraft, type NeedsYouScope } from './needs-you.js';

export const SETTING_PROPOSALS = 'setting_change_proposals';

export type ProposedSetting = Pick<SettingProposal, 'command' | 'input'>;

/** The gate root the input names; undefined for the other commands. */
export const gateRoot = ({ command, input }: ProposedSetting) =>
  command === 'project.gate.set' ? resolvedPath(input.root as string) : undefined;

/** The value the input sets, in the fields its proposal's before holds. */
export function settingAfter({ command, input }: ProposedSetting): Record<string, unknown> {
  const { project_id: _project, ...fields } = input;
  if (command === 'project.gate.set') {
    const { root: _root, ...rest } = fields;
    return rest;
  }
  if (command === 'project.sessionDefaults.set') return { session_defaults: fields };
  if (command === 'project.extensions.set') return { overrides: fields.overrides };
  return fields;
}

/** Settings changes main agents proposed that wait for the user. */
export function settingProposalItems(ctx: ControlContext, scope: NeedsYouScope): NeedsYouDraft[] {
  const { principal, listedProject } = scope;
  return ctx.store
    .list<SettingProposal>(SETTING_PROPOSALS)
    .filter((row) => row.state === 'pending' && listedProject(row.project_id))
    .map((row): NeedsYouDraft => {
      const respond = action('setting.proposal.respond', () => userOnly(principal));
      const root = gateRoot(row);
      const runtime =
        row.command === 'project.extensions.set' ? (row.input.runtime as string) : undefined;
      return {
        source: { table: SETTING_PROPOSALS, id: row.id, revision: row.revision },
        kind: 'setting.proposed',
        project_id: row.project_id,
        session_id: row.session_id,
        status: row.state,
        created_at: row.created_at,
        reason: 'setting_proposed',
        decision: 'other',
        primary: 'setting.proposal.respond',
        actions: [
          { ...respond, decision: 'approve' },
          { ...respond, decision: 'reject' },
        ],
        setting: {
          command: row.command,
          ...(root ? { root } : {}),
          ...(runtime ? { runtime } : {}),
          before: row.before,
          after: settingAfter(row),
          reason: row.reason,
        },
      };
    });
}
