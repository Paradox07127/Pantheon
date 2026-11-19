import { useRef, useState, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Flag,
  FlaskConical,
  MessageSquare,
  ShieldCheck,
  TriangleAlert,
  X,
} from 'lucide-react';
import { Menu, MenuItem, MenuSeparator } from '../../components/Menu';
import { runtimeName } from '../../components/RuntimeGlyph';
import { SessionStateIcon, StateGlyph } from '../../components/SessionStateIcon';
import { shortId } from '../../data/format';
import { runLearnedAction, type LearnedAction, type LearnedItem } from '../../data/learned';
import { DOMAIN_LABEL, tierText, useImprovementSessions } from '../../data/workflow-policy';
import { useSessionList } from '../../data/workbench-sessions';
import { t } from '../../i18n';
import { dayText } from '../../lib/time-text';
import { useShell } from '../../store';
import { GROUP_GLYPH, GROUP_LABEL, kindText, tasksText, verdictText } from './LearnedList';
import '../../components/button-busy.css';
import '../../components/learned-change-diff.css';
import './memory-learned-detail.css';

export interface LearnedDetailProps {
  projectId: string;
  item: LearnedItem;
  onClose: () => void;
  onOpenRetro: (retrospectiveId: string) => void;
}

type RejectReason = 'duplicate' | 'not_useful';

const GRADE: Record<LearnedItem['grade'], () => string> = {
  auto: () => t({ id: 'memory.learnedDetail.grade.auto', defaultMessage: 'Applied at once' }),
  trial: () => t({ id: 'memory.learnedDetail.grade.trial', defaultMessage: 'On trial first' }),
  confirm: () => t({ id: 'memory.learnedDetail.grade.confirm', defaultMessage: 'Waits for you' }),
};

/** The button text of each action, and what its failure says. */
const ACTIONS: Record<string, { label: () => string; failed: (error: string) => string }> = {
  'improvement.decide confirm': {
    label: () => t({ id: 'memory.learnedDetail.confirm', defaultMessage: 'Confirm' }),
    failed: (error) =>
      t(
        { id: 'memory.learnedDetail.failed.confirm', defaultMessage: 'Couldn’t confirm: {error}' },
        { error },
      ),
  },
  'improvement.decide reject': {
    label: () => t({ id: 'memory.learnedDetail.reject', defaultMessage: 'Reject' }),
    failed: (error) =>
      t(
        { id: 'memory.learnedDetail.failed.reject', defaultMessage: 'Couldn’t reject: {error}' },
        { error },
      ),
  },
  'improvement.decide revert': {
    label: () => t({ id: 'memory.learnedDetail.revert', defaultMessage: 'Revert' }),
    failed: (error) =>
      t(
        { id: 'memory.learnedDetail.failed.revert', defaultMessage: 'Couldn’t revert: {error}' },
        { error },
      ),
  },
  'improvement.decide pin': {
    label: () => t({ id: 'memory.learnedDetail.pin', defaultMessage: 'Pin' }),
    failed: (error) =>
      t(
        { id: 'memory.learnedDetail.failed.pin', defaultMessage: 'Couldn’t pin: {error}' },
        { error },
      ),
  },
  'agent.proposal.resolve create': {
    label: () => t({ id: 'memory.learnedDetail.apply', defaultMessage: 'Apply' }),
    failed: (error) =>
      t(
        { id: 'memory.learnedDetail.failed.apply', defaultMessage: 'Couldn’t apply: {error}' },
        { error },
      ),
  },
  'agent.proposal.resolve decline': {
    label: () => t({ id: 'memory.learnedDetail.decline', defaultMessage: 'Decline' }),
    failed: (error) =>
      t(
        { id: 'memory.learnedDetail.failed.decline', defaultMessage: 'Couldn’t decline: {error}' },
        { error },
      ),
  },
  'workflow.definition.trial.decide keep': {
    label: () => t({ id: 'memory.learnedDetail.keep', defaultMessage: 'Keep' }),
    failed: (error) =>
      t(
        { id: 'memory.learnedDetail.failed.keep', defaultMessage: 'Couldn’t keep it: {error}' },
        { error },
      ),
  },
  'workflow.definition.trial.decide revert': {
    label: () => t({ id: 'memory.learnedDetail.revert', defaultMessage: 'Revert' }),
    failed: (error) =>
      t(
        { id: 'memory.learnedDetail.failed.revert', defaultMessage: 'Couldn’t revert: {error}' },
        { error },
      ),
  },
  'memory.commit': {
    label: () => t({ id: 'memory.learnedDetail.keep', defaultMessage: 'Keep' }),
    failed: (error) =>
      t(
        { id: 'memory.learnedDetail.failed.keep', defaultMessage: 'Couldn’t keep it: {error}' },
        { error },
      ),
  },
  'memory.archive': {
    label: () => t({ id: 'memory.learnedDetail.archive', defaultMessage: 'Archive' }),
    failed: (error) =>
      t(
        { id: 'memory.learnedDetail.failed.archive', defaultMessage: 'Couldn’t archive: {error}' },
        { error },
      ),
  },
};

