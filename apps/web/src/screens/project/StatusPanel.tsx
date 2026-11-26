import type { ProjectPlanView, ProjectSummary, WorkbenchSession } from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { RuntimeGlyph, runtimeName } from '../../components/RuntimeGlyph';
import { ageText, useNow } from '../../data/needs-you';
import { t } from '../../i18n';
import { durationText } from '../../lib/time-text';
import { sessionRow } from '../sessions/model';
import { shortSha, statusCounts } from './project-model';

/** The project's state: what the main agent says, the summary's counts and the newest landing. */
export function StatusPanel({
  summary,
  main,
  latest,
}: {
  summary: ProjectSummary | undefined;
  main: WorkbenchSession | null;
  latest: ProjectPlanView['latest_landing'];
}) {
  const now = useNow(60_000);
  return (
    <section
      className="panel pj-stat"
      aria-label={t({ id: 'project.status.label', defaultMessage: 'Project status' })}
      aria-busy={!summary || undefined}
      data-landing={latest ? '' : undefined}
    >
      {main && (
        <div className="cell pj-say">
          <span className="pj-rt" role="img" aria-label={runtimeName(main.runtime)}>
            <RuntimeGlyph runtime={main.runtime} />
          </span>
          <span className="pj-st">{sessionRow(main).title}</span>
          {main.recap?.headline && <span className="pj-hl">{main.recap.headline}</span>}
          <span className="pj-ago">{ageText(Date.parse(main.last_activity_at), now)}</span>
        </div>
      )}
      {statusCounts(summary).map((cell) => (
        <div key={cell.key} className="cell pj-k">
          <span className="cap">{cell.label}</span>
          <span className="pj-kv">
            <span className="kpi">{cell.count}</span>
            {cell.longest !== undefined && (
              <span className="pj-dl">
                {t(
                  { id: 'project.status.longest', defaultMessage: 'Longest {duration}' },
                  { duration: durationText(cell.longest) },
                )}
              </span>
            )}
          </span>
        </div>
      ))}
      {latest && (
        <div className="cell pj-k">
          <span className="cap">
            {t({ id: 'project.status.latestLanding', defaultMessage: 'Latest landing' })}
          </span>
          <span className="pj-kv">
            <span className="mono pj-sha">{shortSha(latest.sha)}</span>
            <Clip text={latest.title} className="pj-lt" />
            <span className="pj-dl">{ageText(Date.parse(latest.at), now)}</span>
          </span>
        </div>
      )}
    </section>
  );
}
