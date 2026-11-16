import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, X } from 'lucide-react';
import type { BridgeResult } from '@pantheon/protocol';
import { PathText } from '../../components/PathText';
import { reasonText } from '../../data/needs-you';
import { t } from '../../i18n';
import { addEnvRow, addRoots, checkEnvironment, rootErrors, type EnvRow } from './environment';
import './project-setup.css';

/** The project's folders as one list of equals; empty, it offers one large button to pick some. */
export function FolderFields({
  value,
  onChange,
  disabled = false,
}: {
  value: string[];
  onChange: (roots: string[]) => void;
  disabled?: boolean;
}) {
  const [errors, setErrors] = useState<{ text: string; detail: string }[]>([]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // The picker resolves after the props may have changed; merge into the newest ones.
  const latest = useRef({ value, onChange });
  useEffect(() => {
    latest.current = { value, onChange };
  });
  const rows = rootErrors(value);

  async function choose() {
    const bridge = window.pantheon;
    if (!bridge) {
      setErrors([{ text: reasonText('bridge_unavailable'), detail: '' }]);
      return;
    }
    const result = await bridge
      .chooseDirectories()
      .catch((reason: unknown): BridgeResult<string[]> => ({
        ok: false,
        error: { code: 'ipc_failed', message: String(reason) },
      }));
    if (!alive.current) return;
    if (!result.ok) {
      setErrors([{ text: reasonText(result.error.code), detail: result.error.message }]);
      return;
    }
    if (result.value.length === 0) return;
    const current = latest.current;
    const added = addRoots(current.value, result.value);
    setErrors(added.rejected.map((r) => ({ text: r.error, detail: r.path })));
    if (added.roots.length > current.value.length) current.onChange(added.roots);
  }

  return (
    <div className="ev">
      <span className="pj-lb">
        {t({ id: 'projects.folders.label', defaultMessage: 'Folders' })}
      </span>
      {value.length === 0 ? (
        <button
          type="button"
          className="btn ev-pick"
          disabled={disabled}
          onClick={() => void choose()}
        >
          {t({ id: 'projects.folders.choose', defaultMessage: 'Choose folders…' })}
        </button>
      ) : (
        <>
          <div className="ev-list">
            {value.map((root, i) => (
              <div key={`${i}:${root}`} className="ev-dir">
                <PathText path={root} className="mono ev-path" />
                <button
                  type="button"
                  className="ib"
                  aria-label={t(
                    { id: 'projects.folders.remove', defaultMessage: 'Remove {root}' },
                    { root },
                  )}
                  disabled={disabled}
                  onClick={() => onChange(value.filter((_, j) => j !== i))}
                >
                  <X aria-hidden="true" />
                </button>
                {rows[i] && <span className="ps-err">{rows[i]}</span>}
              </div>
            ))}
          </div>
          <button
            type="button"
            className="btn ev-add"
            disabled={disabled}
            onClick={() => void choose()}
          >
            {t({ id: 'projects.folders.add', defaultMessage: 'Add folders…' })}
          </button>
        </>
      )}
      {errors.length > 0 && (
        <div className="ev-list" role="alert">
          {errors.map((error, i) => (
            <div key={i} className="ps-err">
              {error.text}
              {error.detail && error.detail !== error.text && (
                <span className="mono">
                  {t(
                    { id: 'projects.folders.errorDetail', defaultMessage: ', {detail}' },
                    { detail: error.detail },
                  )}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Environment variable rows; each value stays hidden until shown. */
export function VariableFields({
  value,
  onChange,
  disabled = false,
}: {
  value: EnvRow[];
  onChange: (env: EnvRow[]) => void;
  disabled?: boolean;
}) {
  const [shown, setShown] = useState<ReadonlySet<number>>(new Set());
  const check = checkEnvironment({ roots: [], env: value });

  const setRow = (index: number, field: 'key' | 'value', text: string) =>
    onChange(value.map((r, i) => (i === index ? { ...r, [field]: text } : r)));

  const toggle = (id: number) =>
    setShown((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // Row ids are reused once their row is gone, so a removed or new row must not stay shown.
  const hide = (id: number) =>
    setShown((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });

  const add = () => {
    const next = addEnvRow(value);
    hide(next.at(-1)!.id);
    onChange(next);
  };

  return (
    <div className="ev">
      <span className="pj-lb">
        {t({ id: 'projects.variables.label', defaultMessage: 'Environment variables' })}
      </span>
      {value.length > 0 && (
        <div className="ev-list">
          {value.map((row, i) => {
            const n = i + 1;
            const bad = check.rows[i];
            const visible = shown.has(row.id);
            return (
              <div
                key={row.id}
                className="ev-var"
                role="group"
                aria-label={t(
                  { id: 'projects.variables.row', defaultMessage: 'Variable {n}' },
                  { n },
                )}
              >
                <span className={bad ? 'pj-inp bad' : 'pj-inp'}>
                  <input
                    className="mono"
                    aria-label={t(
                      { id: 'projects.variables.name', defaultMessage: 'Name of variable {n}' },
                      { n },
                    )}
                    aria-invalid={bad ? true : undefined}
                    spellCheck={false}
                    autoComplete="off"
                    disabled={disabled}
                    value={row.key}
                    onChange={(e) => setRow(i, 'key', e.target.value)}
                  />
                </span>
                <span className="pj-inp">
                  <input
                    type={visible ? 'text' : 'password'}
                    aria-label={t(
                      { id: 'projects.variables.value', defaultMessage: 'Value of variable {n}' },
                      { n },
                    )}
                    spellCheck={false}
                    autoComplete="off"
                    disabled={disabled}
                    value={row.value}
                    onChange={(e) => setRow(i, 'value', e.target.value)}
                  />
                </span>
                <button
                  type="button"
                  className="ib"
                  aria-label={
                    visible
                      ? t(
                          {
                            id: 'projects.variables.hide',
                            defaultMessage: 'Hide the value of variable {n}',
                          },
                          { n },
                        )
                      : t(
                          {
                            id: 'projects.variables.show',
                            defaultMessage: 'Show the value of variable {n}',
                          },
                          { n },
                        )
                  }
                  aria-pressed={visible}
                  onClick={() => toggle(row.id)}
                >
                  {visible ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
                </button>
                <button
                  type="button"
                  className="ib"
                  aria-label={t(
                    { id: 'projects.variables.delete', defaultMessage: 'Delete variable {n}' },
                    { n },
                  )}
                  disabled={disabled}
                  onClick={() => {
                    hide(row.id);
                    onChange(value.filter((_, j) => j !== i));
                  }}
                >
                  <X aria-hidden="true" />
                </button>
                {bad && <span className="ps-err">{bad}</span>}
              </div>
            );
          })}
        </div>
      )}
      <button type="button" className="btn ev-add" disabled={disabled} onClick={add}>
        {t({ id: 'projects.variables.add', defaultMessage: 'Add variable' })}
      </button>
    </div>
  );
}
