import type { ReactNode } from 'react';
import { Collapsible } from '@base-ui/react/collapsible';
import type { LucideIcon } from 'lucide-react';
import { AgentTypeIcon } from '../../components/AgentTypeIcon';
import { RuntimeGlyph } from '../../components/RuntimeGlyph';
import type { ToolState } from '../../data/transcript';
import { t } from '../../i18n';
import { tokenText } from '../board/panels-model';
import { CALL_STATE, StateMark } from './items';
import './thread.css';
import './task-row.css';

/** One task an agent runs: runtime, type, name, title, state and time; it folds out what the task did. */
export function TaskRow(props: {
  runtime: string;
  /** The agent type the runtime reported; without one the row draws `icon`. */
  type: string | null;
  icon?: LucideIcon;
  name: string;
  description: string;
  state: ToolState;
  elapsed: string;
  usage?: { tokens: number; tool_uses: number };
  /** The task's last tool or its summary. */
  detail?: string;
  open: boolean;
  children?: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <Collapsible.Root className="ss-fanr" defaultOpen={props.open}>
      <Collapsible.Trigger
        className="ss-fanrow"
        aria-label={[props.name, props.description, CALL_STATE[props.state].label, props.elapsed]
          .filter(Boolean)
          .join(t({ id: 'sessions.parts.separator', defaultMessage: ', ' }))}
      >
        <RuntimeGlyph runtime={props.runtime} />
        {props.type ? (
          <AgentTypeIcon type={props.type} />
        ) : Icon ? (
          <Icon className="ic-sm agt" aria-hidden="true" />
        ) : (
          <span />
        )}
        <span className="ss-fann">{props.name}</span>
        <span className="ss-fand">{props.description}</span>
        <StateMark state={props.state} />
        <span className="ss-td mono">{props.elapsed}</span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="ss-fanp">
        {props.usage && (
          <div className="ss-taskf">
            <span>
              {t(
                {
                  id: 'data.toolCalls.group.calls',
                  defaultMessage: '{count, plural, one {# tool call} other {# tool calls}}',
                },
                { count: props.usage.tool_uses },
              )}
            </span>
            <span className="mono">
              {t(
                { id: 'sessions.screen.tokens', defaultMessage: '{tokens} tokens' },
                { tokens: tokenText(props.usage.tokens) },
              )}
            </span>
          </div>
        )}
        {props.detail && <p className="ss-taskd">{props.detail}</p>}
        {props.children}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
