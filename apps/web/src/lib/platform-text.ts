import { t } from '../i18n';

/** The menu label that shows a path in the system file manager. */
export function revealText(): string {
  const agent = globalThis.navigator?.userAgent ?? '';
  if (/Mac/.test(agent)) return t({ id: 'lib.reveal.finder', defaultMessage: 'Show in Finder' });
  if (/Windows/.test(agent))
    return t({ id: 'lib.reveal.explorer', defaultMessage: 'Show in File Explorer' });
  return t({ id: 'lib.reveal.fileManager', defaultMessage: 'Show in file manager' });
}
