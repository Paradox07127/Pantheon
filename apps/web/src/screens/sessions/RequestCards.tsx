import { useEffect, useRef, useState, type RefObject } from 'react';
import { Collapsible } from '@base-ui/react/collapsible';
import { ChevronRight } from 'lucide-react';
import { Markdown } from '../../components/Markdown';
import { QuestionCard } from '../../components/QuestionCard';
import { StateGlyph } from '../../components/SessionStateIcon';
import { Tip } from '../../components/Tip';
import { useBaselineRead } from '../../data/baseline-read';
import { runCommand } from '../../data/commands';
import { useDrafts } from '../../data/drafts';
import { focusRequest, useWantedRequest } from '../../data/focus-request';
import { failureText, reasonText, type NeedsYouState } from '../../data/needs-you';
import { isTruncated, toolLabel } from '../../data/tool-calls';
import type { RequestItem, Session } from '../../data/transcript';
import { t } from '../../i18n';
import { ReviewBaseline } from '../projects/BaselineBlocks';
import type { PendingPermission } from './model';
import { AnsweredRequest, json } from './parts';
import { fail } from './shared';
import { clockText } from '../../lib/time-text';
import './requests.css';

/** The waiting status mark at the start of a request card. */
const WaitMark = () => (
  <span
    className="rq-wait"
    role="img"
    aria-label={t({ id: 'sessions.card.waiting', defaultMessage: 'Waiting for you' })}
  />
);

/** The session's baseline awaiting confirmation, reviewed at the end of its thread. */
export function BaselineReview({ session }: { session: Session }) {
  const { read: baseline } = useBaselineRead(session.baseline ? session.project_id : null);
  if (!baseline || baseline.id !== session.baseline?.baseline_id) return null;
  if (baseline.state !== 'submitted') return null;
  return <ReviewBaseline key={baseline.id} baseline={baseline} />;
}

/** Brings the first question still unanswered in the thread into view and focuses its first control. */
export function jumpToQuestion(scroller: HTMLElement | null) {
  const question = scroller?.querySelector<HTMLElement>('[data-open]');
  if (!question) return;
  question.scrollIntoView({ block: 'start' });
  question.querySelector<HTMLElement>('button, input, textarea')?.focus();
}

/** How many questions of the pending requests have no answer yet. */
function useOpenQuestions(pending: readonly PendingPermission[]): number {
  const drafts = useDrafts((s) => s.answers);
  return pending.reduce((sum, p) => {
    if (p.tool !== 'AskUserQuestion' || !p.questions) return sum;
    const answers = drafts[p.id];
    return (
      sum +
      p.questions.filter((_, i) => !answers?.typed[i]?.trim() && !answers?.picked[i]?.length).length
    );
  }, 0);
}

/** Above the composer while the thread holds questions to answer: jumps to the first of them. */
export function PendingQuestions({
  pending,
  scroller,
}: {
  pending: readonly PendingPermission[];
  scroller: RefObject<HTMLElement | null>;
}) {
  const count = useOpenQuestions(pending);
  if (count === 0) return null;
  return (
    <button type="button" className="btn rq-jump" onClick={() => jumpToQuestion(scroller.current)}>
      <StateGlyph name="question" />
      {t(
        {
          id: 'sessions.card.pendingQuestions',
          defaultMessage:
            '{count, plural, one {# question to answer} other {# questions to answer}}',
        },
        { count },
      )}
    </button>
  );
}

export function RequestCard({
  permission,
  needs,
  input,
  folders,
}: {
  permission: PendingPermission;
  needs: NeedsYouState;
  input?: unknown;
  folders?: readonly string[] | undefined;
}) {
  return permission.tool === 'AskUserQuestion' && permission.questions ? (
    <QuestionRequest permission={permission} needs={needs} />
  ) : permission.tool === 'ExitPlanMode' ? (
    <PlanCard permission={permission} needs={needs} input={input} />
  ) : (
    <PermissionCard permission={permission} needs={needs} input={input} folders={folders} />
  );
}

/**
 * A request in its place in the thread: its card while it waits, folding into its result row once
 * answered. A request answered before the slot mounted shows the row alone.
 */
