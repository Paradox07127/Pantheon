import { useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { Clip } from '../../components/Clip';
import { StateGlyph, type GlyphName } from '../../components/SessionStateIcon';
import type { LearnedItem } from '../../data/learned';
import { ageText } from '../../data/needs-you';
import { PARAM_LABEL } from '../../data/workflow-policy';
import { t } from '../../i18n';
import './memory-learned.css';

export interface LearnedListProps {
  /** Every learned change of the project, newest first. */
  items: LearnedItem[];
  selected: string | null;
  onSelect: (id: string) => void;
}

type Group = LearnedItem['group'];

// Rows after this many enter together with the last of them.
const STAGGER = 6;

export const GROUP_GLYPH: Record<Group, GlyphName> = {
  needs_you: 'baseline_review',
  on_trial: 'ready',
  in_force: 'done',
  reverted: 'idle',
};

export const GROUP_LABEL: Record<Group, () => string> = {
  needs_you: () => t({ id: 'memory.learned.group.candidate', defaultMessage: 'Needs you' }),
  on_trial: () => t({ id: 'memory.learned.group.trial', defaultMessage: 'On trial' }),
  in_force: () => t({ id: 'memory.learned.group.active', defaultMessage: 'In force' }),
  reverted: () => t({ id: 'memory.learned.group.closed', defaultMessage: 'Reverted' }),
};

// The groups the list shows unfolded, in its order.
export const OPEN_GROUPS: readonly Group[] = ['needs_you', 'on_trial', 'in_force'];

const KIND_LABEL: Record<LearnedItem['kind'], () => string> = {
  policy_change: () =>
    t({ id: 'memory.learned.kind.policyChange', defaultMessage: 'Policy change' }),
  experience: () => t({ id: 'memory.learned.kind.experience', defaultMessage: 'Experience' }),
  gate_command: () => t({ id: 'memory.learned.kind.gateCommand', defaultMessage: 'Gate command' }),
  worktree_setup: () =>
    t({ id: 'memory.learned.kind.worktreeSetup', defaultMessage: 'Worktree setup' }),
  agent_instructions: () =>
    t({ id: 'memory.learned.kind.agentInstructions', defaultMessage: 'Agent instructions' }),
  playbook: () => t({ id: 'memory.learned.kind.playbook', defaultMessage: 'Playbook' }),
  agent_change: () => t({ id: 'memory.learned.kind.agentChange', defaultMessage: 'Agent change' }),
  workflow_definition: () =>
    t({ id: 'memory.learned.kind.workflowDefinition', defaultMessage: 'Workflow definition' }),
  memory_note: () => t({ id: 'memory.learned.kind.memoryNote', defaultMessage: 'Memory note' }),
  runtime_review: () =>
    t({ id: 'memory.learned.kind.runtimeReview', defaultMessage: 'Runtime review' }),
};

export const kindText = (kind: LearnedItem['kind']) => KIND_LABEL[kind]();

const VERDICT: Record<NonNullable<LearnedItem['verdict']>, () => string> = {
  better: () => t({ id: 'memory.learned.verdict.better', defaultMessage: 'Better' }),
  worse: () => t({ id: 'memory.learned.verdict.worse', defaultMessage: 'Worse' }),
  not_enough_evidence: () =>
    t({ id: 'memory.learned.verdict.notEnoughEvidence', defaultMessage: 'Not enough evidence' }),
};

/** The trial's verdict; a trial still running has none to give yet. */
export function verdictText(item: LearnedItem): string | null {
  if (item.verdict) return VERDICT[item.verdict]();
  return item.group === 'on_trial' ? VERDICT.not_enough_evidence() : null;
}

/** The tasks a trial has seen, against those it needs while it runs. */
export function tasksText(item: LearnedItem): string | null {
  if (item.n === undefined) return null;
  return item.tasks_required === undefined
    ? t(
        {
          id: 'memory.learned.tasks',
          defaultMessage: '{count, plural, one {# task} other {# tasks}}',
        },
        { count: item.n },
      )
    : t(
        {
          id: 'memory.learned.tasksOf',
          defaultMessage: '{count} / {required, plural, one {# task} other {# tasks}}',
        },
        { count: item.n, required: item.tasks_required },
      );
}

// Kinds whose values are settings, commands or definitions rather than prose.
const MONO = new Set<LearnedItem['kind']>([
  'policy_change',
  'gate_command',
  'worktree_setup',
  'workflow_definition',
]);

const short = (text: string) => text !== '' && text.length <= 24 && !text.includes('\n');

/** A structured value on one line, else the first line of the text. */
function firstLine(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return (
      text
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean) ?? ''
    );
  }
}

