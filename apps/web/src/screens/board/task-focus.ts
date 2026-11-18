import type { BoardModel } from '@pantheon/protocol';
import { t } from '../../i18n';
import { blockerTexts, nextStepText } from '../../lib/daemon-text';
import { boardNeeds, needSession, needWhat } from './frame-model';

type Task = BoardModel['tasks'][number];

export function taskFocus(model: BoardModel, selected: string | null) {
  const needs = boardNeeds(model);
  const taskOf = (need: (typeof needs)[number]) => {
    const sessionId = needSession(need);
    return model.tasks.find(
      (task) =>
        task.id === need.task_id ||
        (sessionId !== null && task.segments.some((segment) => segment.session_id === sessionId)),
    );
  };
  // The needs strip already tells the tasks it asks about.
  const asked = new Set(needs.map((need) => taskOf(need)?.id));
  const unasked = model.tasks.filter((task) => !asked.has(task.id));
  const progressed = (task: Task) => Math.max(task.ended_at ?? 0, task.last_progress_at ?? 0);
  const latestFinished = unasked.reduce<Task | undefined>(
    (latest, task) => (!latest || progressed(task) > progressed(latest) ? task : latest),
    undefined,
  );
  const task =
    model.tasks.find((task) => task.id === selected) ??
    unasked.find(
      (task) => task.blockers.length || task.status === 'failed' || task.status === 'waiting',
    ) ??
    unasked.find((task) => task.status === 'ready') ??
    unasked.find((task) => task.status !== 'done' && task.status !== 'discarded') ??
    latestFinished;
  if (!task) return null;
  const need = needs.find((need) => taskOf(need)?.id === task.id);
  const upstream = model.edges
    .filter((edge) => edge.to === task.id && edge.state !== 'met')
    .flatMap((edge) => model.tasks.find((task) => task.id === edge.from) ?? []);
  const sessionId = task.evidence?.session_id ?? task.segments.at(-1)?.session_id ?? null;
  const reason = need
    ? needWhat(need)
    : (blockerTexts(task)[0] ??
      task.activity?.waiting?.summary ??
      task.activity?.turn_error ??
      (upstream.length
        ? t(
            {
              id: 'board.task.focus.reasonUpstream',
              defaultMessage: 'Dependency “{title}” is not finished',
            },
            { title: upstream[0]!.title },
          )
        : task.status === 'failed'
          ? t({ id: 'board.task.focus.reasonFailed', defaultMessage: 'Run failed' })
          : task.activity?.health === 'stalled'
            ? t({ id: 'board.task.focus.reasonStalled', defaultMessage: 'No progress for a while' })
            : task.status === 'ready'
              ? t({
                  id: 'board.task.focus.reasonReady',
                  defaultMessage: 'Output awaits your check',
                })
              : task.status === 'idle'
                ? t({
                    id: 'board.task.focus.reasonIdle',
                    defaultMessage: 'Waiting for the next instruction',
                  })
                : t({
                    id: 'board.task.focus.reasonNone',
                    defaultMessage: 'Nothing is blocking it',
                  })));
  const next =
    (need && nextStepText(need)) ??
    (upstream.length
      ? t(
          {
            id: 'board.task.focus.nextUpstream',
            defaultMessage: 'Handle dependency “{title}” first',
          },
          { title: upstream[0]!.title },
        )
      : task.status === 'failed'
        ? t({
            id: 'board.task.focus.nextFailed',
            defaultMessage: 'Look at the failure evidence, add instructions and retry',
          })
        : task.status === 'waiting'
          ? t({
              id: 'board.task.focus.nextWaiting',
              defaultMessage: 'Open the session to approve or answer',
            })
          : task.status === 'ready'
            ? t({
                id: 'board.task.focus.nextReady',
                defaultMessage:
                  'Check the gates, the review and the change evidence, then decide whether to merge',
              })
            : task.status === 'todo'
              ? task.activity?.phase === 'queued'
                ? t({
                    id: 'board.task.focus.nextQueued',
                    defaultMessage: 'Wait for dispatch; see why it is queued',
                  })
                : t({ id: 'board.task.focus.nextStart', defaultMessage: 'Start the task' })
              : task.status === 'running'
                ? t({
                    id: 'board.task.focus.nextRunning',
                    defaultMessage: 'Follow the current turn and handle requests as they come',
                  })
                : task.status === 'done'
                  ? t({
                      id: 'board.task.focus.nextDone',
                      defaultMessage: 'See the evidence for the finished output',
                    })
                  : task.status === 'discarded'
                    ? t({
                        id: 'board.task.focus.nextDiscarded',
                        defaultMessage: 'See the record of the discarded task',
                      })
                    : t({
                        id: 'board.task.focus.nextCheck',
                        defaultMessage:
                          'Check the output, then accept it or send more instructions to the lead',
                      }));
  return { task, need, upstream, sessionId, reason, next };
}