const actionKey = (a: LearnedAction) => (a.decision ? `${a.command} ${a.decision}` : a.command);

const EVIDENCE: Record<string, { icon: ReactNode; label: () => string }> = {
  retrospective: {
    icon: <Flag aria-hidden="true" />,
    label: () =>
      t({ id: 'memory.learnedDetail.evidence.retrospective', defaultMessage: 'Retrospective' }),
  },
  session: {
    icon: <MessageSquare aria-hidden="true" />,
    label: () => t({ id: 'memory.learnedDetail.evidence.session', defaultMessage: 'Session' }),
  },
  gate_run: {
    icon: <ShieldCheck aria-hidden="true" />,
    label: () => t({ id: 'memory.learnedDetail.evidence.gateRun', defaultMessage: 'Gate run' }),
  },
  signal_issue: {
    icon: <TriangleAlert aria-hidden="true" />,
    label: () => t({ id: 'memory.learnedDetail.evidence.signal', defaultMessage: 'Signal' }),
  },
  eval_receipt: {
    icon: <FlaskConical aria-hidden="true" />,
    label: () =>
      t({ id: 'memory.learnedDetail.evidence.evalReceipt', defaultMessage: 'Eval receipt' }),
  },
};

type Line = { kind?: 'del' | 'add'; text: string };

/** The lines of `from` and `to`, each kept, removed or added along their longest common run. */
function lineDiff(from: string, to: string): Line[] {
  const a = from ? from.split('\n') : [];
  const b = to ? to.split('\n') : [];
  // run[i][j]: the longest common run of a[i..] and b[j..].
  const run = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      run[i]![j] =
        a[i] === b[j] ? run[i + 1]![j + 1]! + 1 : Math.max(run[i + 1]![j]!, run[i]![j + 1]!);
  const lines: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ text: a[i++]! });
      j++;
    } else if (i < a.length && (j === b.length || run[i + 1]![j]! >= run[i]![j + 1]!))
      lines.push({ kind: 'del', text: a[i++]! });
    else lines.push({ kind: 'add', text: b[j++]! });
  }
  return lines;
}

