import type { ComponentType } from 'react';
import { Box, Database, Globe, ListOrdered, Monitor, Shield, type LucideProps } from 'lucide-react';
import { t } from '../../i18n';
import type { NodeKind } from './graph-layout';
import type { Cardinality, KeyKind, MessageKind, RelationEnd, RelationKind } from './mermaid-model';
import { cardinalityMarks, relationMark, type LegendEntry } from './mermaid-layout';
import './native-diagram.css';

export const KIND_ICON: Record<NodeKind, ComponentType<LucideProps>> = {
  client: Monitor,
  service: Box,
  store: Database,
  queue: ListOrdered,
  external: Globe,
  policy: Shield,
};

// Getters, so each name is read in the language loaded by then.
const KIND_NAME: Record<NodeKind, string> = {
  get client() {
    return t({ id: 'visual.graph.kind.client', defaultMessage: 'Client' });
  },
  get service() {
    return t({ id: 'visual.graph.kind.service', defaultMessage: 'Service' });
  },
  get store() {
    return t({ id: 'visual.graph.kind.store', defaultMessage: 'Store' });
  },
  get queue() {
    return t({ id: 'visual.graph.kind.queue', defaultMessage: 'Queue' });
  },
  get external() {
    return t({ id: 'visual.graph.kind.external', defaultMessage: 'External' });
  },
  get policy() {
    return t({ id: 'visual.graph.kind.policy', defaultMessage: 'Policy' });
  },
};

const MESSAGE_NAME: Record<MessageKind, string> = {
  get sync() {
    return t({ id: 'visual.mermaid.message.sync', defaultMessage: 'Call' });
  },
  get async() {
    return t({ id: 'visual.mermaid.message.async', defaultMessage: 'Async' });
  },
  get reply() {
    return t({ id: 'visual.mermaid.message.reply', defaultMessage: 'Reply' });
  },
  get dotted() {
    return t({ id: 'visual.mermaid.message.dotted', defaultMessage: 'Dotted' });
  },
};

const KEY_NAME: Record<KeyKind, string> = {
  get PK() {
    return t({ id: 'visual.mermaid.key.primary', defaultMessage: 'Primary key' });
  },
  get FK() {
    return t({ id: 'visual.mermaid.key.foreign', defaultMessage: 'Foreign key' });
  },
  get UK() {
    return t({ id: 'visual.mermaid.key.unique', defaultMessage: 'Unique key' });
  },
};

const CARDINALITY_NAME: Record<Cardinality, string> = {
  get one() {
    return t({ id: 'visual.mermaid.cardinality.one', defaultMessage: 'Exactly one' });
  },
  get 'zero-or-one'() {
    return t({ id: 'visual.mermaid.cardinality.zeroOrOne', defaultMessage: 'Zero or one' });
  },
  get 'one-or-more'() {
    return t({ id: 'visual.mermaid.cardinality.oneOrMore', defaultMessage: 'One or more' });
  },
  get 'zero-or-more'() {
    return t({ id: 'visual.mermaid.cardinality.zeroOrMore', defaultMessage: 'Zero or more' });
  },
};

const RELATION_NAME: Record<RelationKind, string> = {
  get inheritance() {
    return t({ id: 'visual.mermaid.relation.inheritance', defaultMessage: 'Inheritance' });
  },
  get realization() {
    return t({ id: 'visual.mermaid.relation.realization', defaultMessage: 'Realization' });
  },
  get composition() {
    return t({ id: 'visual.mermaid.relation.composition', defaultMessage: 'Composition' });
  },
  get aggregation() {
    return t({ id: 'visual.mermaid.relation.aggregation', defaultMessage: 'Aggregation' });
  },
  get association() {
    return t({ id: 'visual.mermaid.relation.association', defaultMessage: 'Association' });
  },
  get dependency() {
    return t({ id: 'visual.mermaid.relation.dependency', defaultMessage: 'Dependency' });
  },
  get link() {
    return t({ id: 'visual.mermaid.relation.link', defaultMessage: 'Link' });
  },
};

/** The mark and line of each relation kind's sample. */
const RELATION_SAMPLE: Record<RelationKind, { mark?: RelationEnd; dashed: boolean }> = {
  inheritance: { mark: 'inheritance', dashed: false },
  realization: { mark: 'inheritance', dashed: true },
  composition: { mark: 'composition', dashed: false },
  aggregation: { mark: 'aggregation', dashed: false },
  association: { mark: 'arrow', dashed: false },
  dependency: { mark: 'arrow', dashed: true },
  link: { dashed: false },
};

// A sample's line runs left to right; its end mark sits at the right.
const SAMPLE = { from: { x: 0, y: 8 }, to: { x: 32, y: 8 } } as const;

function Entry({ entry }: { entry: LegendEntry }) {
  switch (entry.item) {
    case 'kind': {
      const Icon = KIND_ICON[entry.kind];
      return (
        <li className="vis-sq-n" data-kind={entry.kind}>
          <Icon className="vis-nl-ic" aria-hidden="true" />
          <span>{KIND_NAME[entry.kind]}</span>
          <span className="vis-nl-n">{entry.count}</span>
        </li>
      );
    }
    case 'message':
      return (
        <li>
          <svg className="vis-nl-ln" viewBox="0 0 20 8" aria-hidden="true">
            <g className="vis-sq-e" data-kind={entry.kind}>
              <path className="vis-sq-ln" d="M0 4H20" />
            </g>
          </svg>
          <span>{MESSAGE_NAME[entry.kind]}</span>
        </li>
      );
    case 'key':
      return (
        <li>
          <span className="vis-nl-k">{entry.key}</span>
          <span>{KEY_NAME[entry.key]}</span>
        </li>
      );
    case 'end': {
      const marks = cardinalityMarks(SAMPLE.to, SAMPLE.from, entry.cardinality);
      return (
        <li>
          <svg className="vis-nl-sm" viewBox="0 0 32 16" aria-hidden="true">
            <g className="vis-er-r">
              <path className="vis-er-p" d="M0 8H32" />
              <path className="vis-er-m" d={marks.path} />
              {marks.circle && (
                <circle className="vis-er-o" cx={marks.circle.x} cy={marks.circle.y} r={4} />
              )}
            </g>
          </svg>
          <span>{CARDINALITY_NAME[entry.cardinality]}</span>
        </li>
      );
    }
    case 'relation': {
      const { mark, dashed } = RELATION_SAMPLE[entry.kind];
      return (
        <li>
          <svg className="vis-nl-sm" viewBox="0 0 32 16" aria-hidden="true">
            <g className="vis-cl-r" data-dashed={dashed}>
              <path className="vis-cl-p" d="M0 8H32" />
              {mark && (
                <path
                  className="vis-cl-m"
                  data-end={mark}
                  d={relationMark(SAMPLE.to, SAMPLE.from, mark)}
                />
              )}
            </g>
          </svg>
          <span>{RELATION_NAME[entry.kind]}</span>
        </li>
      );
    }
  }
}

/** The row under a diagram Pantheon draws from mermaid's parse, of what it uses. */
export function NativeLegend({ entries }: { entries: LegendEntry[] }) {
  return (
    <ul className="vis-nl" aria-label={t({ id: 'visual.graph.legend', defaultMessage: 'Legend' })}>
      {entries.map((entry, i) => (
        <Entry key={i} entry={entry} />
      ))}
    </ul>
  );
}
