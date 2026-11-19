import { useState, type CSSProperties, type ReactNode } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { BookOpen, Ellipsis, FlaskConical, Gauge, Lightbulb, Pencil } from 'lucide-react';
import type { ApprovalQuestion, Improvement } from '@pantheon/domain';
import type { BoardTaskRung } from '@pantheon/protocol';
import { blocksText, decisionText, primaryAction } from '../data/attention';
import { useBoard } from '../data/board';
import { openPlanMemory } from '../data/memory-view';
import type { PlanProposal } from '../data/plan-edit';
import {
  ageText,
  blockedReasonText,
  failureClassText,
  reasonText,
  resetsText,
  type NeedsYouItem,
} from '../data/needs-you';
import { elapsedText } from '../data/transcript';
import { changeText, sourceText } from '../data/workflow-policy';
import { t } from '../i18n';
import { nextStepText } from '../lib/daemon-text';
import { AcceptDialog } from '../screens/board/Charts';
import {
  needCommand,
  needSession,
  needWhat,
  noVerdict,
  noVerdictKind,
  outOfScopeFiles,
  stripActions,
  type NeedAction,
  type NeedActionKey,
  type NeedItem,
} from '../screens/board/frame-model';
import {
  durationText,
  milestoneCounts,
  type BoardMilestone,
  type BoardTask,
  type RunBoardCommand,
  type SnapshotMilestone,
  type SnapshotSession,
} from '../screens/board/panels-model';
import { STATE, STATUS, StateIcon } from '../screens/board/status';
import { useDialogContent } from '../screens/board/TellLead';
import { ResolveButtons } from '../screens/sessions/parts';
import { openSettingsPage } from '../screens/settings/settings-jump';
import { Clip } from './Clip';
import { changeFrom, LearnedChangeDiff } from './LearnedChangeDiff';
import { Menu, MenuItem } from './Menu';
import { QuestionCard } from './QuestionCard';
import { RuntimeGlyph } from './RuntimeGlyph';
import { GateMark, MergeBlockedGlyph, StateGlyph } from './SessionStateIcon';
import { Tip } from './Tip';
import { toast } from './Toast';
import '../screens/board/overview.css';
import './request-card.css';

/** A milestone waiting for acceptance as the board reads it. */
export interface RequestMilestone {
  milestone: BoardMilestone;
  /** Its snapshot row, which names the revision an acceptance expects; absent until the snapshot has it. */
  stored?: SnapshotMilestone;
  cells: readonly BoardTask[];
  evidence: { ref: string; label: string }[];
}

export interface RequestCardProps {
  item: NeedItem;
  size: 'compact' | 'full';
  /** Who waits: the session's, task's or milestone's title. */
  who: string;
  now: number;
  run: RunBoardCommand;
  onOpenSession: (sessionId: string) => void;
  session?: SnapshotSession;
  /** The lead of the session's task. */
  lead?: SnapshotSession;
  /** The title of the session's plan task. */
  task?: string;
  /** Who acts next on that task. */
  rung?: BoardTaskRung['rung'];
  milestone?: RequestMilestone;
  improvement?: Improvement;
  /** The data is old: commands wait for a refresh, opening a session still works. */
  stale?: boolean;
  /** Shows the card in full elsewhere; the title of a compact card then picks it. */
  onSelect?: () => void;
  selected?: boolean;
  /** Called once a command the card sent was taken, so a list can move on to its next item. */
  onActed?: () => void;
  /** Gets a list row's one action button, which a list moves the focus to. */
  primaryRef?: (el: HTMLButtonElement | null) => void;
  /** Drawn under a compact row's line, after its own facts. */
  sub?: ReactNode;
  /** The title of the milestone the session's task is in. */
  taskMilestone?: string;
  /** The longest wait of the list, the full length of a compact row's wait bar. */
  waitScale?: number;
  /** The lead's proposal a plan proposal row decides, and its change-then-accept editor. */
  proposal?: { view: PlanProposal; edit: (close: () => void) => ReactNode };
}

