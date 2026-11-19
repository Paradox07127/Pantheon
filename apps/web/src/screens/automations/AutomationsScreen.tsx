import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDashed,
  CircleDot,
  CircleX,
  MessageCircleQuestion,
  MessageSquare,
  Plus,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { AgentRoutine } from '@pantheon/domain';
import { ROUTINE_TEMPLATES } from '@pantheon/protocol/routine-catalog';
import { Clip } from '../../components/Clip';
import { LoadError } from '../../components/LoadError';
import { Skeleton } from '../../components/Skeleton';
import { toast } from '../../components/Toast';
import { TopBar } from '../../components/TopBar';
import { agentName, showAgentProfile, shownAgents, useAgents } from '../../data/agents';
import {
  useAgentWakes,
  useRoutines,
  type AgentRoutineRow,
  type AgentWake,
} from '../../data/automations';
import { runCommand } from '../../data/commands';
import { ageText, failureText, useNow } from '../../data/needs-you';
import { currentLocale, t } from '../../i18n';
import { SCREEN_NAMES } from '../../screens';
import { useShell } from '../../store';
import { routineDraft, routineInput } from '../sessions/AgentForm';
import './automations.css';

type RunKey = AgentWake['outcome'] | Exclude<AgentWake['state'], 'completed'>;

/** The glyph, its colour and the word of a run, by its outcome once completed, else by its state. */
const RUN_LOOKS: Record<RunKey, { icon: LucideIcon; tone: string; word: () => string }> = {
  nothing: {
    icon: Circle,
    tone: '--idle',
    word: () => t({ id: 'automations.run.nothing', defaultMessage: 'Nothing' }),
  },
  acted: {
    icon: Zap,
    tone: '--tx2',
    word: () => t({ id: 'automations.run.acted', defaultMessage: 'Acted' }),
  },
  told_user: {
    icon: MessageSquare,
    tone: '--tx2',
    word: () => t({ id: 'automations.run.toldUser', defaultMessage: 'Told you' }),
  },
  asked: {
    icon: MessageCircleQuestion,
    tone: '--wait',
    word: () => t({ id: 'automations.run.asked', defaultMessage: 'Asked you' }),
  },
  queued: {
    icon: CircleDashed,
    tone: '--idle',
    word: () => t({ id: 'automations.run.queued', defaultMessage: 'Queued' }),
  },
  running: {
    icon: CircleDot,
    tone: '--run',
    word: () => t({ id: 'automations.run.running', defaultMessage: 'Running' }),
  },
  failed: {
    icon: CircleX,
    tone: '--bad',
    word: () => t({ id: 'automations.run.failed', defaultMessage: 'Failed' }),
  },
  cancelled: {
    icon: Circle,
    tone: '--idle',
    word: () => t({ id: 'automations.run.cancelled', defaultMessage: 'Cancelled' }),
  },
};

const lookOf = (run: Pick<AgentWake, 'state' | 'outcome'>) =>
  RUN_LOOKS[run.state === 'completed' ? run.outcome : run.state];

function runGlyph(run: Pick<AgentWake, 'state' | 'outcome'>) {
  const look = lookOf(run);
  const Icon = look.icon;
  return (
    <Icon
      className="ic-sm au-g"
      role="img"
      aria-label={look.word()}
      style={{ color: `var(${look.tone})` }}
    />
  );
}

/** The catalog names; the ids stay literal so message extraction finds them. */
const TEMPLATE_NAMES: Readonly<Record<string, () => string>> = {
  'bug-hunt': () =>
    t({ id: 'sessions.agents.routineTemplate.bug-hunt', defaultMessage: 'Bug hunt' }),
  'security-scan': () =>
    t({ id: 'sessions.agents.routineTemplate.security-scan', defaultMessage: 'Security scan' }),
  'test-coverage': () =>
    t({ id: 'sessions.agents.routineTemplate.test-coverage', defaultMessage: 'Test coverage' }),
};

/** The catalog title of a routine added from the catalog; null for the user's own. */
function templateTitle(routine: AgentRoutine): string | null {
  // A routine added from the catalog gets an id of its own, so its prompt tells it apart.
  const template = ROUTINE_TEMPLATES.find(
    (each) => each.id === routine.id || each.prompt === routine.prompt,
  );
  return template ? (TEMPLATE_NAMES[template.id]?.() ?? template.title) : null;
}