export function RequestSlot(props: {
  item: RequestItem;
  permission?: PendingPermission | undefined;
  needs: NeedsYouState;
  folders: readonly string[];
  enter: string;
}) {
  const { item } = props;
  const answered = item.outcome !== undefined;
  // The answered request has left the pending list; its card folds with what it last showed.
  const shown = useRef(props.permission);
  if (props.permission) shown.current = props.permission;
  const card = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (answered && card.current?.contains(document.activeElement)) row.current?.focus();
  }, [answered]);
  const wanted = useWantedRequest();
  const id = shown.current?.id;
  useEffect(() => {
    if (!id || wanted !== id) return;
    focusRequest(null);
    if (answered) return;
    card.current?.scrollIntoView({ block: 'center' });
    card.current?.querySelector<HTMLElement>('.rq-btns button, .qc-opt, .qc-f button')?.focus();
  }, [wanted, id, answered]);
  const permission = shown.current;
  if (!permission)
    return answered ? (
      <AnsweredRequest item={item} folders={props.folders} enter={props.enter} />
    ) : null;
  return (
    <Collapsible.Root className={`ss-req${props.enter}`} open={!answered}>
      <Collapsible.Panel className="ss-cfold" ref={card}>
        {/* A new approval under the same request starts with fresh answers and buttons. */}
        <RequestCard
          key={permission.id}
          permission={permission}
          needs={props.needs}
          input={item.input}
          folders={props.folders}
        />
      </Collapsible.Panel>
      {answered && <AnsweredRequest item={item} folders={props.folders} rowRef={row} />}
    </Collapsible.Root>
  );
}

type RespondInput = {
  decision: 'approve' | 'approve_session' | 'approve_project' | 'reject';
  reason?: string;
  answers?: Record<string, string>;
};

/** The needs-you item of a pending request and an approval.respond call bound to it. */
function useApprovalRespond(permission: PendingPermission, needs: NeedsYouState) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Items kept after a failed read are no authority for an answer.
  const item = needs.error
    ? undefined
    : needs.items?.find((i) => i.source.table === 'approvals' && i.source.id === permission.id);
  const action = item?.actions.find((a) => a.command === 'approval.respond');
  const reason =
    action && !action.allowed
      ? action.disabled_reason
        ? reasonText(action.disabled_reason)
        : t({ id: 'sessions.parts.noReason', defaultMessage: 'The backend gave no reason' })
      : null;

  async function respond(input: RespondInput) {
    if (busy || reason) return;
    setBusy(true);
    setError(null);
    const result = await runCommand(
      'approval.respond',
      { approval_id: permission.id, ...input },
      item?.source.revision ?? permission.revision,
    ).catch(fail);
    // An accepted answer keeps the buttons off until the card folds away.
    if (result.ok) return;
    setBusy(false);
    setError(failureText(result.error));
  }

  return { item, reason, busy, error, respond };
}

