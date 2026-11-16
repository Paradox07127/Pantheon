import { t } from '../../i18n';

export interface Availability {
  enabled: boolean;
  reason: string | null;
}

const ENABLED: Availability = { enabled: true, reason: null };
const disabled = (reason: string): Availability => ({ enabled: false, reason });

/** A rejected bridge call as the failed result the bridge returns otherwise. */
export const ipcFailure = (reason: unknown) => ({
  ok: false as const,
  error: { code: 'ipc_failed', message: String(reason) },
});

export type EditorList =
  | { status: 'loading' }
  | { status: 'ready'; items: { id: string; name: string }[]; selected: string | null }
  | { status: 'error'; message: string };

export function editorPickerAvailability(
  list: EditorList,
  bridge: boolean,
  label: string,
): Availability {
  if (!bridge)
    return disabled(
      t({ id: 'settings.common.bridgeUnavailable', defaultMessage: 'Desktop bridge unavailable' }),
    );
  if (list.status === 'loading')
    return disabled(
      t(
        { id: 'settings.editor.reading', defaultMessage: '{label}: checking this machine' },
        { label },
      ),
    );
  if (list.status === 'error')
    return disabled(
      t(
        {
          id: 'settings.editor.readFailed',
          defaultMessage: '{label}: could not read the list ({message})',
        },
        { label, message: list.message },
      ),
    );
  if (list.items.length === 0)
    return disabled(
      t(
        { id: 'settings.editor.none', defaultMessage: '{label}: none found on this machine' },
        { label },
      ),
    );
  return ENABLED;
}
