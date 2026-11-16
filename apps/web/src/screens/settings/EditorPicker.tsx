import { useCallback, useEffect, useState } from 'react';
import { Select } from '@base-ui/react/select';
import { Check, ChevronDown } from 'lucide-react';
import { Tip } from '../../components/Tip';
import { t } from '../../i18n';
import { editorPickerAvailability, ipcFailure, type EditorList } from './editors';

export function EditorPicker({
  label,
  list: listMethod,
  choose: chooseMethod,
  unavailable,
  ariaLabel = label,
}: {
  label: string;
  list: 'editors' | 'terminals';
  choose: 'chooseEditor' | 'chooseTerminal';
  unavailable: string;
  /** The control's name when its row names the setting differently from the label. */
  ariaLabel?: string;
}) {
  const [list, setList] = useState<EditorList>({ status: 'loading' });
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    const bridge = window.pantheon;
    if (!bridge) return;
    void bridge[listMethod]()
      .catch(ipcFailure)
      .then((result) =>
        setList(
          result.ok
            ? {
                status: 'ready',
                items: 'editors' in result.value ? result.value.editors : result.value.terminals,
                selected: result.value.selected,
              }
            : { status: 'error', message: result.error.message },
        ),
      );
  }, [listMethod]);
  // Rereads on return to the window: an empty or failed list has no select to reopen.
  useEffect(() => {
    reload();
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, [reload]);
  const choose = (id: string) => {
    const bridge = window.pantheon;
    if (!bridge) return;
    setError(null);
    void bridge[chooseMethod](id)
      .catch(ipcFailure)
      .then((result) => {
        if (result.ok)
          setList((prev) => (prev.status === 'ready' ? { ...prev, selected: id } : prev));
        else
          setError(
            result.error.code === unavailable
              ? t(
                  {
                    id: 'settings.editor.gone',
                    defaultMessage:
                      '{label}: this one is no longer on this machine; choose another',
                  },
                  { label },
                )
              : t(
                  {
                    id: 'settings.editor.chooseFailed',
                    defaultMessage: '{label}: could not choose ({message})',
                  },
                  { label, message: result.error.message },
                ),
          );
      });
  };
  const state = editorPickerAvailability(list, window.pantheon !== undefined, label);
  const items = list.status === 'ready' ? list.items : [];
  const selected = list.status === 'ready' ? list.selected : null;
  return (
    <span className="tk-editor">
      {state.enabled ? (
        <Select.Root<string>
          items={items.map((e) => ({ value: e.id, label: e.name }))}
          value={selected}
          onValueChange={(id) => {
            if (id !== null && id !== selected) choose(id);
          }}
          onOpenChange={(open) => {
            if (open) reload();
          }}
        >
          <Select.Trigger className="btn tk-select" aria-label={ariaLabel}>
            <Select.Value
              placeholder={
                listMethod === 'editors'
                  ? t({ id: 'settings.editor.chooseEditor', defaultMessage: 'Choose an editor' })
                  : t({ id: 'settings.editor.chooseTerminal', defaultMessage: 'Choose a terminal' })
              }
            />
            <Select.Icon className="mu">
              <ChevronDown className="ic-sm" aria-hidden="true" />
            </Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Positioner
              side="bottom"
              sideOffset={6}
              alignItemWithTrigger={false}
              style={{ zIndex: 60 }}
            >
              <Select.Popup className="tk-menu pop">
                <Select.List>
                  {items.map((e) => (
                    <Select.Item key={e.id} value={e.id} className="tk-item">
                      <Select.ItemIndicator className="tk-check">
                        <Check className="ic-sm" aria-hidden="true" />
                      </Select.ItemIndicator>
                      <Select.ItemText>{e.name}</Select.ItemText>
                    </Select.Item>
                  ))}
                </Select.List>
              </Select.Popup>
            </Select.Positioner>
          </Select.Portal>
        </Select.Root>
      ) : (
        <Tip content={state.reason ?? ''}>
          <button
            type="button"
            className="btn tk-select"
            aria-disabled="true"
            aria-label={ariaLabel}
          >
            {label}{' '}
            <span className="mu">
              <ChevronDown className="ic-sm" aria-hidden="true" />
            </span>
          </button>
        </Tip>
      )}
      {error && (
        <span className="tk-err" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
