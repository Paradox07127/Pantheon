import { Fragment } from 'react';
import type { BaselineWorkstream } from '@pantheon/domain';
import { t } from '../../i18n';

export type WorkstreamStructure = Pick<
  BaselineWorkstream,
  'id' | 'title' | 'modules' | 'depends_on' | 'risks'
> &
  Partial<Pick<BaselineWorkstream, 'next' | 'blockers'>>;

// Labels are getters, so each is read in the language loaded by then.
const FIELDS = [
  {
    key: 'modules',
    mono: true,
    get label() {
      return t({ id: 'projects.baseline.structure.modules', defaultMessage: 'Modules' });
    },
  },
  {
    key: 'depends_on',
    mono: false,
    get label() {
      return t({ id: 'projects.baseline.structure.dependsOn', defaultMessage: 'Depends on' });
    },
  },
  {
    key: 'risks',
    mono: false,
    get label() {
      return t({ id: 'projects.baseline.structure.risks', defaultMessage: 'Risks' });
    },
  },
  {
    key: 'next',
    mono: false,
    get label() {
      return t({ id: 'projects.baseline.structure.next', defaultMessage: 'Next' });
    },
  },
  {
    key: 'blockers',
    mono: false,
    get label() {
      return t({ id: 'projects.baseline.structure.blockers', defaultMessage: 'Blockers' });
    },
  },
] as const;

/** Each workstream's modules, dependencies, risks, next steps and blockers; workstreams with none are left out. */
export function WorkstreamDetails({ rows }: { rows: readonly WorkstreamStructure[] }) {
  const title = (key: string) => rows.find((row) => row.id === key)?.title ?? key;
  const shown = rows
    .map((row) => ({
      row,
      fields: FIELDS.map((field) => ({
        field,
        values: (field.key === 'depends_on'
          ? (row.depends_on ?? []).map(title)
          : (row[field.key] ?? [])) as readonly string[],
      })).filter((entry) => entry.values.length > 0),
    }))
    .filter((entry) => entry.fields.length > 0);
  if (!shown.length) return null;
  return (
    <div
      className="ws-dts"
      role="list"
      aria-label={t({ id: 'projects.baseline.structure', defaultMessage: 'Workstream structure' })}
    >
      {shown.map(({ row, fields }) => (
        <div key={row.id} className="ws-dt" role="listitem" aria-label={row.title}>
          <b>{row.title}</b>
          <dl className="ws-dl">
            {fields.map(({ field, values }) => (
              <Fragment key={field.key}>
                <dt className="cap">{field.label}</dt>
                <dd>
                  {values.map((value) => (
                    <span key={value} className={field.mono ? 'mono' : undefined}>
                      {value}
                    </span>
                  ))}
                </dd>
              </Fragment>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}
