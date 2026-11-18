import { requireThat } from '@pantheon/domain';
import { APP_HELP_USER_ONLY, appHelpGroups } from './app-help.generated.js';

export interface AppHelpGroup {
  group: string;
  /** The first sentence of each documented command of the group. */
  about: string;
  /** tool is the session tool that sends the command, or APP_HELP_USER_ONLY; role names a session other than the lead that has it. */
  commands: { type: string; about?: string; tool: string; role?: string }[];
}

/** The screens of the app where the user does what no lead tool does. */
export const APP_SCREENS: { screen: string; holds: string }[] = [
  {
    screen: 'Sessions',
    holds:
      'the conversations of the project: new sessions, sending, approvals and questions, the files, terminal, browser and gate results of a session, merging, discarding and rolling back',
  },
  {
    screen: 'Board',
    holds:
      'the plan of the resident leads: lanes, tasks, milestones, risks and assumptions, plan proposals and edits to approve, progress charts, the project introduction and baseline',
  },
  {
    screen: 'Trace',
    holds: 'the recorded events of the sessions, step replay, review records and runtime analysis',
  },
  {
    screen: 'Insights',
    holds: 'the project digest, iterations, collaboration and workflow results',
  },
  {
    screen: 'Settings',
    holds:
      'app and project settings: connections, runtimes, devices, permissions, gates, workflow, routing, worktrees, extensions, notifications, appearance and usage',
  },
];

export type AppHelp =
  | { groups: string[]; screens: string[] }
  | { group: string; about: string; commands: AppHelpGroup['commands'] };

/** The group index and the screens without a topic; one group's commands with one. */
export function appHelp(topic?: string): AppHelp {
  if (topic === undefined)
    return {
      groups: appHelpGroups.map(({ group, about, commands }) => {
        const leadTools = [
          ...new Set(
            commands.flatMap((c) => (c.tool === APP_HELP_USER_ONLY || c.role ? [] : [c.tool])),
          ),
        ];
        return `${group}: ${about || commands.map((c) => c.type).join(', ')} (lead tools: ${leadTools.join(', ') || 'none'})`;
      }),
      screens: APP_SCREENS.map(({ screen, holds }) => `${screen}: ${holds}`),
    };
  const entry = appHelpGroups.find(({ group }) => group === topic.trim().split('.')[0]);
  requireThat(
    entry,
    'invalid_input',
    `No command group ${topic}; groups: ${appHelpGroups.map(({ group }) => group).join(', ')}`,
  );
  return entry;
}
