import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import type { BoardModel } from '@pantheon/protocol';
import { t } from '../../i18n';
import type { ReplaySpeed } from '../trace/model';
import { ReplayBar, ReplaySpeedControl, SCRUB_MAX, useTraceReplay } from '../trace/Replay';
import { Empty } from './Charts';
import type { FlowGroup } from './flow-layout';
import { flowReplay, momentAt, statusesAt, type FlowReplay } from './flow-replay';
import { FlowChart } from './FlowPanel';
import { dayText } from '../../lib/time-text';
import type { TaskDrawerProps } from './TaskDrawer';
import { isPlanTask } from './view-rules';
import { TaskFocus, type EvidenceTab } from './TaskFocus';

const GROUPS: { key: FlowGroup; label: string }[] = [
  {
    key: 'lane',
    get label() {
      return t({ id: 'board.canvas.group.lane', defaultMessage: 'Lane' });
    },
  },
  {
    key: 'kind',
    get label() {
      return t({ id: 'board.canvas.group.kind', defaultMessage: 'Type' });
    },
  },
  {
    key: 'state',
    get label() {
      return t({ id: 'board.canvas.group.state', defaultMessage: 'State' });
    },
  },
  {
    key: 'model',
    get label() {
      return t({ id: 'board.canvas.group.model', defaultMessage: 'Model' });
    },
  },
];
const GROUPS_KEY = 'pantheon.board-group.v1';

function storedGroups(): Record<string, FlowGroup> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(GROUPS_KEY) ?? '{}');
    if (!raw || typeof raw !== 'object') return {};
    return Object.fromEntries(
      Object.entries(raw).filter(([, v]) => GROUPS.some((group) => group.key === v)),
    );
  } catch {
    return {};
  }
}

// The grouping picked on each project's board while the app runs.
let picked: Readonly<Record<string, FlowGroup>> = {};
const pickListeners = new Set<() => void>();
const subscribePicked = (listener: () => void) => {
  pickListeners.add(listener);
  return () => void pickListeners.delete(listener);
};

function pickGroup(projectId: string, group: FlowGroup) {
  picked = { ...picked, [projectId]: group };
  pickListeners.forEach((listener) => listener());
  try {
    localStorage.setItem(GROUPS_KEY, JSON.stringify({ ...storedGroups(), [projectId]: group }));
  } catch {
    // The choice still holds until the app closes.
  }
}

function useGroup(projectId: string | undefined): FlowGroup {
  const read = () =>
    projectId ? (picked[projectId] ?? storedGroups()[projectId] ?? 'lane') : 'lane';
  return useSyncExternalStore(subscribePicked, read, read);
}