export function LearnedDetail({ projectId, item, onClose, onOpenRetro }: LearnedDetailProps) {
  const [pending, setPending] = useState<{ id: string; key: string } | null>(null);
  const [failure, setFailure] = useState<{ id: string; key: string; text: string } | null>(null);
  const sending = useRef(false);

  const run = async (action: LearnedAction, rejectReason?: RejectReason) => {
    if (sending.current) return;
    sending.current = true;
    const key = actionKey(action);
    setPending({ id: item.id, key });
    setFailure(null);
    const result = await runLearnedAction(projectId, item, action, rejectReason);
    sending.current = false;
    setPending(null);
    if (!result.ok) setFailure({ id: item.id, key, text: result.error });
  };

  const injected =
    item.kind === 'experience' && (item.status === 'trial' || item.status === 'active');
  const used = useImprovementSessions(projectId, injected ? item.id : null);
  const listed = useSessionList(injected ? projectId : null);

  const lines = lineDiff(item.diff.from, item.diff.to);
  const verdict = verdictText(item);
  const tasks = tasksText(item);
  const failed = failure?.id === item.id ? failure : null;
  const busy = pending?.id === item.id ? pending.key : null;
  const openSession = (id: string) => useShell.getState().openSession(id);

  const buttons = item.actions.flatMap((action, n) => {
    const key = actionKey(action);
    const shown = ACTIONS[key];
    if (!shown) return [];
    const kind = n === 0 ? 'btn pri' : 'btn';
    const button = (onClick?: () => void, end?: ReactNode) => (
      <button
        key={key}
        type="button"
        className={busy === key ? `${kind} btn-busy` : kind}
        aria-busy={busy === key || undefined}
        aria-disabled={busy !== null || undefined}
        onClick={onClick}
      >
        {shown.label()}
        {busy !== key && end}
      </button>
    );
    if (key !== 'improvement.decide reject') return [button(() => void run(action))];
    return [
      <Menu
        key={key}
        label={t({ id: 'memory.learnedDetail.rejectMenu', defaultMessage: 'Reason for rejecting' })}
        side="top"
        trigger={button(undefined, <ChevronDown className="mld-down" aria-hidden="true" />)}
      >
        <MenuItem onClick={() => void run(action, 'duplicate')}>
          {t({
            id: 'memory.learnedDetail.rejectDuplicate',
            defaultMessage: 'Duplicates an existing rule',
          })}
        </MenuItem>
        <MenuItem onClick={() => void run(action, 'not_useful')}>
          {t({ id: 'memory.learnedDetail.rejectNotUseful', defaultMessage: 'Not useful' })}
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={() => void run(action)}>
          <span className="mld-tx2">
            {t({ id: 'memory.learnedDetail.rejectNoReason', defaultMessage: 'No reason' })}
          </span>
        </MenuItem>
      </Menu>,
    ];
  });

  return (
    <aside
      className="mld"
      aria-label={t({ id: 'memory.learnedDetail.label', defaultMessage: 'Learned change details' })}
    >
      <div className="mld-head">
        <span className="mld-st" aria-hidden="true">
          <StateGlyph name={GROUP_GLYPH[item.group]} />
        </span>
        <span className="mld-status">{GROUP_LABEL[item.group]()}</span>
        <span className="mld-time">
          {t(
            { id: 'memory.learnedDetail.proposedAt', defaultMessage: 'Proposed {when}' },
            { when: dayText(item.at, Date.now(), { time: true }) },
          )}
        </span>
        <button
          type="button"
          className="ib mld-x"
          aria-label={t({ id: 'memory.learnedDetail.close', defaultMessage: 'Close details' })}
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
      </div>

      <div className="mld-eh">
        <span className="mld-kind">{kindText(item.kind)}</span>
        <span className="chip">{GRADE[item.grade]()}</span>
      </div>

      {item.scope && (
        <div
          className="mld-scope"
          role="group"
          aria-label={t({ id: 'memory.learnedDetail.scope', defaultMessage: 'Applies to' })}
        >
          {item.scope.root && (
            <span className="mld-sv">
              <span className="cap">
                {t({ id: 'memory.learnedDetail.scope.root', defaultMessage: 'Root' })}
              </span>
              <span className="mld-mono mld-path">{item.scope.root}</span>
            </span>
          )}
          {item.scope.runtime && (
            <span className="mld-sv">
              <span className="cap">
                {t({ id: 'memory.learnedDetail.scope.runtime', defaultMessage: 'Runtime' })}
              </span>
              <span>{runtimeName(item.scope.runtime)}</span>
            </span>
          )}
          {item.scope.domain && (
            <span className="mld-sv">
              <span className="cap">
                {t({ id: 'memory.learnedDetail.scope.domain', defaultMessage: 'Domain' })}
              </span>
              <span>{DOMAIN_LABEL[item.scope.domain]}</span>
            </span>
          )}
          {item.scope.tier && (
            <span className="mld-sv">
              <span className="cap">
                {t({ id: 'memory.learnedDetail.scope.tier', defaultMessage: 'Tier' })}
              </span>
              <span>{tierText(item.scope.tier)}</span>
            </span>
          )}
        </div>
      )}

      <ul
        className="lcd-lines mld-diff"
        aria-label={t(
          {
            id: 'memory.learnedDetail.change',
            defaultMessage:
              'Change, {removed, plural, one {# line} other {# lines}} removed, {added, plural, one {# line} other {# lines}} added',
          },
          {
            removed: lines.filter((l) => l.kind === 'del').length,
            added: lines.filter((l) => l.kind === 'add').length,
          },
        )}
      >
        {lines.map((line, n) => (
          <li key={n} data-kind={line.kind}>
            <span>{line.kind === 'del' ? '−' : line.kind === 'add' ? '+' : ''}</span>
            <code>{line.text}</code>
          </li>
        ))}
      </ul>

      {item.n !== undefined && (
        <div
          className="panel mld-cells"
          style={{ gridTemplateColumns: `repeat(${verdict ? 2 : 1}, minmax(0, 1fr))` }}
          role="group"
          aria-label={t({ id: 'memory.learnedDetail.trialResult', defaultMessage: 'Trial result' })}
        >
          {verdict && (
            <div className="cell mld-cell">
              <span className="cap">
                {t({ id: 'memory.learnedDetail.trial', defaultMessage: 'Trial' })}
              </span>
              <span className="mld-cv">{verdict}</span>
            </div>
          )}
          <div className="cell mld-cell">
            <span className="cap">
              {t({ id: 'memory.learnedDetail.trialTasks', defaultMessage: 'Tasks' })}
            </span>
            <span className="mld-cv mld-mono mld-num">{tasks}</span>
          </div>
        </div>
      )}

      {(used.error || (used.data?.length ?? 0) > 0) && (
        <div className="mld-sec">
          <div className="mld-eh">
            <span className="cap">
              {t({ id: 'memory.learnedDetail.usedIn', defaultMessage: 'Used in these sessions' })}
            </span>
            {used.data && (
              <span className="mld-end mld-mono mld-num mld-meta">{used.data.length}</span>
            )}
          </div>
          {used.error ? (
            <div className="mld-err" role="alert">
              <span>
                {t(
                  {
                    id: 'memory.learnedDetail.usedIn.failed',
                    defaultMessage: 'Couldn’t read the sessions: {error}',
                  },
                  { error: used.error },
                )}
              </span>
            </div>
          ) : (
            <div className="mld-rows">
              {used.data!.map((u) => {
                const session = listed.data?.find((s) => s.id === u.session_id);
                return (
                  <button
                    key={u.session_id}
                    type="button"
                    className="mld-rr"
                    onClick={() => openSession(u.session_id)}
                  >
                    <span className="mld-sn">
                      {session && <SessionStateIcon session={session} place="list" />}
                      <span className="mld-cut">
                        {u.title ||
                          t(
                            { id: 'sessions.model.row.untitled', defaultMessage: 'Session {id}' },
                            { id: shortId(u.session_id) },
                          )}
                      </span>
                    </span>
                    <span />
                    <span className="mld-meta">
                      {u.delivered
                        ? t({
                            id: 'memory.learnedDetail.usedIn.delivered',
                            defaultMessage: 'Included',
                          })
                        : t({
                            id: 'memory.learnedDetail.usedIn.pending',
                            defaultMessage: 'Next turn',
                          })}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {item.evidence.length > 0 && (
        <div className="mld-sec">
          <div className="mld-eh">
            <span className="cap">
              {t({ id: 'memory.learnedDetail.evidence', defaultMessage: 'Evidence' })}
            </span>
            <span className="mld-end mld-mono mld-num mld-meta">{item.evidence.length}</span>
          </div>
          <div className="mld-rows">
            {item.evidence.map((e) => {
              const shown = EVIDENCE[e.kind];
              const open =
                e.kind === 'retrospective'
                  ? {
                      label: t(
                        {
                          id: 'memory.learnedDetail.openRetro',
                          defaultMessage: 'Open retrospective {id}',
                        },
                        { id: e.id },
                      ),
                      onClick: () => onOpenRetro(e.id),
                    }
                  : e.kind === 'session'
                    ? {
                        label: t(
                          {
                            id: 'memory.learnedDetail.openSession',
                            defaultMessage: 'Open session {id}',
                          },
                          { id: e.id },
                        ),
                        onClick: () => openSession(e.id),
                      }
                    : null;
              const body = [
                <span key="i" className="mld-evi">
                  {shown?.icon}
                </span>,
                <span key="k">{shown?.label() ?? e.kind}</span>,
                <span key="t" className={e.title ? 'mld-cut' : 'mld-cut mld-mono'}>
                  {e.title ?? e.id}
                </span>,
                <span key="o" className="mld-evi">
                  {open && <ChevronRight aria-hidden="true" />}
                </span>,
              ];
              return open ? (
                <button
                  key={`${e.kind}:${e.id}`}
                  type="button"
                  className="mld-ev"
                  aria-label={open.label}
                  onClick={open.onClick}
                >
                  {body}
                </button>
              ) : (
                <div key={`${e.kind}:${e.id}`} className="mld-ev">
                  {body}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {buttons.length > 0 && (
        <div className="mld-foot">
          {failed && (
            <div className="mld-err" role="alert">
              <span>{ACTIONS[failed.key]!.failed(failed.text)}</span>
            </div>
          )}
          <div className="mld-acts">{buttons}</div>
        </div>
      )}
    </aside>
  );
}
