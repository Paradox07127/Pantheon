import { t } from '../../i18n';
import type { GraphNode } from './graph-layout';
import './memory-graph-interact.css';

const STATES = {
  active: {
    tone: 'ok',
    text: () => t({ id: 'memory.graphInteract.state.active', defaultMessage: 'Current' }),
  },
  draft: {
    tone: 'wait',
    text: () => t({ id: 'memory.graphInteract.state.draft', defaultMessage: 'Pending review' }),
  },
  archived: {
    tone: 'idle',
    text: () => t({ id: 'memory.graphInteract.state.archived', defaultMessage: 'Archived' }),
  },
};

/** The card beside a hovered or keyboard-focused node: title, summary and state. */
export function GraphHoverCard({ node, id }: { node: GraphNode; id?: string }) {
  const state = node.state && STATES[node.state];
  return (
    <div className="pop mgi-hc" role="tooltip" id={id}>
      <span className="mgi-t">{node.label}</span>
      {node.summary && <span className="mgi-sum">{node.summary}</span>}
      {state && (
        <span className="mgi-state">
          <span className="mgi-st" data-st={state.tone} aria-hidden="true" />
          {state.text()}
        </span>
      )}
    </div>
  );
}
