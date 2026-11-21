import {
  ChartGantt,
  Gauge,
  Hourglass,
  KeyRound,
  Layers,
  ListOrdered,
  MessageSquare,
  ShieldCheck,
  SquareTerminal,
  TriangleAlert,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { RuntimeFinding } from '@pantheon/domain';
import { useBoard } from '../../data/board';
import { currentProject, useCurrentProject } from '../../data/current-project';
import { useSessionTrace } from '../../data/trace';
import { t } from '../../i18n';
import { clockText, durationText } from '../../lib/time-text';
import { useShell } from '../../store';

import './diagnose.css';
import './finding-detail.css';

type Kind = RuntimeFinding['kind'];

const KINDS: Record<Kind, () => string> = {
  turn_queue: () => t({ id: 'trace.diagnose.kind.turnQueue', defaultMessage: 'Long turn queue' }),
  turn_prepare: () =>
    t({ id: 'trace.diagnose.kind.turnPrepare', defaultMessage: 'Slow turn start' }),
  approval: () => t({ id: 'trace.diagnose.kind.approval', defaultMessage: 'Long approval wait' }),
  permission_delivery: () =>
    t({ id: 'trace.diagnose.kind.delivery', defaultMessage: 'Slow approval delivery' }),
  gate: () => t({ id: 'trace.diagnose.kind.gate', defaultMessage: 'Slow gate' }),
  slow_tool: () => t({ id: 'trace.diagnose.kind.slowTool', defaultMessage: 'Slow tool' }),
  tool_failure: () => t({ id: 'trace.diagnose.kind.toolFailure', defaultMessage: 'Tool failure' }),
  turn_failure: () => t({ id: 'trace.diagnose.kind.turnFailure', defaultMessage: 'Turn failure' }),
  background_task: () =>
    t({ id: 'trace.diagnose.kind.background', defaultMessage: 'Background task' }),
  workflow_step: () =>
    t({ id: 'trace.diagnose.kind.workflowStep', defaultMessage: 'Slow workflow step' }),
  context_compaction: () =>
    t({ id: 'trace.diagnose.kind.compaction', defaultMessage: 'Context compaction' }),
};
export const runtimeFindingTitle = (finding: RuntimeFinding) => KINDS[finding.kind]();

export const FINDING_ICONS: Record<Kind, LucideIcon> = {
  turn_queue: ListOrdered,
  turn_prepare: Hourglass,
  approval: KeyRound,
  permission_delivery: KeyRound,
  gate: ShieldCheck,
  slow_tool: SquareTerminal,
  tool_failure: TriangleAlert,
  turn_failure: TriangleAlert,
  background_task: Layers,
  workflow_step: Workflow,
  context_compaction: Gauge,
};

const CATEGORY: Record<NonNullable<RuntimeFinding['tool_category']>, () => string> = {
  shell: () => t({ id: 'trace.diagnose.category.shell', defaultMessage: 'Command' }),
  poll: () => t({ id: 'trace.diagnose.category.poll', defaultMessage: 'Polling' }),
  agent: () => t({ id: 'trace.diagnose.category.agent', defaultMessage: 'Subagent' }),
  edit: () => t({ id: 'trace.diagnose.category.edit', defaultMessage: 'Edit' }),
  read: () => t({ id: 'trace.diagnose.category.read', defaultMessage: 'Read' }),
  other: () => t({ id: 'trace.diagnose.category.other', defaultMessage: 'Other' }),
};

/** Why its turn failed, else the category of its tool. */
export function findingReason(finding: RuntimeFinding): string | null {
  if (finding.error) return finding.error;
  return finding.tool_category ? CATEGORY[finding.tool_category]() : null;
}

const NONE = '—';

// Labels are getters, so each is read in the language loaded by then.
const EVIDENCE_SOURCE: Record<RuntimeFinding['source'], string> = {
  get native() {
    return t({ id: 'trace.diagnose.evidence.native', defaultMessage: 'Native span' });
  },
  get runtime_reported() {
    return t({ id: 'trace.diagnose.evidence.reported', defaultMessage: 'Reported duration' });
  },
  get daemon() {
    return t({ id: 'trace.diagnose.evidence.daemon', defaultMessage: 'Event gap' });
  },
};

function summary(finding: RuntimeFinding, slowToolMs: number | undefined): string {
  const timed =
    finding.duration_ms === undefined
      ? ''
      : t(
          {
            id: 'trace.diagnose.detail.took',
            defaultMessage:
              '{kind, select, approval {Waited {duration} for your approval.} permission_delivery {The decision took {duration} to reach the runtime.} turn_queue {The turn waited {duration} in the queue.} turn_prepare {The turn took {duration} to start.} gate {Gates ran for {duration}.} slow_tool {A tool call ran for {duration}.} tool_failure {A tool call failed after {duration}.} turn_failure {The turn failed after {duration}.} background_task {A background task ran for {duration}.} workflow_step {A workflow step took {duration}.} context_compaction {Compacting the context took {duration}.} other {It took {duration}.}}',
          },
          { kind: finding.kind, duration: durationText(finding.duration_ms) },
        );
  const took =
    timed && finding.kind === 'slow_tool' && slowToolMs !== undefined
      ? t(
          {
            id: 'trace.diagnose.detail.slowFrom',
            defaultMessage: '{took} Anything over {threshold} counts as slow.',
          },
          { took: timed, threshold: durationText(slowToolMs) },
        )
      : timed;
  return t(
    {
      id: 'trace.diagnose.detail.summary',
      defaultMessage:
        '{took}{inferred, select, yes { Its parent call is inferred from timing and may overlap other calls.} other {}}',
    },
    { took, inferred: finding.parent_inferred ? 'yes' : 'no' },
  );
}

/** The finding's turn, numbered from 1 by start among its session's turns; nothing until known. */
function FindingTurn({ lane, turnId }: { lane: string; turnId: string }) {
  const stored = useCurrentProject((s) => s.projectId);
  const projectId = useBoard((s) => currentProject(s.board, stored)?.id ?? null);
  const spans = useSessionTrace(projectId, lane).data?.spans ?? [];
  const turns = spans
    .filter((span) => span.kind === 'turn' && span.parent === null)
    .sort((a, b) => (a.start ?? -Infinity) - (b.start ?? -Infinity));
  const turn = turns.findIndex((span) => span.id === turnId) + 1;
  if (!turn) return null;
  return (
    <span className="fd-turn">
      {t({ id: 'trace.diagnose.detail.turn', defaultMessage: 'Turn {turn}' }, { turn })}
    </span>
  );
}

/** The side panel of the picked finding, right of the findings. */
export function FindingDetail({
  finding,
  title,
  onClose,
  onShowInTimeline,
  slowToolMs,
}: {
  finding: RuntimeFinding;
  /** The title of the finding's session, empty without one. */
  title: string;
  onClose: () => void;
  onShowInTimeline: () => void;
  /** From this long on a tool call counts as slow, ms; the diagnostics' threshold. */
  slowToolMs?: number;
}) {
  const Icon = FINDING_ICONS[finding.kind];
  const lane = finding.lane_key;
  const said = summary(finding, slowToolMs);
  const evidence = finding.evidence ?? [];
  const evidenceLabel = t({ id: 'trace.diagnose.evidence.label', defaultMessage: 'Evidence' });
  const facts: [string, string, boolean][] = [
    [
      t({ id: 'trace.diagnose.detail.start', defaultMessage: 'Start' }),
      finding.started_at === undefined ? NONE : clockText(finding.started_at, { seconds: true }),
      finding.started_at !== undefined,
    ],
    [
      t({ id: 'trace.diagnose.detail.duration', defaultMessage: 'Duration' }),
      finding.duration_ms === undefined ? NONE : durationText(finding.duration_ms),
      false,
    ],
    [
      t({ id: 'trace.diagnose.detail.category', defaultMessage: 'Category' }),
      finding.tool_category ? CATEGORY[finding.tool_category]() : NONE,
      false,
    ],
  ];
  return (
    <aside
      className="fd"
      aria-label={t({ id: 'trace.diagnose.detail.label', defaultMessage: 'Finding detail' })}
    >
      <div className="fd-h">
        <Icon aria-hidden="true" />
        <span className="fd-kind">{runtimeFindingTitle(finding)}</span>
        <span className="fd-ses">{title}</span>
        {lane && finding.turn_id && <FindingTurn lane={lane} turnId={finding.turn_id} />}
        <button
          type="button"
          className="ib fd-close"
          aria-label={t({ id: 'trace.diagnose.detail.close', defaultMessage: 'Close detail' })}
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
      </div>
      {said && <p className="fd-say">{said}</p>}
      <div className="panel fd-facts">
        {facts.map(([label, value, code]) => (
          <div key={label} className="cell">
            <span className="cap">{label}</span>
            <span className="fd-v" data-code={code || undefined}>
              {value}
            </span>
          </div>
        ))}
      </div>
      {evidence.length > 0 && (
        <div className="fd-ev">
          <div className="fd-evh">
            <span className="cap">{evidenceLabel}</span>
            <span className="cap">{evidence.length}</span>
          </div>
          <div className="fd-evs" role="group" aria-label={evidenceLabel}>
            {evidence.map((item, i) => (
              <button
                key={i}
                type="button"
                className="fd-evr"
                disabled={!lane}
                onClick={onShowInTimeline}
              >
                <span>{EVIDENCE_SOURCE[item.source]}</span>
                <span data-code="">{clockText(item.at, { seconds: true })}</span>
                <span className="fd-evid" data-code="">
                  {item.id}
                </span>
                <span className="fd-evd" data-code="">
                  {item.duration_ms === undefined ? '' : durationText(item.duration_ms)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="fd-foot">
        <button type="button" className="btn" disabled={!lane} onClick={onShowInTimeline}>
          <ChartGantt aria-hidden="true" />
          {t({ id: 'trace.diagnose.detail.showInTimeline', defaultMessage: 'Show in timeline' })}
        </button>
        {lane && !lane.startsWith('native:') && (
          <button
            type="button"
            className="btn"
            onClick={() => useShell.getState().openSession(lane)}
          >
            <MessageSquare aria-hidden="true" />
            {t({
              id: 'trace.diagnose.detail.showInThread',
              defaultMessage: 'Show in conversation',
            })}
          </button>
        )}
      </div>
    </aside>
  );
}