export function PermissionCard({
  permission,
  needs,
  input,
  folders = [],
}: {
  permission: PendingPermission;
  needs: NeedsYouState;
  /** The full input of the request, from its transcript item. */
  input?: unknown;
  /** The session's folders, which the shown path is relative to. */
  folders?: readonly string[] | undefined;
}) {
  const { item, reason, busy, error, respond } = useApprovalRespond(permission, needs);
  const [denying, setDenying] = useState(false);
  const [why, setWhy] = useState('');
  const tool =
    permission.tool ||
    item?.binding?.action ||
    t({ id: 'sessions.parts.tool', defaultMessage: 'Tool' });
  const summary = item?.binding?.input_summary;
  const rule = permission.rule ?? item?.binding?.rule;
  // A question request lands here only when its questions could not be read; the daemon approves
  // it only with answers, which this card cannot collect.
  const approvable = permission.tool !== 'AskUserQuestion';
  // The daemon cuts a summary to 300 characters, ending it with an ellipsis.
  const cut =
    input !== undefined ? isTruncated(input) : summary?.length === 300 && summary.endsWith('…');
  const off = busy || reason !== null;
  // Approving needs to show what would run: the input, or at least the needs-you summary.
  const unidentified = input === undefined && !item;
  const what =
    tool === 'Bash' ||
    tool === 'commandExecution' ||
    tool === 'local_shell_call' ||
    tool === 'shell'
      ? t({ id: 'sessions.card.runCommand', defaultMessage: 'Run a command' })
      : tool === 'Edit' ||
          tool === 'MultiEdit' ||
          tool === 'Write' ||
          tool === 'NotebookEdit' ||
          tool === 'fileChange'
        ? t({ id: 'sessions.card.editFile', defaultMessage: 'Edit a file' })
        : tool === 'Read'
          ? t({ id: 'sessions.card.readFile', defaultMessage: 'Read a file' })
          : tool;
  const target = (input !== undefined && toolLabel(tool, input, folders).detail) || summary;
  const deny = () => {
    const text = why.trim();
    void respond({ decision: 'reject', ...(text ? { reason: text } : {}) });
  };

  const button = (label: string, onClick: () => void, look = 'btn', approve = false) => {
    const disabled = off || (approve && unidentified);
    const el = (
      <button
        type="button"
        className={look}
        aria-disabled={disabled || undefined}
        aria-label={`${label} ${tool}`}
        onClick={() => {
          if (!disabled) onClick();
        }}
      >
        {label}
      </button>
    );
    return reason ? <Tip content={reason}>{el}</Tip> : el;
  };

  return (
    <Collapsible.Root
      className="rq-card"
      role="group"
      aria-label={t(
        { id: 'sessions.card.permissionRequest', defaultMessage: 'Permission request {tool}' },
        { tool },
      )}
    >
      <div className="rq-line">
        <WaitMark />
        <span className="rq-title">{what}</span>
        {input !== undefined ? (
          <Tip content={target ?? ''} disabled={!target}>
            <Collapsible.Trigger
              className="rq-obj"
              aria-label={t({ id: 'sessions.parts.input', defaultMessage: 'Input' })}
            >
              {target && <span className="rq-objt">{target}</span>}
              <ChevronRight className="rq-chev" aria-hidden="true" />
            </Collapsible.Trigger>
          </Tip>
        ) : (
          summary && (
            <span className="rq-obj" title={summary}>
              <span className="rq-objt">{summary}</span>
            </span>
          )
        )}
        {cut && (
          <span className="tr-cut">
            {t({ id: 'sessions.parts.truncated', defaultMessage: 'Truncated' })}
          </span>
        )}
        {item && <span className="rq-at">{clockText(item.created_at)}</span>}
      </div>
      {input !== undefined && (
        <Collapsible.Panel className="rq-in">
          <pre
            className="tr-pre"
            aria-label={t({ id: 'sessions.parts.input', defaultMessage: 'Input' })}
          >
            {json(input)}
          </pre>
        </Collapsible.Panel>
      )}
      <div className="rq-line">
        {rule && (
          <span className="rq-note" title={rule}>
            {rule}
          </span>
        )}
        <div className="rq-btns">
          {approvable &&
            button(
              t({ id: 'sessions.card.allowOnce', defaultMessage: 'Allow once' }),
              () => void respond({ decision: 'approve' }),
              'btn pri',
              true,
            )}
          {approvable &&
            rule &&
            button(
              t({ id: 'sessions.card.allowSession', defaultMessage: 'Allow for this session' }),
              () => void respond({ decision: 'approve_session' }),
              'btn',
              true,
            )}
          {approvable &&
            item?.binding?.project_rule_supported === true &&
            button(
              t({
                id: 'sessions.card.allowProject',
                defaultMessage: 'Always allow for this project',
              }),
              () => void respond({ decision: 'approve_project' }),
              'btn',
              true,
            )}
          {button(
            t({ id: 'sessions.card.deny', defaultMessage: 'Deny' }),
            () => setDenying(true),
            'btn ghost',
          )}
        </div>
      </div>
      {denying && (
        <div className="rq-line">
          <input
            className="rq-field"
            aria-label={t({ id: 'sessions.card.denyReason', defaultMessage: 'Reason for denying' })}
            placeholder={t({
              id: 'sessions.card.denyReasonPlaceholder',
              defaultMessage: 'Reason (optional)',
            })}
            maxLength={300}
            value={why}
            autoFocus
            onChange={(e) => setWhy(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
              e.preventDefault();
              if (!off) deny();
            }}
          />
          {button(t({ id: 'sessions.card.confirmDeny', defaultMessage: 'Confirm denial' }), deny)}
        </div>
      )}
      {error && (
        <span className="tr-err" role="alert">
          {error}
        </span>
      )}
    </Collapsible.Root>
  );
}

