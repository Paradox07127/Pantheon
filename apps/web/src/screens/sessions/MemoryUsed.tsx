import { useState } from 'react';
import { Collapsible } from '@base-ui/react/collapsible';
import { BookOpen, ChevronRight } from 'lucide-react';
import type { MemoryDirectory } from '@pantheon/domain';
import { useMemoryQuery, useMemoryTurn } from '../../data/memory';
import { useMemoryView } from '../../data/memory-view';
import { t } from '../../i18n';
import { useShell } from '../../store';
import { kindIcon, kindText } from '../memory/memory-kind';
import './memory-used.css';

/** Opens the memory entries, with `memoryId` selected when given. */
export function openMemory(memoryId: string | null) {
  const shell = useShell.getState();
  shell.setMemoryTab('entries');
  if (memoryId !== null) useMemoryView.getState().select(memoryId);
  shell.setScreen('memory');
}

/** The memory entries one finished turn was given, folded to their count; read once first opened. */
export function MemoryUsed(props: { sessionId: string; turnId: string; count: number }) {
  // Kept once opened, so the list stays while the panel closes.
  const [opened, setOpened] = useState(false);
  const items = useMemoryTurn(props.sessionId, opened ? props.turnId : null).data?.items ?? [];
  return (
    <Collapsible.Root
      className="ss-tgroup ss-mem"
      onOpenChange={(open) => {
        if (open) setOpened(true);
      }}
    >
      <Collapsible.Trigger className="ss-trow">
        <span className="ss-tchev" aria-hidden="true">
          <ChevronRight aria-hidden="true" />
        </span>
        <BookOpen className="ic-sm" aria-hidden="true" />
        <span className="ss-meml">
          {t(
            {
              id: 'sessions.memory.used',
              defaultMessage: 'Used {count, plural, one {# memory} other {# memories}}',
            },
            { count: props.count },
          )}
        </span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="ss-tlist">
        <div className="ss-memp">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className="ss-memr"
              onClick={() => openMemory(item.id)}
            >
              {kindIcon(item.kind, kindText(item.kind))}
              <span className="ss-memt">{item.title}</span>
              {item.version !== undefined && (
                <span className="ss-memv">
                  {t(
                    { id: 'sessions.memory.version', defaultMessage: 'Version {n}' },
                    { n: item.version },
                  )}
                </span>
              )}
            </button>
          ))}
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/** Whether the session has the project's current memory; nothing for a project without memory. */
export function MemoryDelivery(props: { projectId: string; sessionId: string }) {
  const directory = useMemoryQuery<MemoryDirectory>('memory.read', props.projectId, {
    limit: 1,
  }).data;
  const session = directory?.sessions.find((s) => s.id === props.sessionId);
  if (!directory || !session) return null;
  const { active, draft, archived } = directory.counts;
  if (active + draft + archived === 0) return null;
  const state = session.delivered ? 'ok' : session.stale ? 'wait' : null;
  if (state === null) return null;
  return (
    <button type="button" className="chip ss-memc" onClick={() => openMemory(null)}>
      <span className="ss-memd" data-state={state} aria-hidden="true" />
      {state === 'ok'
        ? t({ id: 'sessions.memory.delivered', defaultMessage: 'Memory delivered' })
        : t({ id: 'sessions.memory.stale', defaultMessage: 'Memory update not delivered' })}
    </button>
  );
}
