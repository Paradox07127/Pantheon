import type { BaselineWorkstream } from '@pantheon/domain';
import type { ProjectFactsRead } from '@pantheon/protocol';
import { t } from '../../i18n';

// Labels are getters, so each is read in the language loaded by then.
export const WORKSTREAM_STATUS: Record<
  BaselineWorkstream['status'],
  { text: string; tone: string }
> = {
  done: {
    get text() {
      return t({ id: 'projects.workstream.done', defaultMessage: 'Done' });
    },
    tone: 'ok',
  },
  running: {
    get text() {
      return t({ id: 'projects.workstream.running', defaultMessage: 'In progress' });
    },
    tone: 'run',
  },
  next: {
    get text() {
      return t({ id: 'projects.workstream.next', defaultMessage: 'Next' });
    },
    tone: '',
  },
  blocked: {
    get text() {
      return t({ id: 'projects.workstream.blocked', defaultMessage: 'Blocked' });
    },
    tone: 'bad',
  },
};

export type WorkstreamCount = ProjectFactsRead['workstreams'][number];

export interface WorkstreamRow {
  id: string;
  title: string;
  /** The row's tooltip: the workstream's reason when it has one. */
  hint: string;
  status: string;
  tone: string;
  done: number;
  open: number;
  total: number;
  counts: string;
  missing: string | null;
}

/** One bar per workstream, done against open items; items no longer found are counted apart. */
export function workstreamRows(
  streams: readonly (WorkstreamCount & { reason?: string })[],
): WorkstreamRow[] {
  return streams.map((stream) => {
    const total = stream.done + stream.open;
    return {
      id: stream.id,
      title: stream.title,
      hint: stream.reason ?? stream.title,
      status: WORKSTREAM_STATUS[stream.status].text,
      tone: WORKSTREAM_STATUS[stream.status].tone,
      done: stream.done,
      open: stream.open,
      total,
      counts: `${stream.done}/${total}`,
      missing:
        stream.missing > 0
          ? t(
              {
                id: 'projects.workstream.missing',
                defaultMessage: '{count, plural, one {# item not found} other {# items not found}}',
              },
              { count: stream.missing },
            )
          : null,
    };
  });
}
