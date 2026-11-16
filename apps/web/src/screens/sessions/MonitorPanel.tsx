import { useState } from 'react';
import { Bot, SquareTerminal, Workflow, type LucideIcon } from 'lucide-react';
import type { SessionTask } from '@pantheon/domain';
import { agentTypeName } from '../../components/AgentTypeIcon';
import { useBoard } from '../../data/board';
import { useNow } from '../../data/needs-you';
import { useSessionTasks } from '../../data/session-tasks';
import { elapsedText, type ToolState } from '../../data/transcript';
import { t } from '../../i18n';
import { useShell } from '../../store';
import { readFailed } from './shared';
import { TaskRow } from './TaskRow';
import { EmptyState } from '../../components/EmptyState';
import './monitor.css';

const NO_TASKS: readonly SessionTask[] = [];

const STATE: Record<SessionTask['state'], ToolState> = {
  running: 'running',
  completed: 'ok',
  failed: 'failed',
  stopped: 'none',
};

// Names are getters, so each is read in the language loaded by then.
const KIND: Record<SessionTask['kind'], { icon?: LucideIcon; name: string }> = {
  agent: {
    icon: Bot,
    get name() {
      return t({ id: 'sessions.panel.monitor.agent', defaultMessage: 'Agent' });
    },
  },
  shell: {
    icon: SquareTerminal,
    get name() {
      return t({ id: 'sessions.panel.monitor.shell', defaultMessage: 'Shell' });
    },
  },
  workflow: {
    icon: Workflow,
    get name() {
      return t({ id: 'sessions.panel.monitor.workflow', defaultMessage: 'Workflow' });
    },
  },
  other: {
    get name() {
      return t({ id: 'sessions.panel.monitor.other', defaultMessage: 'Task' });
    },
  },
};

/** The session's agent and background tasks, the running ones first. */
export function MonitorPanel({ sessionId }: { sessionId: string }) {
  const read = useSessionTasks(sessionId);
  const runtime = useBoard((s) => s.board?.sessions.find((k) => k.id === sessionId)?.runtime ?? '');
  const now = useNow();
  // Finished tasks the user cleared from view; tasks that finish later still show.
  const [cleared, setCleared] = useState<ReadonlySet<string>>(new Set());
  const tasks = read.data?.tasks ?? NO_TASKS;
  const running = tasks.filter((task) => task.state === 'running');
  const finished = tasks.filter((task) => task.state !== 'running' && !cleared.has(task.id));
  const row = (task: SessionTask) => {
    const kind = KIND[task.kind];
    const type = task.kind === 'agent' ? (task.agent_type ?? null) : null;
    const ms =
      task.state === 'running'
        ? now - task.started_at
        : (task.usage?.duration_ms ?? (task.ended_at ?? now) - task.started_at);
    return (
      <TaskRow
        key={task.id}
        runtime={runtime}
        type={type}
        icon={kind.icon}
        name={type ? agentTypeName(type) : kind.name}
        description={task.description}
        state={STATE[task.state]}
        elapsed={elapsedText(ms)}
        usage={task.usage}
        detail={task.summary ?? task.last_tool}
        open={false}
      />
    );
  };
  const group = (name: string, shown: readonly SessionTask[]) =>
    shown.length > 0 && (
      <section className="ss-fan" aria-label={name}>
        <div className="ss-fanh">
          <span className="ss-fant">{name}</span>
          <span className="ss-fanc">{shown.length}</span>
        </div>
        {shown.map(row)}
      </section>
    );
  return (
    <div className="ss-mon">
      {readFailed(read)}
      {read.data && running.length === 0 && finished.length === 0 && (
        <EmptyState
          inline
          title={t({
            id: 'sessions.panel.monitor.empty',
            defaultMessage: 'No agent or background command is running in this session.',
          })}
        />
      )}
      {group(t({ id: 'sessions.panel.monitor.runningGroup', defaultMessage: 'Running' }), running)}
      {group(
        t({ id: 'sessions.panel.monitor.finishedGroup', defaultMessage: 'Finished' }),
        finished,
      )}
      <div className="ss-monf">
        <button
          type="button"
          className="btn sm"
          onClick={() => useShell.getState().showRuns(sessionId)}
        >
          {t({ id: 'sessions.panel.monitor.openRuns', defaultMessage: 'Open in Runs' })}
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={finished.length === 0}
          onClick={() =>
            setCleared((before) => new Set([...before, ...finished.map((task) => task.id)]))
          }
        >
          {t({ id: 'sessions.panel.monitor.clearFinished', defaultMessage: 'Clear finished' })}
        </button>
      </div>
    </div>
  );
}