// The waiting dot stays with approvals and questions; every other kind has its mark from elsewhere.
const MARK: Record<NeedItem['kind'], ReactNode> = {
  'workflow.approval': <span className="ss-dot waiting" aria-hidden="true" />,
  'external.approval': <span className="ss-dot waiting" aria-hidden="true" />,
  'board.lane.approval': <span className="ss-dot waiting" aria-hidden="true" />,
  'agent.proposal': <span className="ss-dot waiting" aria-hidden="true" />,
  'setting.proposal': <span className="ss-dot waiting" aria-hidden="true" />,
  permission: <span className="ss-dot waiting" aria-hidden="true" />,
  'lead.question': <span className="ss-dot waiting" aria-hidden="true" />,
  'session.merge_blocked': <MergeBlockedGlyph />,
  'session.reconciling': <StateGlyph name="reconciling" />,
  'session.gate_failed': <GateMark state="failed" />,
  'session.failed': <StateGlyph name="failed" />,
  'milestone.ready_for_acceptance': <StateIcon state="awaiting_acceptance" />,
  'board.plan.proposal': <Pencil className="ic-sm" aria-hidden="true" />,
  'board.plan.reassessment': <Pencil className="ic-sm" aria-hidden="true" />,
  'workflow.definition.trial': <FlaskConical className="ic-sm" aria-hidden="true" />,
  'improvement.candidate': <Lightbulb className="ic-sm" aria-hidden="true" />,
  'project.over_budget': <Gauge className="ic-sm" aria-hidden="true" />,
  'memory.decision_budget': <BookOpen className="ic-sm" aria-hidden="true" />,
};

const PRIMARY: ReadonlySet<NeedActionKey> = new Set([
  'approve',
  'reply',
  'accept',
  'confirm',
  'merge',
  'merge_out_of_scope',
  'keep',
]);

