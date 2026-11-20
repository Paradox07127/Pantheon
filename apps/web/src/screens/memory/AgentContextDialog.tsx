import { Dialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import type { MemoryContext } from '../../data/memory-context';
import { currentLocale, t } from '../../i18n';
import { scrimFlag } from '../../lib/root-flag';
import './agent-context.css';

export const numberText = (n: number) => n.toLocaleString(currentLocale());

export const KIND_LABEL = {
  get decision() {
    return t({ id: 'memory.agent.decisions', defaultMessage: 'Decisions' });
  },
  get report() {
    return t({ id: 'memory.agent.reports', defaultMessage: 'Reports' });
  },
  get note() {
    return t({ id: 'memory.agent.notes', defaultMessage: 'Notes' });
  },
};

export const versionText = () =>
  t({ id: 'memory.agent.version', defaultMessage: 'Memory version' });

/** The full text agents get now, grouped by kind. */
export function AgentContextBody({ context }: { context: MemoryContext }) {
  const groups = (['decision', 'report', 'note'] as const)
    .map((kind) => ({ kind, items: context.items.filter((i) => i.kind === kind) }))
    .filter((g) => g.items.length > 0);
  return (
    <div className="acx-db">
      {groups.map(({ kind, items }) => (
        <section key={kind} className="acx-grp" aria-label={KIND_LABEL[kind]}>
          <div className="acx-gh">
            <span className="cap">{KIND_LABEL[kind]}</span>
            <span className="mono mu acx-num acx-sm">{items.length}</span>
          </div>
          {items.map((item) => (
            <div key={item.id} className="acx-it">
              <span className="acx-b">{item.title ?? item.key}</span>
              <p className="acx-tx">{item.text}</p>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

export function AgentContextDialog({
  open,
  onOpenChange,
  context,
  limit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  context: MemoryContext | null;
  limit: number;
}) {
  const title = t({ id: 'memory.agent.dialogTitle', defaultMessage: 'Project-wide preview' });
  return (
    <Dialog.Root open={open && !!context} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="pj-scrim" ref={scrimFlag} />
        <Dialog.Popup className="acx-dlg">
          {context && (
            <>
              <div className="acx-dh">
                <Dialog.Title className="acx-dt">{title}</Dialog.Title>
                <span className="acx-meta">
                  <span className="mono acx-num">
                    {numberText(context.bytes)} / {numberText(limit)}
                  </span>
                  <span>{t({ id: 'memory.agent.bytes', defaultMessage: 'bytes' })}</span>
                </span>
                <span className="acx-meta">
                  <span>{versionText()}</span>
                  <span className="mono acx-num">{context.epoch}</span>
                </span>
                {context.omitted > 0 && (
                  <span className="acx-meta">
                    {t(
                      {
                        id: 'memory.agent.omittedCount',
                        defaultMessage: '{count, plural, one {# left out} other {# left out}}',
                      },
                      { count: context.omitted },
                    )}
                  </span>
                )}
                <Dialog.Close
                  className="ib acx-end"
                  aria-label={t({ id: 'memory.agent.close', defaultMessage: 'Close' })}
                >
                  <X aria-hidden />
                </Dialog.Close>
              </div>
              <AgentContextBody context={context} />
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
