import type { ReactNode } from 'react';
import { Bot, ChevronRight } from 'lucide-react';
import { agentTypeName } from '../../components/AgentTypeIcon';
import { RuntimeGlyph } from '../../components/RuntimeGlyph';
import { useBoard } from '../../data/board';
import { subagentCall, toolLabel, toolOutputText } from '../../data/tool-calls';
import { elapsedText, toolDuration, toolState, type ToolItem } from '../../data/transcript';
import { t } from '../../i18n';
import { TaskRow } from './TaskRow';
import { clockText } from '../../lib/time-text';

const mainName = () => t({ id: 'sessions.thread.main', defaultMessage: 'Main' });

/** One message between two agents: who wrote it to whom, when, and its text. */
function AgentMessage(props: {
  runtime: string;
  from: string;
  to: string;
  at: number | undefined;
  text: string;
}) {
  return (
    <>
      <div className="ss-a2aw">
        <RuntimeGlyph runtime={props.runtime} />
        <span>{props.from}</span>
        <ChevronRight aria-hidden="true" />
        <RuntimeGlyph runtime={props.runtime} />
        <span>{props.to}</span>
        {props.at !== undefined && <span className="ss-a2at">{clockText(props.at)}</span>}
      </div>
      <div className="ss-a2ax">{props.text}</div>
    </>
  );
}

/** The subagents a run of calls dispatched, one row each; a row folds out the prompt, calls and report. */
export function SubagentFan(props: {
  agents: ToolItem[];
  /** Each agent's own calls, by the id of the call that dispatched it. */
  calls: ReadonlyMap<string, ToolItem[]>;
  ended: boolean;
  open: boolean;
  enter: string;
  /** The session whose agent dispatched them. */
  sessionId: string;
  renderCalls: (calls: ToolItem[]) => ReactNode;
}) {
  const runtime = useBoard(
    (s) => s.board?.sessions.find((k) => k.id === props.sessionId)?.runtime ?? '',
  );
  const now = Date.now();
  const starts = props.agents.flatMap((a) => a.started_at ?? []);
  const done = props.agents.filter((a) => a.ok !== undefined).length;
  // Whether one agent started before an earlier one ended; unknown while a start is missing.
  let together: boolean | null = null;
  if (props.agents.length > 1 && starts.length === props.agents.length) {
    let end = -Infinity;
    together = false;
    for (const a of [...props.agents].sort((x, y) => x.started_at! - y.started_at!)) {
      if (a.started_at! < end) together = true;
      end = Math.max(end, a.completed_at ?? now);
    }
  }
  return (
    <div className={`ss-fan${props.enter}`}>
      <div className="ss-fanh">
        <Bot aria-hidden="true" />
        <span className="ss-fant">
          {t(
            {
              id: 'sessions.thread.fanTitle',
              defaultMessage:
                '{count, plural, one {Dispatched # agent} other {Dispatched # agents}}',
            },
            { count: props.agents.length },
          )}
        </span>
        {together !== null && (
          <span className="ss-fanm">
            {together
              ? t({ id: 'sessions.thread.fanTogether', defaultMessage: 'In parallel' })
              : t({ id: 'sessions.thread.fanInTurn', defaultMessage: 'One after another' })}
          </span>
        )}
        <span className="ss-fanc">
          {t(
            { id: 'sessions.thread.fanDone', defaultMessage: '{done} / {total} done' },
            { done, total: props.agents.length },
          )}
        </span>
      </div>
      {props.agents.map((agent) => {
        const info = subagentCall(agent.name, agent.input)!;
        const name = info.type
          ? agentTypeName(info.type)
          : toolLabel(agent.name, agent.input).title;
        const state = toolState(agent, props.ended);
        const duration = toolDuration(agent);
        const elapsed = duration === null ? '' : elapsedText(duration);
        const report = agent.output === undefined ? '' : toolOutputText(agent.output);
        const own = props.calls.get(agent.id) ?? [];
        const entries = [
          info.prompt && (
            <AgentMessage
              runtime={runtime}
              from={mainName()}
              to={name}
              at={agent.started_at}
              text={info.prompt}
            />
          ),
          own.length > 0 && <div className="ss-tgroup">{props.renderCalls(own)}</div>,
          report && (
            <AgentMessage
              runtime={runtime}
              from={name}
              to={mainName()}
              at={agent.completed_at}
              text={report}
            />
          ),
        ].filter(Boolean);
        return (
          <TaskRow
            key={`${agent.id}-${props.open}`}
            runtime={runtime}
            type={info.type}
            name={name}
            description={info.description}
            state={state}
            elapsed={elapsed}
            open={props.open}
          >
            {entries.map((entry, i) => (
              <div key={i} className="ss-a2a">
                <span
                  className="ss-a2l"
                  data-more={i < entries.length - 1 || undefined}
                  aria-hidden="true"
                />
                <div className="ss-a2ac">{entry}</div>
              </div>
            ))}
          </TaskRow>
        );
      })}
    </div>
  );
}
