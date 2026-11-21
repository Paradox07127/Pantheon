import { useState, type CSSProperties, type ReactNode } from 'react';
import { BookOpen, Clock, Ellipsis, Gauge, Pause, Pencil } from 'lucide-react';
import type { ApprovalQuestion } from '@pantheon/domain';
import type { BoardTaskRung } from '@pantheon/protocol';
import { blocksText, decisionText, primaryAction } from '../data/attention';
import { openPlanMemory } from '../data/memory-view';
import {
  ageText,
  blockedReasonText,
  failureClassText,
  reasonText,
  resetsText,
  type NeedsYouItem,
} from '../data/needs-you';
import { elapsedText } from '../data/transcript';
import { t } from '../i18n';
import { nextStepText } from '../lib/daemon-text';
import {
  needCommand,
  needSession,
  needWhat,
  outOfScopeFiles,
  stripActions,
  type NeedAction,
  type NeedActionKey,
  type NeedItem,
} from '../data/need-actions';
import { durationText } from '../lib/time-text';
import { type RunBoardCommand, type SnapshotSession } from '../lib/snapshot-types';
import { ResolveButtons } from '../screens/sessions/parts';
import { openSettingsPage } from '../screens/settings/settings-jump';
import { Clip } from './Clip';
import { Menu, MenuItem } from './Menu';
import { QuestionCard } from './QuestionCard';
import { RuntimeGlyph } from './RuntimeGlyph';
import { GateMark, MergeBlockedGlyph, StateGlyph } from './SessionStateIcon';
import { Tip } from './Tip';
import { toast } from './Toast';
import './request-card.css';

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
}

// The waiting dot stays with approvals and questions; every other kind has its mark from elsewhere.
// The proposal kinds the interface does not offer have none.
const MARK: Partial<Record<NeedItem['kind'], ReactNode>> = {
  'external.approval': <span className="ss-dot waiting" aria-hidden="true" />,
  'board.lane.approval': <span className="ss-dot waiting" aria-hidden="true" />,
  permission: <span className="ss-dot waiting" aria-hidden="true" />,
  'lead.question': <span className="ss-dot waiting" aria-hidden="true" />,
  'session.merge_blocked': <MergeBlockedGlyph />,
  'session.reconciling': <StateGlyph name="reconciling" />,
  'session.gate_failed': <GateMark state="failed" />,
  'session.failed': <StateGlyph name="failed" />,
  'board.plan.proposal': <Pencil className="ic-sm" aria-hidden="true" />,
  'board.plan.reassessment': <Pause className="ic-sm" aria-hidden="true" />,
  'project.over_budget': <Gauge className="ic-sm" aria-hidden="true" />,
  'memory.decision_budget': <BookOpen className="ic-sm" aria-hidden="true" />,
};

