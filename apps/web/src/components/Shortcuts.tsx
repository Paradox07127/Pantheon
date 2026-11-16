import { useEffect, useSyncExternalStore, type KeyboardEvent } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Keyboard, Search } from 'lucide-react';
import { t } from '../i18n';
import {
  digitKeys,
  keyText,
  pressedKeys,
  rebindable,
  recordable,
  sameKeys,
  SCOPE_LABELS,
  setShortcut,
  shortcutKeys,
  SHORTCUTS,
  useShortcutOverrides,
  type ShortcutId,
  type ShortcutScope,
} from '../lib/shortcuts';
import { Tip } from './Tip';
import './shortcuts.css';
import './shortcut-settings.css';

const SCOPES = Object.keys(SCOPE_LABELS) as ShortcutScope[];

interface Editing {
  /** The entry the next press gives its keys. */
  recording: ShortcutId | null;
  /** The keys an entry could not take, and the entry that holds them. */
  conflict: { id: ShortcutId; keys: string; holder: ShortcutId } | null;
  /** A name typed, or keys pressed when byKeys. */
  query: string;
  byKeys: boolean;
}

const IDLE: Editing = { recording: null, conflict: null, query: '', byKeys: false };
let editing = IDLE;
const editors = new Set<() => void>();
const subscribe = (listener: () => void) => {
  editors.add(listener);
  return () => void editors.delete(listener);
};
const getEditing = () => editing;
const edit = (patch: Partial<Editing>) => {
  editing = { ...editing, ...patch };
  editors.forEach((listener) => listener());
};

/**
 * The entry's current keys as a keycap that shows only while ⌘ is held; inside an icon button it
 * sits on the button's corner. `digit` writes one key of the session number entry.
 */
export function KeyHint({ id, digit }: { id: ShortcutId; digit?: number }) {
  useShortcutOverrides();
  const keys = shortcutKeys(id);
  if (!keys) return null;
  return (
    <span className="kbd hk" aria-hidden="true">
      {keyText(digit === undefined ? keys : digitKeys(keys, digit))}
    </span>
  );
}

const labelOf = (id: ShortcutId) => SHORTCUTS.find((s) => s.id === id)!.label;
const pressKeys = () => t({ id: 'components.shortcuts.pressKeys', defaultMessage: 'Press keys' });

// Tab and Shift+Tab still move focus out of a field that reads keys.
const movesFocus = (e: KeyboardEvent) => e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey;

/** The keys a field that reads keys takes from the event; the window's shortcuts do not see it. */
function takeKeys(e: KeyboardEvent): string | null {
  e.preventDefault();
  e.stopPropagation();
  return pressedKeys(e);
}

function record(id: ShortcutId, scope: ShortcutScope, e: KeyboardEvent) {
  if (movesFocus(e)) return;
  const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
  const keys = takeKeys(e);
  if (keys === 'Escape') return edit({ recording: null });
  // Global keys without ⌘, ⌃ or ⌥ would be taken from typing.
  if (keys === null || (plain && (scope === 'app' || scope === 'projects'))) return;
  if (!recordable(id, keys)) return;
  const holder = setShortcut(id, keys);
  edit({ recording: null, conflict: holder ? { id, keys, holder } : null });
}