/** The row's title as drawn and as read out. */
function rowTitle(item: LearnedItem): { node: ReactNode; text: string } {
  const { from, to } = item.diff;
  if (short(from) && short(to)) {
    const what =
      item.kind === 'policy_change' && item.title
        ? ((PARAM_LABEL as Record<string, string>)[item.title] ?? item.title)
        : null;
    return {
      node: (
        <>
          {what && <span className="lr-what">{what}</span>}
          <span className="lr-from">{from}</span>
          <span className="lr-to">{to}</span>
        </>
      ),
      text: what
        ? t(
            { id: 'data.workflowPolicy.change', defaultMessage: '{what} from {from} to {to}' },
            { what, from, to },
          )
        : t({ id: 'memory.learned.fromTo', defaultMessage: '{from} to {to}' }, { from, to }),
    };
  }
  const line = firstLine(to);
  return {
    node: <Clip text={line} className={MONO.has(item.kind) ? 'lr-mono' : undefined} />,
    text: line,
  };
}

export function LearnedList(p: LearnedListProps) {
  const [open, setOpen] = useState(false);
  const now = Date.now();
  let k = 0;

  const row = (i: LearnedItem, stagger: boolean) => {
    const title = rowTitle(i);
    const verdict = verdictText(i);
    const tasks = tasksText(i);
    return (
      <button
        key={i.id}
        type="button"
        role="option"
        aria-selected={i.id === p.selected}
        aria-label={t(
          { id: 'memory.learned.row', defaultMessage: '{title}, {kind}, {group}' },
          { title: title.text, kind: kindText(i.kind), group: GROUP_LABEL[i.group]() },
        )}
        className="lr-row"
        style={stagger ? ({ '--lr-k': Math.min(k++, STAGGER) } as CSSProperties) : undefined}
        onClick={() => p.onSelect(i.id)}
      >
        <span className="lr-st" aria-hidden="true">
          <StateGlyph name={GROUP_GLYPH[i.group]} />
        </span>
        <span className="lr-tt">{title.node}</span>
        <span className="lr-kind">{kindText(i.kind)}</span>
        <span className="lr-tr">
          {verdict && <span>{verdict}</span>}
          {tasks && <span className="lr-n">{tasks}</span>}
        </span>
        <span className="lr-tm">{ageText(i.at, now)}</span>
      </button>
    );
  };

  const closed = p.items.filter((i) => i.group === 'reverted');
  const closedLabel = GROUP_LABEL.reverted();
  return (
    <section
      className="lr"
      aria-label={t({ id: 'memory.learned.label', defaultMessage: 'Learned changes' })}
    >
      {OPEN_GROUPS.map((group) => {
        const rows = p.items.filter((i) => i.group === group);
        if (!rows.length) return null;
        const label = GROUP_LABEL[group]();
        return [
          <div key={`${group}-h`} className="lr-gh">
            <span className="lr-gn">{label}</span>
            <span className="lr-ct">{rows.length}</span>
          </div>,
          <div key={group} role="listbox" aria-label={label} className="lr-grp">
            {rows.map((i) => row(i, true))}
          </div>,
        ];
      })}
      {closed.length > 0 && (
        <>
          <button
            type="button"
            className="lr-gh lr-fold"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <ChevronRight aria-hidden="true" />
            <span className="lr-gn">{closedLabel}</span>
            <span className="lr-ct">{closed.length}</span>
          </button>
          {open && (
            <div role="listbox" aria-label={closedLabel} className="lr-old">
              {closed.map((i) => row(i, false))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