const PRIMARY: ReadonlySet<NeedActionKey> = new Set([
  'approve',
  'reply',
  'accept',
  'merge',
  'merge_out_of_scope',
  'resume',
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
  stale,
  onSelect,
  selected,
  onActed,
  primaryRef,
  sub,
  taskMilestone,
  waitScale,
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
  const full = size === 'full';
  const sessionId = needSession(item);
  const actions = stripActions(item, session, lead, rung);
  // A list row marks only its one primary action, and only while the user is on the row.
  const primary = full ? undefined : primaryAction(actions, item.primary);
  const marked = (action: NeedAction) =>
    full ? PRIMARY.has(action.key) : action === primary && !!selected;

  const reasonOf = (action: NeedAction): string | null => {
    const sends = needCommand(item, action.key, { session, lead });
    if (stale && sends)
      return t({
        id: 'components.requestCard.stale',
        defaultMessage: 'Data is out of date; refresh before acting',
      });
    return action.reason;
  };
  const press = async (action: NeedAction, answered?: Record<string, string>) => {
    if (reasonOf(action)) return;
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
        command.type === 'lead.question.answer' ||
        command.type === 'board.plan.resume')
    )
      return;
    setBusy(false);
    setError(failure);
  };
  // A question's deadline goes once the user keeps it open; it waits like the others then.
  const keepOpen = async () => {
    if (!asked || busy || stale) return;
    setBusy(true);
    setError(null);
    const failure = await run(
      'lead.question.keep_open',
      { project_id: item.project_id, lead_session_id: item.session_id, question_id: asked.id },
      null,
    );
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
  const what =
    questions.length > 0
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
  const keepLabel = t({ id: 'components.requestCard.keepOpen', defaultMessage: 'Keep open' });
  const deadline = asked && item.default_at !== undefined && (
    <div className="rq-dl">
      <Clock className="ic-sm" aria-hidden="true" />
      <span>
        {t(
          {
            id: 'components.requestCard.defaultAt',
            defaultMessage: 'Recommended answer takes effect in {duration}',
          },
          { duration: durationText(Math.max(0, item.default_at - now)) },
        )}
      </span>
      <button
        type="button"
        className="btn sm"
        aria-disabled={busy || stale || undefined}
        aria-busy={busy || undefined}
        onClick={() => void keepOpen()}
      >
        {keepLabel}
      </button>
    </div>
  );
  const reassessment = item.kind === 'board.plan.reassessment' ? item.reassessment : undefined;
  const detail = (
    <>
      {reassessment && (
        <div
          className="rq-ra"
          role="group"
          aria-label={t({
            id: 'components.requestCard.reassessment',
            defaultMessage: 'Reassessment from lead',
          })}
        >
          {(
            [
              [
                t({ id: 'components.requestCard.reassessment.done', defaultMessage: 'Done' }),
                reassessment.done,
              ],
              [
                t({ id: 'components.requestCard.reassessment.blocked', defaultMessage: 'Blocked' }),
                reassessment.blocked,
              ],
              [
                t({
                  id: 'components.requestCard.reassessment.change',
                  defaultMessage: 'Would change',
                }),
                reassessment.change,
              ],
            ] as const
          ).map(([caption, words]) => (
            <div key={caption}>
              <span className="cap">{caption}</span>
              <span>{words}</span>
            </div>
          ))}
        </div>
      )}
    </>
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
            {full && deadline}
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
  const kind =
    item.kind === 'board.plan.reassessment'
      ? t({ id: 'components.requestCard.planPaused', defaultMessage: 'Plan paused' })
      : (decisionText(item.decision) ?? reasonText(item.reason));
  // Beside its kind label a paused plan needs only its name.
  const rowWhat = item.kind === 'board.plan.reassessment' ? kind : what;
  const blocks = blocksText(item.blocks ?? item.unblocks);
  const more = t(
    { id: 'components.requestCard.more', defaultMessage: 'More actions: {name}' },
    { name: who },
  );
  const inline = primary ? [primary] : [];
  const rest = actions.filter((action) => !inline.includes(action));
  const waited = Math.max(0, now - item.created_at);
  const meta = [
    taskMilestone && <span key="milestone">{taskMilestone}</span>,
    blocks && (
      <span key="blocks" className="rq-blk">
        {blocks}
      </span>
    ),
  ].filter(Boolean);

  const body = full ? (
    <div className="rqf-body">
      <p className="rq-what">{what}</p>
      {summary && (
        <div className="rq-cmd" title={summary}>
          {summary}
        </div>
      )}
      {factRow}
      {detail}
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
        {detail}
        {deadline}
        {answering && card}
        {sub}
      </div>
    </>
  );

  return (
    <article
      className={full ? 'rqf' : 'rq'}
      aria-label={
        item.kind === 'board.plan.reassessment'
          ? t(
              { id: 'components.requestCard.pausedLabel', defaultMessage: 'Plan paused: {plan}' },
              { plan: who },
            )
          : who
      }
      data-on={(selected && !full) || undefined}
    >
      {full && head}
      {body}
      {error && (
        <span className="tr-err rq-err" role="alert">
          {error}
        </span>
      )}
    </article>
  );
}
