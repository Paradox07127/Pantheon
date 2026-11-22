import { useState } from 'react';
import { Collapsible } from '@base-ui/react/collapsible';
import { ChevronRight } from 'lucide-react';
import { Clip } from '../../components/Clip';
import {
  isTruncated,
  orchestrationDetail,
  orchestrationLabel,
  orchestrationResult,
} from '../../data/tool-calls';
import { elapsedText, toolDuration, type ToolItem, type ToolState } from '../../data/transcript';
import { t } from '../../i18n';
import { CALL_STATE, StateMark } from './parts';

/** A Pantheon call with its own row: the action and its detail; folds out like a tool call. */
export function OrchestrationRow(props: {
  item: ToolItem;
  state: ToolState;
  depth: number;
  open: boolean;
  enter: string;
}) {
  const { item } = props;
  const [open, setOpen] = useState(props.open);
  const label = orchestrationLabel(item.name, item.input)!;
  const state = CALL_STATE[props.state];
  const result =
    item.ok !== undefined
      ? orchestrationResult(item.name, item.output, item.ok)
      : props.state === 'none'
        ? state.label
        : '';
  const duration = toolDuration(item);
  const elapsed = duration === null ? '' : elapsedText(duration);
  const cut = isTruncated(item.input) || isTruncated(item.output);
  const entries = orchestrationDetail(item.name, item.input, item.output)!;
  return (
    <Collapsible.Root
      className={`ss-tool${props.depth ? ` d${props.depth}` : ''}${props.enter}`}
      open={open}
      onOpenChange={setOpen}
    >
      <div className="ss-orow">
        {entries.length === 0 ? (
          <span className="ss-otb">
            <span className="ss-tn">{label.title}</span>
          </span>
        ) : (
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
        )}
        <span className="ss-oa">
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
      {entries.length > 0 && (
        <Collapsible.Panel className="ss-tio">
          <ul className="ss-olist">
            {entries.map((line, i) => (
              <li key={i} data-prose={line.prose}>
                <span className="ss-on">{line.name}</span>
                {line.code &&
                  (line.prose ? (
                    <Clip as="div" className="ss-op" text={line.code} lines={3} />
                  ) : (
                    <span className="ss-ox mono">{line.code}</span>
                  ))}
              </li>
            ))}
          </ul>
        </Collapsible.Panel>
      )}
    </Collapsible.Root>
  );
}