/** An ExitPlanMode request: the plan, approved to start the work or sent back with a note. */
export function PlanCard({
  permission,
  needs,
  input,
}: {
  permission: PendingPermission;
  needs: NeedsYouState;
  /** The full input of the request, from its transcript item. */
  input?: unknown;
}) {
  const { item, reason, busy, error, respond } = useApprovalRespond(permission, needs);
  const [revising, setRevising] = useState(false);
  const [why, setWhy] = useState('');
  const given = input && typeof input === 'object' ? (input as { plan?: unknown }).plan : undefined;
  const plan = typeof given === 'string' ? given : item?.binding?.input_summary;
  const off = busy || reason !== null;
  const title = t({ id: 'sessions.card.plan', defaultMessage: 'Plan' });
  const keepPlanning = () => {
    const text = why.trim();
    void respond({ decision: 'reject', ...(text ? { reason: text } : {}) });
  };

  const button = (label: string, onClick: () => void, pri = false, approve = false) => {
    // Approving needs the plan on the card.
    const disabled = off || (approve && !plan);
    const el = (
      <button
        type="button"
        className={pri ? 'btn pri' : 'btn'}
        aria-disabled={disabled || undefined}
        onClick={() => {
          if (!disabled) onClick();
        }}
      >
        {label}
      </button>
    );
    return reason ? <Tip content={reason}>{el}</Tip> : el;
  };

  return (
    <div className="rq-card" role="group" aria-label={title}>
      <div className="rq-line">
        <WaitMark />
        <span className="rq-title">{title}</span>
        {input !== undefined && isTruncated(input) && (
          <span className="tr-cut">
            {t({ id: 'sessions.parts.truncated', defaultMessage: 'Truncated' })}
          </span>
        )}
      </div>
      {plan && (
        <div className="ss-plan">
          <Markdown text={plan} />
        </div>
      )}
      <div className="rq-line">
        <div className="rq-btns">
          {button(
            t({ id: 'sessions.card.approvePlan', defaultMessage: 'Approve' }),
            () => void respond({ decision: 'approve' }),
            true,
            true,
          )}
          {button(t({ id: 'sessions.card.keepPlanning', defaultMessage: 'Keep planning' }), () =>
            setRevising(true),
          )}
        </div>
      </div>
      {revising && (
        <div className="rq-line">
          <input
            className="rq-field"
            aria-label={t({
              id: 'sessions.card.planFeedback',
              defaultMessage: 'What to change in the plan',
            })}
            maxLength={300}
            value={why}
            autoFocus
            onChange={(e) => setWhy(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
              e.preventDefault();
              if (!off) keepPlanning();
            }}
          />
          {button(t({ id: 'sessions.composer.send', defaultMessage: 'Send' }), keepPlanning)}
        </div>
      )}
      {error && (
        <span className="tr-err" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** An AskUserQuestion request, answered or denied in the thread. */
export function QuestionRequest({
  permission,
  needs,
}: {
  permission: PendingPermission;
  needs: NeedsYouState;
}) {
  const { reason, busy, error, respond } = useApprovalRespond(permission, needs);
  return (
    <QuestionCard
      draft={permission.id}
      questions={permission.questions ?? []}
      label={t({ id: 'sessions.card.question', defaultMessage: 'Question' })}
      reason={reason}
      busy={busy}
      error={error}
      onSend={(answers) => void respond({ decision: 'approve', answers })}
      onDeny={() => void respond({ decision: 'reject' })}
    />
  );
}
