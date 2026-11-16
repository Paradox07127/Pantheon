import { useState } from 'react';
import { Collapsible } from '@base-ui/react/collapsible';
import { ChevronRight } from 'lucide-react';
import {
  isTruncated,
  orchestrationDetail,
  orchestrationLabel,
  orchestrationResult,
  toolOutputText,
} from '../../data/tool-calls';
import { elapsedText, toolDuration, type ToolItem, type ToolState } from '../../data/transcript';
import { RuntimeGlyph } from '../../components/RuntimeGlyph';
import { useBoard } from '../../data/board';
import { t } from '../../i18n';
import { useShell } from '../../store';
import { CALL_STATE, json, StateMark, ToolText } from './parts';

/**
 * A task of the lead's plan by its plan id: the runtime and title of its newest session, which it
 * opens; the bare id until a session exists.
 */
export function TaskChip(props: { leadSessionId: string; taskId: string }) {
  const session = useBoard((s) =>
    s.board?.sessions.findLast(
      (k) => k.task?.lead_session_id === props.leadSessionId && k.task.id === props.taskId,
    ),
  );
  if (!session) return <span className="tchip mono">{props.taskId}</span>;
  return (
    <button
      type="button"
      className="tchip"
      onClick={() => useShell.getState().openSession(session.id)}
    >
      <RuntimeGlyph runtime={session.runtime} />
      {session.title?.trim() || props.taskId}
    </button>
  );
}

/** A call that steers the plan: the action, the tasks it names and its detail; folds out like a tool call. */
export function OrchestrationRow(props: {
  item: ToolItem;
  state: ToolState;
  depth: number;
  open: boolean;
  enter: string;
  /** The session whose thread shows the call. */
  sessionId: string;
}) {
  const { item } = props;
  const [open, setOpen] = useState(props.open);
  const label = orchestrationLabel(item.name, item.input, item.output)!;
  const state = CALL_STATE[props.state];
  const result =
    item.ok !== undefined
      ? orchestrationResult(item.name, item.input, item.output, item.ok)
      : props.state === 'none'
        ? state.label
        : '';
  const duration = toolDuration(item);
  const elapsed = duration === null ? '' : elapsedText(duration);
  const cut = isTruncated(item.input) || isTruncated(item.output);
  const entries = orchestrationDetail(item.name, item.input, item.output);
  const output =
    item.output === undefined ? null : toolOutputText(item.output) || json(item.output);
  return (
    <Collapsible.Root
      className={`ss-tool${props.depth ? ` d${props.depth}` : ''}${props.enter}`}
      open={open}
      onOpenChange={setOpen}
    >
      {/* The task chips open sessions, so only the action folds the row. */}
      <div className="ss-orow">
        <Collapsible.Trigger
          className="ss-otg"
          aria-label={[label.title, label.detail, result || state.label, elapsed]
            .filter(Boolean)
            .join(t({ id: 'sessions.parts.separator', defaultMessage: ', ' }))}
        >
          <span className="ss-tchev" aria-hidden="true">
            <ChevronRight aria-hidden="true" />
          </span>
          <span className="ss-tn">{label.title}</span>
        </Collapsible.Trigger>
        <span className="ss-oa">
          {label.tasks.map((task) => (
            <TaskChip key={task} leadSessionId={props.sessionId} taskId={task} />
          ))}
          {label.detail && <span className="ss-ta">{label.detail}</span>}
        </span>
        <span className="ss-ts">
          {result}
          {cut && (
            <span className="tr-cut">
              {t({ id: 'sessions.parts.truncated', defaultMessage: 'Truncated' })}
            </span>
          )}
        </span>
        <StateMark state={props.state} />
        <span className="ss-td mono">{elapsed}</span>
      </div>
      {entries ? (
        <Collapsible.Panel className="ss-tio">
          <ul className="ss-olist">
            {entries.map((line, i) => (
              <li key={i}>
                {line.task && <TaskChip leadSessionId={props.sessionId} taskId={line.task} />}
                {line.name && <span className="ss-on">{line.name}</span>}
                {line.text && <span className="ss-ox">{line.text}</span>}
                {line.code && <span className="ss-ox mono">{line.code}</span>}
              </li>
            ))}
          </ul>
        </Collapsible.Panel>
      ) : (
        (item.input !== undefined || output !== null) && (
          <Collapsible.Panel className="ss-tio">
            {item.input !== undefined && (
              <ToolText
                text={json(item.input)}
                label={t({ id: 'sessions.parts.input', defaultMessage: 'Input' })}
                input
              />
            )}
            {output !== null && (
              <ToolText
                text={output}
                label={t({ id: 'sessions.parts.output', defaultMessage: 'Output' })}
              />
            )}
          </Collapsible.Panel>
        )
      )}
    </Collapsible.Root>
  );
}
