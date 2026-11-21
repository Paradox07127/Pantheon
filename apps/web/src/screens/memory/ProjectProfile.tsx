import { Clock, GitBranch } from 'lucide-react';
import type { ProjectIntro } from '@pantheon/domain';
import { ProjectMonogram } from '../../components/ProjectMonogram';
import { Tip } from '../../components/Tip';
import { ageText } from '../../data/needs-you';
import { currentLocale, t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { SourceRef } from './IntroView';
import { languageParts } from './intro-model';
import './memory-overview.css';

const percent = (share: number) =>
  new Intl.NumberFormat(currentLocale(), { style: 'percent', maximumFractionDigits: 1 }).format(
    share,
  );

/** Who the project is: its name, what it does, where it stands and what it is written in. */
export function ProjectProfile({
  id,
  name,
  summary,
  sources,
  base,
  branch,
  committedAt,
  now,
  stack,
  languages,
}: {
  id: string;
  name: string;
  /** null until the project has an introduction. */
  summary: string | null;
  sources: readonly string[];
  /** The project folder the sources are relative to. */
  base?: string;
  /** null on a detached head or before the head is read. */
  branch: string | null;
  /** When the head was committed; null before the head is read. */
  committedAt: number | null;
  now: number;
  stack: readonly string[];
  languages: ProjectIntro['languages'];
}) {
  const parts = languageParts(languages);
  const partName = (part: string | null) =>
    part ?? t({ id: 'memory.overview.languages.other', defaultMessage: 'Other' });
  const lines = languages.reduce((all, language) => all + language.lines, 0);
  const languagesTitle = t({ id: 'memory.overview.languages', defaultMessage: 'Languages' });
  return (
    <div className="panel mo-pf">
      <section
        className="cell mo-pf-main"
        aria-label={t({ id: 'memory.overview.project', defaultMessage: 'Project' })}
      >
        <div className="mo-pf-title">
          <ProjectMonogram id={id} name={name} />
          <h2>{name}</h2>
        </div>
        {summary !== null && (
          <div className="mo-pf-sum">
            <p title={summary}>{summary}</p>
            {sources.map((source) => (
              <SourceRef key={source} source={source} base={base} className="mo-pf-ref" />
            ))}
          </div>
        )}
        <div className="mo-pf-chips">
          {branch !== null && (
            <Tip content={t({ id: 'memory.overview.branch', defaultMessage: 'Current branch' })}>
              <span className="chip">
                <GitBranch aria-hidden="true" />
                <span className="mono">{branch}</span>
              </span>
            </Tip>
          )}
          {committedAt !== null && (
            <Tip content={t({ id: 'memory.overview.committed', defaultMessage: 'Last commit' })}>
              <span className="chip">
                <Clock aria-hidden="true" />
                {ageText(committedAt, now)}
              </span>
            </Tip>
          )}
          {(branch !== null || committedAt !== null) && stack.length > 0 && (
            <span className="mo-pf-sep" />
          )}
          {stack.map((item) => (
            <span key={item} className="chip">
              {item}
            </span>
          ))}
        </div>
      </section>
      {parts.length > 0 && (
        <section className="cell mo-pf-langs" aria-label={languagesTitle}>
          <div className="mo-pf-ch">
            <span>{languagesTitle}</span>
            <span className="mo-pf-n">
              {t(
                {
                  id: 'memory.overview.lines',
                  defaultMessage: '{count, plural, one {# line} other {# lines}}',
                },
                { count: lines },
              )}
            </span>
          </div>
          <div
            className="mo-pf-seg"
            role="img"
            aria-label={t(
              {
                id: 'memory.overview.languages.label',
                defaultMessage: 'Lines by language: {list}',
              },
              { list: listText(...parts.map((p) => `${partName(p.name)} ${percent(p.share)}`)) },
            )}
          >
            {parts.map((p, i) => (
              <i
                key={p.name ?? ''}
                data-k={p.name === null ? 'other' : i + 1}
                style={{ flexGrow: p.lines }}
              />
            ))}
          </div>
          <ul className="mo-pf-legend" aria-hidden="true">
            {parts.map((p, i) => (
              <li key={p.name ?? ''}>
                <span className="mo-pf-dot" data-k={p.name === null ? 'other' : i + 1} />
                <span className="mo-pf-cut">{partName(p.name)}</span>
                <span className="mo-pf-n">{percent(p.share)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