/** One needs-you item with the buttons that settle it in place; compact in lists, full beside them. */
export function RequestCard({
  item,
  size,
  who,
  now,
  run,
  onOpenSession,
  session,
  lead,
  task,
  rung,
  milestone,
  improvement,
  stale,
  onSelect,
  selected,
  onActed,
  primaryRef,
  sub,
  taskMilestone,
  waitScale,
  proposal,
}: RequestCardProps) {
  const asked = item.kind === 'lead.question' ? item.question : undefined;
  const relayed = asked?.source;
  // A lead's own question is one single choice.
  const questions: readonly ApprovalQuestion[] =
    item.questions ??
    asked?.questions ??
    (asked
      ? [
          {
            question: asked.question,
            header: '',
            multiSelect: false,
            recommended: asked.recommended,
            options: asked.options.map((label) => ({ label, description: '' })),
          },
        ]
      : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A list row's question card opens under the row from its one action.
  const [answering, setAnswering] = useState(false);
  // A plan proposal row's change-then-accept editor opens under the row.
  const [editing, setEditing] = useState(false);
  const accepting = useDialogContent<{ stored: SnapshotMilestone }>();
  // The board that draws the card draws it again on every read, so no subscription is needed.
  const replaced = changeFrom(improvement, useBoard.getState().board?.projects);
  const full = size === 'full';
  const sessionId = needSession(item);
  const actions = stripActions(item, session, lead, rung);
  // A list row marks only its one primary action, and only while the user is on the row.
  const primary = full ? undefined : primaryAction(actions, item.primary);
  const marked = (action: NeedAction) =>
    full ? PRIMARY.has(action.key) : action === primary && !!selected;

  const reasonOf = (action: NeedAction): string | null => {
    const sends = action.key === 'accept' || needCommand(item, action.key, { session, lead });
    if (stale && sends)
      return t({
        id: 'components.requestCard.stale',
        defaultMessage: 'Data is out of date; refresh before acting',
      });
    if (action.key === 'accept' && !action.reason && !milestone?.stored)
      return t({
        id: 'components.requestCard.milestoneNotRead',
        defaultMessage: "This milestone hasn't been read yet",
      });
    return action.reason;
  };
  const press = async (action: NeedAction, answered?: Record<string, string>) => {
    if (reasonOf(action)) return;
    if (action.key === 'accept') {
      if (milestone?.stored) accepting.show({ stored: milestone.stored });
      return;
    }
    if (action.key === 'budget') {
      openSettingsPage(item.project_id, 'projects');
      return;
    }
    if (action.key === 'memory') {
      openPlanMemory(item.project_id);
      return;
    }
    const command = needCommand(item, action.key, { answers: answered, session, lead });
    if (!command) {
      if (sessionId) onOpenSession(sessionId);
      return;
    }
    if (busy) return;
    setBusy(true);
    setError(null);
    const failure = await run(command.type, command.input, command.revision);
    if (!failure) onActed?.();
    // An accepted answer or decision keeps the buttons off until the item leaves.
    if (
      !failure &&
      (command.type === 'approval.respond' ||
        command.type === 'improvement.decide' ||
        command.type === 'workflow.step.decide' ||
        command.type === 'workflow.definition.trial.decide' ||
        command.type === 'lead.question.answer')
    )
      return;
    setBusy(false);
    setError(failure);
  };
  const reply = actions.find((a) => a.key === 'reply');
  const button = (action: NeedAction) => {
    // Opening the card sends nothing; the card's Send says why it cannot.
    const opens = !full && action === reply && questions.length > 0;
    const reason = opens ? null : reasonOf(action);
    const held = !opens && busy && action.key !== 'open';
    const off = held || reason !== null;
    const el = (
      <button
        key={action.key}
        ref={action === primary ? primaryRef : undefined}
        type="button"
        className={marked(action) ? 'btn pri' : 'btn'}
        aria-label={`${action.label} ${who}`}
        aria-disabled={off || undefined}
        aria-busy={held || undefined}
        aria-expanded={opens ? answering : undefined}
        onClick={() => {
          if (opens) setAnswering(!answering);
          else if (!off) void press(action);
        }}
      >
        {action.label}
      </button>
    );
    return reason ? (
      <Tip key={action.key} content={reason}>
        {el}
      </Tip>
    ) : (
      el
    );
  };

  const buttons: ReactNode[] = actions.map((action) => button(action));

  // A task turn the tracker found stalled or looping; the task's lead plan names it.
  const stuck =
    item.reason === 'task_turn_stalled' || item.reason === 'task_turn_looping'
      ? session?.task
      : undefined;
  const interrupt = async () => {
    if (!stuck || busy || stale) return;
    setBusy(true);
    const failure = await run(
      'task.interrupt',
      { project_id: item.project_id, lead_session_id: stuck.lead_session_id, task_id: stuck.id },
      null,
    );
    setBusy(false);
    if (failure) toast({ title: failure, kind: 'failure' });
  };
  const interruptLabel = t({ id: 'components.requestCard.interrupt', defaultMessage: 'Interrupt' });
  const interruptButton = stuck && (
    <button
      key="interrupt"
      type="button"
      className="btn"
      aria-label={`${interruptLabel} ${who}`}
      aria-disabled={busy || stale || undefined}
      aria-busy={busy || undefined}
      onClick={() => void interrupt()}
    >
      {interruptLabel}
    </button>
  );
  const interruptControl =
    interruptButton && stale ? (
      <Tip
        key="interrupt"
        content={t({
          id: 'components.requestCard.stale',
          defaultMessage: 'Data is out of date; refresh before acting',
        })}
      >
        {interruptButton}
      </Tip>
    ) : (
      interruptButton
    );

  const facts = [
    item.resets_at !== undefined && <span key="resets">{resetsText(item.resets_at, now)}</span>,
    item.waited_ms !== undefined && (
      <span key="waited">
        {t(
          { id: 'components.requestCard.waited', defaultMessage: 'Waited {duration}' },
          { duration: durationText(item.waited_ms) },
        )}
      </span>
    ),
    item.escalated && (
      <span key="escalated" className="tr-st wait">
        {t({ id: 'components.requestCard.escalated', defaultMessage: 'Escalated' })}
      </span>
    ),
    item.failure_class && <span key="class">{failureClassText(item.failure_class)}</span>,
    item.blocked?.reason && <span key="blocked">{blockedReasonText(item.blocked.reason)}</span>,
  ].filter(Boolean);
  const factRow = facts.length > 0 && <div className="rq-what">{facts}</div>;

  const merge = session?.merge?.state === 'blocked' ? session.merge : undefined;
  const scoped = outOfScopeFiles(session);
  const files =
    item.kind === 'session.merge_blocked' || item.kind === 'session.gate_failed'
      ? full
        ? (merge?.conflicts ?? [])
        : (scoped ?? [])
      : [];
  const summary = item.kind === 'permission' ? item.binding?.input_summary : undefined;
  const next = nextStepText(item);
  const counts = milestone && milestoneCounts(milestone.milestone);
  const what =
    item.kind === 'improvement.candidate' && improvement
      ? improvement.change.type === 'gate_command'
        ? t(
            {
              id: 'components.requestCard.gateCounts',
              defaultMessage:
                'Gate of {root}: {n, plural, one {# command} other {# commands}} to {m, plural, one {# command} other {# commands}}',
            },
            {
              root: improvement.change.root,
              n: ((replaced as typeof improvement.change.from) ?? []).length,
              m: improvement.change.to.length,
            },
          )
        : changeText(improvement.change)
      : questions.length > 0
        ? questions[0]!.question
        : item.reason === 'task_blocked' && item.blocked
          ? item.blocked.text
          : needWhat(item, session);
  const assumption = asked && (
    <p className="rq-next">
      {t(
        {
          id: 'components.requestCard.assumption',
          defaultMessage: 'Meanwhile the lead assumes: {assumption}',
        },
        { assumption: asked.assumption },
      )}
    </p>
  );

  const age = <span className="rq-age">{ageText(item.created_at, now)}</span>;
  const head = (
    <div className="rq-hd">
      {MARK[item.kind]}
      <h3 className="rq-who" title={who}>
        {who}
      </h3>
      {age}
    </div>
  );

  // Beside a list a relayed question names the session that asked; in a list its row does.
  const deny = actions.find((a) => a.key === 'reject');
  const thread = relayed && actions.find((a) => a.key === 'open');
  const card = reply && questions.length > 0 && (
    <QuestionCard
      draft={relayed?.approval_id ?? asked?.id ?? item.source.id}
      questions={questions}
      label={
        relayed
          ? t(
              {
                id: 'components.requestCard.questionFrom',
                defaultMessage: 'Question from {who}',
              },
              { who },
            )
          : who
      }
      source={
        full &&
        (relayed ? (
          <div className="qc-src">
            {session && <RuntimeGlyph runtime={session.runtime} />}
            <b className="qc-who" title={who}>
              {who}
            </b>
            {task && task !== who && (
              <span className="chip qc-task" title={task}>
                {task}
              </span>
            )}
            <span className="qc-age">
              {t(
                { id: 'components.requestCard.waited', defaultMessage: 'Waited {duration}' },
                { duration: elapsedText(now - item.created_at) },
              )}
            </span>
            {thread && button(thread)}
          </div>
        ) : (
          head
        ))
      }
      note={
        !relayed && (
          <>
            {assumption}
            {factRow}
            {next && <p className="rq-next">{next}</p>}
          </>
        )
      }
      reason={reasonOf(reply)}
      busy={busy}
      // The row shows a list row's failure.
      error={full ? error : null}
      onSend={(answers) => void press(reply, answers)}
      onDeny={deny && (() => void press(deny))}
      actions={
        full &&
        actions.filter((a) => a !== reply && a !== deny && a !== thread).map((a) => button(a))
      }
    />
  );
  if (full && card) return card;

  // A decision without a name of its own goes by the item's reason.
  const kind = noVerdictKind(item) ?? decisionText(item.decision) ?? reasonText(item.reason);
  // Beside its kind label a step without a verdict needs only its title.
  const rowWhat = noVerdict(item) && item.step_title ? item.step_title : what;
  const blocks = blocksText(item.blocks ?? item.unblocks);
  const more = t(
    { id: 'components.requestCard.more', defaultMessage: 'More actions: {name}' },
    { name: who },
  );
  // A plan proposal row is decided in place, so both of its buttons show.
  const plan = item.kind === 'board.plan.proposal' ? proposal : undefined;
  const inline = plan ? actions : primary ? [primary] : [];
  const rest = actions.filter((action) => !inline.includes(action));
  const adjust = t({ id: 'board.plan.proposal.adjust', defaultMessage: 'Change, then accept' });
  const waited = Math.max(0, now - item.created_at);
  const meta = [
    taskMilestone && <span key="milestone">{taskMilestone}</span>,
    plan && (
      <span key="why" className="rq-why">
        <Clip text={plan.view.reason} />
      </span>
    ),
    plan && (
      <span key="ops">
        {t(
          { id: 'board.plan.row.ops', defaultMessage: 'Adds {adds}, removes {removes}' },
          {
            adds: plan.view.ops.filter((op) => op.type === 'add_task').length,
            removes: plan.view.ops.filter((op) => op.type === 'remove_task').length,
          },
        )}
      </span>
    ),
    blocks && (
      <span key="blocks" className="rq-blk">
        {blocks}
      </span>
    ),
  ].filter(Boolean);

  // The row's count of commands hides what each one runs and whether its failure fails the gate.
  const changeDiff = (improvement?.change.type === 'gate_command' ||
    improvement?.change.type === 'worktree_setup') && (
    <LearnedChangeDiff change={improvement.change} from={replaced} />
  );
  const body = full ? (
    <div className="rqf-body">
      <p className="rq-what">{what}</p>
      {summary && (
        <div className="rq-cmd" title={summary}>
          {summary}
        </div>
      )}
      {factRow}
      {milestone && counts && (
        <div className="rq-ms">
          {milestone.cells.length > 0 && (
            <div
              className="bms-cells"
              role="img"
              aria-label={t(
                {
                  id: 'components.requestCard.milestoneCells',
                  defaultMessage:
                    '{done} of {total, plural, one {# planned task} other {# planned tasks}} merged',
                },
                { done: counts.done, total: counts.total },
              )}
              style={{ '--n': milestone.cells.length } as CSSProperties}
            >
              {milestone.cells.map((task) => (
                <Tip
                  key={task.id}
                  content={t(
                    { id: 'components.requestCard.cellTitle', defaultMessage: '{title}, {state}' },
                    {
                      title: task.title,
                      state: task.state ? STATE[task.state].label : STATUS[task.status].label,
                    },
                  )}
                >
                  <span className="bms-cell" data-state={task.state ?? task.status} />
                </Tip>
              ))}
            </div>
          )}
          {milestone.milestone.criteria.length > 0 && (
            <ul
              className="bms-crit"
              aria-label={t({
                id: 'components.requestCard.criteria',
                defaultMessage: 'Acceptance criteria',
              })}
            >
              {milestone.milestone.criteria.map((criterion, index) => (
                <li key={index}>
                  <Clip text={criterion.text} lines={3} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {improvement && (
        <>
          {changeDiff}
          {improvement.change.type === 'experience' && improvement.change.countercondition && (
            <p className="rq-what">
              {t(
                {
                  id: 'components.requestCard.countercondition',
                  defaultMessage: 'Does not apply: {condition}',
                },
                { condition: improvement.change.countercondition },
              )}
            </p>
          )}
          <span className="rq-src">{sourceText(improvement)}</span>
        </>
      )}
      {files.length > 0 && (
        <ul
          className="rq-files"
          aria-label={
            scoped
              ? t(
                  {
                    id: 'components.requestCard.outOfScopeFiles',
                    defaultMessage: 'Files {who} changed out of scope',
                  },
                  { who },
                )
              : t(
                  {
                    id: 'components.requestCard.conflictFiles',
                    defaultMessage: 'Files in conflict for {who}',
                  },
                  { who },
                )
          }
        >
          {files.map((file) => (
            <li key={file}>{file}</li>
          ))}
        </ul>
      )}
      {next && <p className="rq-next">{next}</p>}
      <div className="rq-acts">
        {interruptControl}
        {buttons}
        {item.kind === 'session.reconciling' && (
          <ResolveButtons item={item as NeedsYouItem} title={who} />
        )}
      </div>
    </div>
  ) : (
    <>
      <div className="rq-hd">
        {MARK[item.kind]}
        <div className="rq-main">
          <div className="rq-l1">
            <span className="rq-kind">
              <Clip text={kind} />
            </span>
            <span className="rq-what">
              {summary ? (
                <span className="rq-cmd" title={summary}>
                  {summary}
                </span>
              ) : (
                rowWhat !== kind && <Clip text={rowWhat} />
              )}
              {onSelect ? (
                <Tip content={who}>
                  <button
                    type="button"
                    className="rq-who rq-pick"
                    aria-current={selected || undefined}
                    onClick={onSelect}
                  >
                    {who}
                  </button>
                </Tip>
              ) : (
                <b className="rq-who">
                  <Clip text={who} />
                </b>
              )}
            </span>
          </div>
          {meta.length > 0 && <div className="rq-l2">{meta}</div>}
        </div>
        <span className="rq-wt">
          <span
            className="meter"
            role="img"
            aria-label={t(
              {
                id: 'board.needs.waitBar',
                defaultMessage: 'Waited {duration}, scale 0 to {longest}',
              },
              {
                duration: durationText(waited),
                longest: durationText(Math.max(waited, waitScale ?? 0)),
              },
            )}
            style={
              {
                '--v': `${waitScale ? Math.min(100, (waited / waitScale) * 100) : 100}%`,
                '--c': 'var(--wait)',
              } as CSSProperties
            }
          >
            <i />
          </span>
          {age}
        </span>
        <span className="rq-acts">
          {inline.map((action) => button(action))}
          {plan && (
            <Tip content={adjust}>
              <button
                type="button"
                className="ib"
                aria-label={`${adjust} ${who}`}
                aria-expanded={editing}
                onClick={() => setEditing(!editing)}
              >
                <Pencil aria-hidden="true" />
              </button>
            </Tip>
          )}
          {(rest.length > 0 || stuck) && (
            <Menu
              label={who}
              side="bottom"
              align="end"
              trigger={
                <button type="button" className="ib" aria-label={more}>
                  <Ellipsis aria-hidden="true" />
                </button>
              }
            >
              {stuck && (
                <MenuItem disabled={busy || !!stale} onClick={() => void interrupt()}>
                  {interruptLabel}
                </MenuItem>
              )}
              {rest.map((action) => (
                <MenuItem
                  key={action.key}
                  disabled={(busy && action.key !== 'open') || reasonOf(action) !== null}
                  onClick={() => void press(action)}
                >
                  {action.label}
                </MenuItem>
              ))}
            </Menu>
          )}
        </span>
      </div>
      <div className="rq-sub">
        {!card && factRow}
        {files.length > 0 && (
          <ul
            className="rq-files"
            aria-label={t(
              {
                id: 'components.requestCard.outOfScopeFiles',
                defaultMessage: 'Files {who} changed out of scope',
              },
              { who },
            )}
          >
            {files.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        )}
        {item.kind === 'session.reconciling' && (
          <ResolveButtons item={item as NeedsYouItem} title={who} />
        )}
        {changeDiff}
        {answering && card}
        {plan && editing && plan.edit(() => setEditing(false))}
        {sub}
      </div>
    </>
  );

  return (
    <article
      className={full ? 'rqf' : 'rq'}
      aria-label={who}
      data-on={(selected && !full) || undefined}
    >
      {full && head}
      {body}
      {error && (
        <span className="tr-err rq-err" role="alert">
          {error}
        </span>
      )}
      {item.kind === 'milestone.ready_for_acceptance' && milestone && (
        <Dialog.Root {...accepting.root}>
          {accepting.content && (
            <AcceptDialog
              key={accepting.content.stored.id}
              // A dialog stays open across snapshot refreshes; it gets the row as it is now.
              stored={
                milestone.stored?.id === accepting.content.stored.id
                  ? milestone.stored
                  : accepting.content.stored
              }
              evidence={milestone.evidence}
              run={run}
              onClose={accepting.close}
            />
          )}
        </Dialog.Root>
      )}
    </article>
  );
}
