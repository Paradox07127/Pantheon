import { useState } from 'react';
import { shortId } from '../data/format';
import { t } from '../i18n';

/** The start of a long id, the whole id in its title, and a button that copies the whole id. */
export function IdText({ id }: { id: string }) {
  const [failed, setFailed] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(id);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }
  return (
    <span className="idt">
      <span className="mono" title={id}>
        {shortId(id)}
      </span>
      <button
        type="button"
        className="idt-copy"
        aria-label={t({ id: 'components.idText.copyLabel', defaultMessage: 'Copy {id}' }, { id })}
        onClick={() => void copy()}
      >
        {t({ id: 'components.idText.copy', defaultMessage: 'Copy' })}
      </button>
      {failed && (
        <span role="alert">
          {t({ id: 'components.idText.copyFailed', defaultMessage: "Couldn't copy" })}
        </span>
      )}
    </span>
  );
}
