import { useMemo, useState } from 'react';
import type { ProjectOverlap } from '@pantheon/protocol';
import { useProjectQuery } from './project-read';

const isOverlap = (value: unknown): boolean =>
  !!value &&
  Array.isArray((value as ProjectOverlap).pairs) &&
  Array.isArray((value as ProjectOverlap).refresh_events);

/** The project's open sessions that changed the same files, read again after the events its last answer names. */
export function useProjectOverlap(projectId: string | null) {
  // Until the first answer names its events, nothing but focus and reconnects reads again.
  const [events, setEvents] = useState('');
  const kinds = useMemo(() => new Set(events ? events.split(' ') : []), [events]);
  const query = useProjectQuery<ProjectOverlap>(
    'project.overlap',
    projectId,
    isOverlap,
    undefined,
    { kinds },
  );
  const named = query.read?.refresh_events.join(' ') ?? events;
  if (named !== events) setEvents(named);
  return query;
}
