import type { BoardModel } from '@pantheon/protocol';
import { RuntimeGlyph } from '../../components/RuntimeGlyph';
import { t } from '../../i18n';
import type { SnapshotSession } from './panels-model';
import './overview.css';

const clock = (at: number): string => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** The plan sentence the lead wrote on the board, the runtime that wrote it and when. */
export function LeadPlan({
  headline,
  sessions,
  repeated,
}: {
  headline: NonNullable<BoardModel['headline']>;
  sessions?: readonly SnapshotSession[];
  /** Set when a lead's line already says the sentence, so it shows once. */
  repeated?: boolean;
}) {
  const by = headline.by_session;
  const runtime = by ? sessions?.find((s) => s.id === by)?.runtime : undefined;
  return (
    <div
      className="bgl"
      role="group"
      aria-label={t({ id: 'board.lead.plan.label', defaultMessage: "Lead's plan" })}
    >
      {runtime && <RuntimeGlyph runtime={runtime} />}
      {!repeated && (
        <p className="bgl-t" title={headline.text}>
          {headline.text}
        </p>
      )}
      <time className="bgl-at" dateTime={new Date(headline.updated_at).toISOString()}>
        {clock(headline.updated_at)}
      </time>
    </div>
  );
}