/** Every registry entry with the keys in use, one table per scope. */
export function ShortcutList() {
  useShortcutOverrides();
  return SCOPES.map((scope) => {
    const entries = SHORTCUTS.filter((s) => s.scope === scope);
    if (entries.length === 0) return null;
    return (
      <div key={scope} role="group" aria-label={SCOPE_LABELS[scope]} className="ks-group">
        <h4>{SCOPE_LABELS[scope]}</h4>
        <table className="ps-keys">
          <tbody>
            {entries.map((s) => (
              <tr key={s.id}>
                <td>
                  {shortcutKeys(s.id) && <span className="kbd">{keyText(shortcutKeys(s.id))}</span>}
                </td>
                <td>{s.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  });
}

/** One entry on the settings page: its name and its keycap, which records keys on a click. */
function keyRow(id: ShortcutId, scope: ShortcutScope, now: Editing) {
  const { recording, conflict } = now;
  const name = labelOf(id);
  const keys = shortcutKeys(id);
  const active = recording === id;
  return (
    <div key={id} className="kset-row" data-recording={active || undefined}>
      <span>{name}</span>
      {rebindable(id) ? (
        <button
          type="button"
          className="kset-kc"
          aria-label={t(
            { id: 'components.shortcuts.recordFor', defaultMessage: 'Record keys for {name}' },
            { name },
          )}
          aria-pressed={active}
          onClick={() => edit({ recording: active ? null : id, conflict: null })}
          onKeyDown={active ? (e) => record(id, scope, e) : undefined}
          onBlur={() => active && edit({ recording: null })}
        >
          {active ? (
            <span className="kbd">{pressKeys()}</span>
          ) : keys ? (
            <span className="kbd">{keyText(keys)}</span>
          ) : (
            <span className="kbd kset-none">
              {t({ id: 'components.shortcuts.record', defaultMessage: 'Record keys' })}
            </span>
          )}
        </button>
      ) : (
        <span className="kset-fix">{keys && <span className="kbd">{keyText(keys)}</span>}</span>
      )}
      {conflict?.id === id && (
        <span className="kset-err" role="alert">
          {t(
            { id: 'components.shortcuts.taken', defaultMessage: '{keys} is taken by {name}' },
            { keys: keyText(conflict.keys), name: labelOf(conflict.holder) },
          )}
        </span>
      )}
    </div>
  );
}

/** The shortcuts settings page: a search over the entries, then one group per scope whose rows record keys. */
export function ShortcutSettings() {
  useShortcutOverrides();
  const now = useSyncExternalStore(subscribe, getEditing, getEditing);
  // Leaving the page ends a recording and clears the search.
  useEffect(() => () => edit(IDLE), []);
  const { query, byKeys } = now;
  const name = query.trim().toLowerCase();
  const shown = (id: ShortcutId) =>
    byKeys
      ? query === '' || sameKeys(shortcutKeys(id), query)
      : labelOf(id).toLowerCase().includes(name);
  const searchLabel = t({ id: 'components.shortcuts.search', defaultMessage: 'Search shortcuts' });
  const byKeysLabel = t({
    id: 'components.shortcuts.searchByKeys',
    defaultMessage: 'Search by keys',
  });
  return (
    <div className="kset" data-setting-id="shortcuts.keys">
      <div className="kset-srch">
        <label className="field">
          <Search className="ic-sm" aria-hidden="true" />
          <input
            type="search"
            aria-label={searchLabel}
            placeholder={byKeys ? pressKeys() : searchLabel}
            value={byKeys && query !== '' ? keyText(query) : query}
            readOnly={byKeys}
            onChange={(e) => edit({ query: e.target.value })}
            onKeyDown={
              byKeys
                ? (e) => {
                    if (movesFocus(e)) return;
                    const keys = takeKeys(e);
                    if (keys !== null) edit({ query: keys });
                  }
                : undefined
            }
          />
        </label>
        <Tip content={byKeysLabel}>
          <button
            type="button"
            className="ib"
            aria-label={byKeysLabel}
            aria-pressed={byKeys}
            onClick={() => edit({ byKeys: !byKeys, query: '' })}
          >
            <Keyboard aria-hidden="true" />
          </button>
        </Tip>
      </div>
      {SCOPES.map((scope) => {
        const entries = SHORTCUTS.filter((s) => s.scope === scope && shown(s.id));
        if (entries.length === 0) return null;
        return (
          <div key={scope} className="kset-sec">
            <span className="cap">{SCOPE_LABELS[scope]}</span>
            <div className="kset-grp" role="group" aria-label={SCOPE_LABELS[scope]}>
              {entries.map((s) => keyRow(s.id, scope, now))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** ?: the shortcut list over the current screen. */
export function ShortcutSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="pj-scrim" />
        <Dialog.Popup className="pj-dlg pop ks-dlg">
          <div className="pj-dh">
            <Dialog.Title className="pj-dt">
              {t({ id: 'components.shortcuts.title', defaultMessage: 'Keyboard shortcuts' })}
            </Dialog.Title>
          </div>
          <div className="ks-bd">
            <ShortcutList />
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