/** The board bar's grouping of the project's flow chart: by lane, type, state or model. */
export function FlowGroupControl({ projectId }: { projectId: string }) {
  const group = useGroup(projectId);
  return (
    <RadioGroup<FlowGroup>
      className="tb-seg"
      aria-label={t({ id: 'board.canvas.group.label', defaultMessage: 'Group by' })}
      value={group}
      onValueChange={(value) => pickGroup(projectId, value)}
    >
      {GROUPS.map((g) => (
        <Radio.Root key={g.key} value={g.key}>
          {g.label}
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}

/** Within this many pixels of a mark, the scrubber lands on the mark. */
const MARK_HIT = 4;

/**
 * The replay bar under the chart. It hands up the newest status change at the playhead, null at
 * now; a playing frame writes the playhead to the bar only, so the chart redraws once per change.
 */
function FlowReplayer({
  flow,
  onMoment,
}: {
  flow: FlowReplay;
  onMoment: (moment: number | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [speed, setSpeed] = useState<ReplaySpeed>(1);
  const full = useMemo(() => ({ from: flow.from, to: flow.to }), [flow.from, flow.to]);
  const steps = useMemo(() => flow.marks.map((mark) => mark.at), [flow.marks]);
  const replay = useTraceReplay(flow.axis, full, full, host, speed, steps);
  useEffect(() => {
    // While playing, replay.time stays at the start; the playhead is where the last frame left it.
    const share = replay.playing && host.current?.style.getPropertyValue('--ph');
    const time = share ? flow.axis.time(Number(share)) : replay.time;
    onMoment(time === null ? null : momentAt(flow, time));
    if (!replay.playing) return;
    let frame = requestAnimationFrame(function tick() {
      const share = host.current?.style.getPropertyValue('--ph');
      if (share) onMoment(momentAt(flow, flow.axis.time(Number(share))));
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [replay.playing, replay.time, flow, onMoment]);
  useEffect(() => () => onMoment(null), [onMoment]);

  const replaying = replay.time !== null;
  const { now } = replay;
  useEffect(() => {
    if (!replaying) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      now();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [replaying, now]);

  // A press on a mark lands on its time, so the chart shows what the mark marks.
  const seek = (value: number) => {
    const width = replay.scrub.current?.clientWidth ?? 0;
    const near = (at: number) => Math.abs(flow.axis.position(at) * SCRUB_MAX - value);
    const mark = steps.reduce<number | null>(
      (best, at) => (best === null || near(at) < near(best) ? at : best),
      null,
    );
    replay.seek(
      mark !== null && (near(mark) * width) / SCRUB_MAX <= MARK_HIT
        ? flow.axis.position(mark) * SCRUB_MAX
        : value,
    );
  };

  return (
    <div ref={host} className="bd-rp">
      <ReplayBar
        replay={{ ...replay, seek }}
        axis={flow.axis}
        view={full}
        full={full}
        marks={flow.marks}
        live={t(
          { id: 'board.canvas.replay.range', defaultMessage: '{from} to {to}' },
          {
            from: dayText(flow.from, flow.to, { time: true }),
            to: dayText(flow.to, flow.to, { time: true }),
          },
        )}
        end={<ReplaySpeedControl speed={speed} onSpeed={setSpeed} />}
      />
    </div>
  );
}

/** Whether the main view draws a chart to group: the model holds plan tasks. */
export const hasPlanTasks = (model: BoardModel) => model.tasks.some(isPlanTask);

interface MainViewProps {
  model: BoardModel;
  /** Keys the grouping picked by hand; without it the tasks band by lane. */
  projectId?: string;
  /** The task whose drawer is open; null when none is. */
  selected: string | null;
  onSelect: (taskId: string | null) => void;
  onOpenSession: (sessionId: string) => void;
  onOpenEvidence?: (sessionId: string, tab: EvidenceTab) => void;
  onStartTask?: (task: BoardModel['tasks'][number]) => void;
  tell?: TaskDrawerProps['tell'];
  /** The board is in edit mode: changes on the chart go into the draft. */
  editing?: boolean;
  onAskNeed?: (key: string) => void;
}

/** The plan as one flow chart, banded the way the user picked in the board bar. */
export function MainView({
  model,
  projectId,
  selected,
  onSelect,
  onOpenSession,
  onOpenEvidence,
  onStartTask,
  tell,
  editing,
  onAskNeed,
}: MainViewProps) {
  const group = useGroup(projectId);
  const plan = useMemo(() => ({ ...model, tasks: model.tasks.filter(isPlanTask) }), [model]);
  const onlyAdhoc = plan.tasks.length === 0;
  const flow = useMemo(() => flowReplay(plan.tasks, plan.now), [plan]);
  // The newest status change at the replay's playhead; null at now.
  const [moment, setMoment] = useState<number | null>(null);
  const states = useMemo(
    () => (flow && moment !== null ? statusesAt(plan.tasks, moment) : undefined),
    [flow, moment, plan],
  );
  // At a past moment the chart stacks, bands and counts the tasks by that moment's statuses, as
  // their states and claims back then are not recorded.
  const shown = useMemo(
    () =>
      states
        ? {
            ...plan,
            tasks: plan.tasks.map(({ state, claim, ...task }) => ({
              ...task,
              status: states.get(task.id) ?? task.status,
            })),
          }
        : plan,
    [plan, states],
  );

  return (
    <section
      className="bd-pn bd-s12 bd-flow bd-main"
      data-debug-region="board.flow"
      aria-label={t({ id: 'board.plan.view.main', defaultMessage: 'Main view' })}
    >
      {onlyAdhoc ? (
        <Empty text={t({ id: 'board.plan.view.empty', defaultMessage: 'No plan tasks yet' })} />
      ) : (
        <>
          <FlowChart
            model={shown}
            group={group}
            selected={selected}
            onSelect={onSelect}
            tell={tell}
            editing={editing}
            states={states}
            onAskNeed={onAskNeed}
          />
          {flow && <FlowReplayer flow={flow} onMoment={setMoment} />}
        </>
      )}
      {/* The focus tells the task as it is now; an open drawer already does. */}
      {!states && !selected && (
        <TaskFocus
          model={model}
          onSelect={onSelect}
          onOpenSession={onOpenSession}
          onOpenEvidence={onOpenEvidence}
          onStartTask={onStartTask}
        />
      )}
    </section>
  );
}
