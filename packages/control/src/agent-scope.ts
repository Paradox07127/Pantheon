import type { CommandType, QueryMethod } from '@pantheon/protocol';

export interface AgentScopeRow {
  capability: string;
  project_level: string;
  personal_level: string;
  /** The personal-scope queries and commands this row lets a personal principal call. */
  personal_actions: readonly (QueryMethod | CommandType)[];
  /** Commands of this row the command entry refuses a personal principal. */
  never_personal: readonly CommandType[];
}

/** What a project-level and a personal-level agent may see and do; docs/architecture.md repeats it. */
export const AGENT_SCOPE: readonly AgentScopeRow[] = [
  {
    capability: '所有项目的概况',
    project_level: '只看自己的项目',
    personal_level: '读所有项目的概况',
    personal_actions: ['projects.summary'],
    never_personal: [],
  },
  {
    capability: '需要你',
    project_level: '不经这个查询',
    personal_level: '读所有项目里用户看到的条目，不含工具输入原文，条目上的操作都不可用',
    personal_actions: ['needs_you.list'],
    never_personal: [],
  },
  {
    capability: '离开期间简报和已读位置',
    project_level: '不经这两个接口',
    personal_level: '读每个项目的简报，只移动它自己的已读位置',
    personal_actions: ['project.brief', 'project.seen'],
    never_personal: [],
  },
  {
    capability: '替用户做的决定',
    project_level: '不经这个查询',
    personal_level: '读每个项目的记录，不含存储规则原文',
    personal_actions: ['project.decisions'],
    never_personal: [],
  },
  {
    capability: '整份计划',
    project_level: '经 `project_read` 读自己项目的计划',
    personal_level: '不能，`board.view` 被拒',
    personal_actions: [],
    never_personal: [],
  },
  {
    capability: '会话记录',
    project_level: '读自己项目的会话',
    personal_level: '不能',
    personal_actions: [],
    never_personal: [],
  },
  {
    capability: '写计划、派发、开始或停止任务',
    project_level: '对自己项目的计划和任务可以',
    personal_level: '不能',
    personal_actions: [],
    never_personal: ['board.plan.edit', 'task.start'],
  },
  {
    capability: '给项目的助理发请求',
    project_level: '不经这个命令',
    personal_level: '可以，请求算用户原话，回合带 `via` 标记',
    personal_actions: ['request.send'],
    never_personal: [],
  },
  {
    capability: '回答提问、计划变更、里程碑验收',
    project_level: '按章程回答自己 worker 的提问，验收自己的里程碑',
    personal_level:
      '默认都不能，用户在设置里逐类打开；转述的 worker 提问和超预算时的计划变更始终留给用户',
    personal_actions: ['lead.question.answer', 'board.plan.proposal.resolve', 'milestone.accept'],
    never_personal: [],
  },
  {
    capability: '权限请求、建 agent、外部事件开工、预算项',
    project_level: '按章程代批自己 worker 的权限请求，可以提议新建 agent',
    personal_level: '不能，始终留给用户',
    personal_actions: [],
    never_personal: [
      'approval.respond',
      'agent.create',
      'agent.propose',
      'agent.proposal.resolve',
      'external.approve',
      'workflow.policy.set',
    ],
  },
  {
    capability: '记忆和学到的改动',
    project_level: '可以提议',
    personal_level: '不能',
    personal_actions: [],
    never_personal: ['memory.propose', 'improvement.decide'],
  },
  {
    capability: '什么时候醒',
    project_level: '自己项目的备注、例行任务、信号',
    personal_level: '外部个人 agent 由它自己的程序决定什么时候调用',
    personal_actions: [],
    never_personal: [],
  },
  {
    capability: '层级',
    project_level: '常驻 agent 管它的 worker',
    personal_level: '在常驻 agent 旁边，不在常驻和 worker 之间，没有自己的计划',
    personal_actions: [],
    never_personal: [],
  },
];

/** The scope table as the Markdown docs/architecture.md holds between its agent-scope markers. */
export function agentScopeMarkdown(): string {
  const codes = (names: readonly string[]) => names.map((name) => `\`${name}\``).join('、');
  return [
    '| 能力 | 项目级 agent | 个人级 agent | 个人级可用的接口 | 个人级被拒的命令 |',
    '| --- | --- | --- | --- | --- |',
    ...AGENT_SCOPE.map(
      (row) =>
        `| ${row.capability} | ${row.project_level} | ${row.personal_level} | ${codes(row.personal_actions)} | ${codes(row.never_personal)} |`,
    ),
  ].join('\n');
}