function scheduleText(routine: AgentRoutine): string {
  if (routine.at !== undefined)
    return t(
      { id: 'automations.schedule.daily', defaultMessage: 'Daily at {time}' },
      { time: routine.at },
    );
  const minutes = Math.round((routine.every_ms ?? 0) / 60_000);
  if (minutes > 0 && minutes % (24 * 60) === 0)
    return t(
      {
        id: 'automations.schedule.days',
        defaultMessage: 'Every {count, plural, one {day} other {# days}}',
      },
      { count: minutes / (24 * 60) },
    );
  if (minutes > 0 && minutes % 60 === 0)
    return t(
      {
        id: 'automations.schedule.hours',
        defaultMessage: 'Every {count, plural, one {hour} other {# hours}}',
      },
      { count: minutes / 60 },
    );
  return t(
    {
      id: 'automations.schedule.minutes',
      defaultMessage: 'Every {count, plural, one {minute} other {# minutes}}',
    },
    { count: minutes },
  );
}

const DAY = 86_400_000;

/** A local time: the bare time today (or "Today" with it), "Tomorrow" or "Yesterday" next to today, else the date. */
function dayTime(at: number, now: number, sayToday: boolean): string {
  const time = new Intl.DateTimeFormat(currentLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
  const days = Math.round(
    (new Date(at).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY,
  );
  if (days === 0)
    return sayToday
      ? t({ id: 'automations.when.today', defaultMessage: 'Today {time}' }, { time })
      : time;
  if (days === 1)
    return t({ id: 'automations.when.tomorrow', defaultMessage: 'Tomorrow {time}' }, { time });
  if (days === -1)
    return t({ id: 'automations.when.yesterday', defaultMessage: 'Yesterday {time}' }, { time });
  return new Intl.DateTimeFormat(currentLocale(), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
}

const keyOf = (row: AgentRoutineRow) => `${row.agent_id}\n${row.routine.id}`;

export function AutomationsScreen({ projectId }: { projectId: string | null }) {
  const routines = useRoutines(projectId);
  const rows = routines.read;
  const agents = useAgents(projectId);
  const now = useNow(30_000);
  // The open row; one at a time, so one routine's wakes are read.
  const [open, setOpen] = useState<string | null>(null);
  const openRow = rows?.find((row) => keyOf(row) === open) ?? null;
  const wakes = useAgentWakes(projectId, openRow?.agent_id ?? null, openRow?.routine.id);
  // The row and button whose command is out.
  const [busy, setBusy] = useState<{ key: string; button: 'run' | 'pause' } | null>(null);
  const [refusal, setRefusal] = useState<{ key: string; text: string } | null>(null);
  const [making, setMaking] = useState<string | null>(null);
  // Turn id to the Assistant session a task was made in, for this screen's life only.
  const [sent, setSent] = useState<Readonly<Record<string, string>>>({});
  const [taskRefusal, setTaskRefusal] = useState<{ turn: string; text: string } | null>(null);
  const { openSession, setScreen } = useShell.getState();

  const nameOf = (routine: AgentRoutine) => templateTitle(routine) ?? routine.prompt;

  const runNow = async (row: AgentRoutineRow) => {
    const key = keyOf(row);
    setRefusal(null);
    setBusy({ key, button: 'run' });
    const result = await runCommand(
      'agent.routine.run',
      { agent_id: row.agent_id, routine_id: row.routine.id },
      null,
    );
    setBusy(null);
    if (!result.ok) return setRefusal({ key, text: failureText(result.error) });
    if ((result.value as { queued?: unknown } | null)?.queued === 'budget')
      setRefusal({
        key,
        text: t({
          id: 'automations.runNow.budget',
          defaultMessage: 'Queued until the project budget is raised or cleared',
        }),
      });
  };

  // agent.update replaces the whole list, so it sends every routine of the row's agent.
  const update = (row: AgentRoutineRow, enabled: boolean, revision: number) =>
    runCommand(
      'agent.update',
      {
        agent_id: row.agent_id,
        revision,
        routines: (rows ?? [])
          .filter((each) => each.agent_id === row.agent_id)
          .map((each) =>
            routineInput(
              routineDraft(
                each.routine.id === row.routine.id ? { ...each.routine, enabled } : each.routine,
              ),
            ),
          ),
      },
      null,
    );

  const pause = async (row: AgentRoutineRow) => {
    const key = keyOf(row);
    const enabled = !row.routine.enabled;
    setRefusal(null);
    setBusy({ key, button: 'pause' });
    const result = await update(row, enabled, row.agent_revision);
    setBusy(null);
    if (!result.ok) return setRefusal({ key, text: failureText(result.error) });
    if (enabled) return;
    const revision = (result.value as { revision?: number } | null)?.revision;
    toast({
      title: t(
        { id: 'automations.paused', defaultMessage: '{routine} paused' },
        { routine: nameOf(row.routine) },
      ),
      ...(revision !== undefined && {
        action: {
          label: t({ id: 'automations.undo', defaultMessage: 'Undo' }),
          run: () =>
            void update(row, true, revision).then(
              (undone) => undone.ok || toast({ title: failureText(undone.error), kind: 'failure' }),
            ),
        },
      }),
    });
  };

  const makeTask = async (run: AgentWake) => {
    setTaskRefusal(null);
    setMaking(run.turn_id);
    const result = await runCommand('agent.wake.to_task', { turn_id: run.turn_id }, null);
    setMaking(null);
    if (!result.ok) return setTaskRefusal({ turn: run.turn_id, text: failureText(result.error) });
    const session = (result.value as { session_id?: unknown } | null)?.session_id;
    if (typeof session === 'string') setSent((was) => ({ ...was, [run.turn_id]: session }));
  };

  const addRoutine = () => {
    const assistant = shownAgents(agents ?? []).find((agent) => agent.template === 'assistant');
    if (!assistant) return;
    showAgentProfile(assistant.id, { addRoutine: true });
    setScreen('sessions');
  };

  const header = (
    <div className="au-row au-hd" role="row">
      <span />
      <span role="columnheader">
        {t({ id: 'automations.column.agent', defaultMessage: 'Agent' })}
      </span>
      <span role="columnheader">
        {t({ id: 'automations.column.routine', defaultMessage: 'Routine' })}
      </span>
      <span role="columnheader">
        {t({ id: 'automations.column.schedule', defaultMessage: 'Schedule' })}
      </span>
      <span role="columnheader">
        {t({ id: 'automations.column.nextRun', defaultMessage: 'Next run' })}
      </span>
      <span role="columnheader">
        {t({ id: 'automations.column.lastRun', defaultMessage: 'Last run' })}
      </span>
      <span />
    </div>
  );
  const tableName = t({
    id: 'automations.table',
    defaultMessage: "Routines of this project's agents",
  });

  const runLine = (run: AgentWake) => {
    const look = lookOf(run);
    const to = sent[run.turn_id];
    const tokens = run.usage?.input_tokens;
    return [
      <div key={run.turn_id} className="au-run">
        {runGlyph(run)}
        <span className="au-num">{dayTime(run.at, now, true)}</span>
        <span className="au-facts">
          <span>{look.word()}</span>
          {run.actions > 0 && (
            <span className="mu">
              {t(
                {
                  id: 'automations.run.actions',
                  defaultMessage: '{count, plural, one {# action} other {# actions}}',
                },
                { count: run.actions },
              )}
            </span>
          )}
          {run.message_ids.length > 0 && (
            <span className="mu">
              {t(
                {
                  id: 'automations.run.messages',
                  defaultMessage: '{count, plural, one {# message} other {# messages}}',
                },
                { count: run.message_ids.length },
              )}
            </span>
          )}
          {run.question_ids.length > 0 && (
            <span className="mu">
              {t(
                {
                  id: 'automations.run.questions',
                  defaultMessage: '{count, plural, one {# question} other {# questions}}',
                },
                { count: run.question_ids.length },
              )}
            </span>
          )}
        </span>
        <span className="au-tok">
          {tokens !== undefined &&
            new Intl.NumberFormat(currentLocale(), {
              notation: 'compact',
              maximumFractionDigits: 1,
            }).format(tokens)}
        </span>
        <span className="au-acts">
          {to ? (
            <>
              <span className="mu">
                {t({ id: 'automations.run.sent', defaultMessage: 'Sent to Assistant' })}
              </span>
              <button type="button" className="btn sm ghost" onClick={() => openSession(to)}>
                {t({ id: 'automations.run.open', defaultMessage: 'Open' })}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn sm"
              disabled={run.state !== 'completed' || making === run.turn_id}
              aria-busy={making === run.turn_id || undefined}
              onClick={() => void makeTask(run)}
            >
              {t({ id: 'automations.run.makeTask', defaultMessage: 'Make a task' })}
            </button>
          )}
        </span>
      </div>,
      taskRefusal?.turn === run.turn_id && (
        <div key={`${run.turn_id}-refusal`} className="au-err" role="alert">
          {taskRefusal.text}
        </div>
      ),
    ];
  };

  const runsOf = (row: AgentRoutineRow, name: string) => {
    const shown = (wakes.data ?? [])
      .filter((run) => run.routine_ids?.includes(row.routine.id))
      .slice(0, 5);
    return (
      <div
        key={`${keyOf(row)}-runs`}
        className="au-sub"
        role="group"
        aria-label={t(
          { id: 'automations.runs', defaultMessage: 'Recent runs of {routine}' },
          { routine: name },
        )}
        aria-busy={(!wakes.data && wakes.loading) || undefined}
      >
        {!wakes.data && wakes.error ? (
          <LoadError message={wakes.error} onRetry={wakes.reload} />
        ) : !wakes.data ? (
          [88, 104, 88].map((width, i) => (
            <div key={i} className="au-run">
              <span />
              <Skeleton style={{ height: 8, width }} />
              <Skeleton style={{ height: 8, width: 2 * width }} />
            </div>
          ))
        ) : shown.length === 0 ? (
          <div className="au-none">
            {t({ id: 'automations.runs.none', defaultMessage: 'No runs yet' })}
          </div>
        ) : (
          shown.flatMap(runLine)
        )}
      </div>
    );
  };

  const rowOf = (row: AgentRoutineRow) => {
    const key = keyOf(row);
    const { routine } = row;
    const title = templateTitle(routine);
    const name = title ?? routine.prompt;
    const opened = open === key;
    const out = busy?.key === key;
    const last = row.last_run;
    return [
      <div key={key} className="au-row" role="row" data-off={!routine.enabled || undefined}>
        <button
          type="button"
          className="ib"
          aria-expanded={opened}
          aria-label={
            opened
              ? t(
                  { id: 'automations.hideRuns', defaultMessage: 'Hide runs of {routine}' },
                  { routine: name },
                )
              : t(
                  { id: 'automations.showRuns', defaultMessage: 'Show runs of {routine}' },
                  { routine: name },
                )
          }
          onClick={() => setOpen(opened ? null : key)}
        >
          {opened ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
        </button>
        <span role="cell">
          <Clip
            text={(() => {
              const agent = agents?.find((each) => each.id === row.agent_id);
              return agent ? agentName(agent) : row.agent_name;
            })()}
          />
        </span>
        <span role="cell" className={title ? 'au-tpl' : undefined}>
          <Clip text={name} />
        </span>
        <span role="cell" className="au-sch">
          <Clip text={scheduleText(routine)} />
          {routine.active_hours && (
            <span className="au-num mu">
              {t(
                { id: 'automations.schedule.activeHours', defaultMessage: '{from} to {to}' },
                routine.active_hours,
              )}
            </span>
          )}
        </span>
        <span role="cell" className="au-num">
          {!routine.enabled
            ? t({ id: 'automations.paused.word', defaultMessage: 'Paused' })
            : row.next_run_at !== undefined && dayTime(row.next_run_at, now, false)}
        </span>
        <span role="cell" className="au-last">
          {last ? (
            <>
              {runGlyph(last)}
              <span>{lookOf(last).word()}</span>
              <span className="au-num mu">{ageText(last.at, now)}</span>
            </>
          ) : (
            <span className="mu">
              {t({ id: 'automations.neverRan', defaultMessage: 'Never ran' })}
            </span>
          )}
        </span>
        <span role="cell" className="au-acts">
          <button
            type="button"
            className="btn sm"
            disabled={
              out || !routine.enabled || last?.state === 'queued' || last?.state === 'running'
            }
            aria-busy={(out && busy?.button === 'run') || undefined}
            onClick={() => void runNow(row)}
          >
            {t({ id: 'automations.runNow', defaultMessage: 'Run now' })}
          </button>
          <button
            type="button"
            className="btn sm ghost"
            disabled={out}
            aria-busy={(out && busy?.button === 'pause') || undefined}
            onClick={() => void pause(row)}
          >
            {routine.enabled
              ? t({ id: 'automations.pause', defaultMessage: 'Pause' })
              : t({ id: 'automations.resume', defaultMessage: 'Resume' })}
          </button>
        </span>
      </div>,
      refusal?.key === key && (
        <div key={`${key}-refusal`} className="au-err" role="alert">
          {refusal.text}
        </div>
      ),
      opened && runsOf(row, name),
    ];
  };

  return (
    <div className="tb-pg">
      <TopBar title={SCREEN_NAMES.automations} count={rows?.length} />
      <main className="au-pg">
        {!rows && routines.error ? (
          <div className="au au-empty">
            <LoadError message={routines.error} onRetry={routines.reload} />
          </div>
        ) : !rows ? (
          <div className="au" role="table" aria-label={tableName} aria-busy>
            {header}
            {[200, 280, 144].map((width, i) => (
              <div key={i} className="au-row">
                <span />
                <Skeleton style={{ height: 8, width: 56 }} />
                <Skeleton style={{ height: 8, width }} />
                <Skeleton style={{ height: 8, width: 96 }} />
                <Skeleton style={{ height: 8, width: 48 }} />
                <Skeleton style={{ height: 8, width: 112 }} />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="au au-empty">
            <span className="au-say">
              {t({
                id: 'automations.empty',
                defaultMessage: 'No agent in this project runs anything on a schedule.',
              })}
            </span>
            <button type="button" className="btn pri" onClick={addRoutine}>
              <Plus aria-hidden="true" />
              {t({ id: 'automations.addRoutine', defaultMessage: 'Add a routine' })}
            </button>
          </div>
        ) : (
          <>
            <div className="au" role="table" aria-label={tableName}>
              {header}
              {rows.flatMap(rowOf)}
            </div>
            {routines.error && <LoadError message={routines.error} onRetry={routines.reload} />}
          </>
        )}
      </main>
    </div>
  );
}
