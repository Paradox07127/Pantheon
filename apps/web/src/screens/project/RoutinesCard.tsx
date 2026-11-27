import { useId, useState } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { Dialog } from '@base-ui/react/dialog';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { Clip } from '../../components/Clip';
import { Failure } from '../../components/PanelBoundary';
import { Skeleton } from '../../components/Skeleton';
import { ageText, useNow } from '../../data/needs-you';
import { sendProjectCommand } from '../../data/project-read';
import { useProjectRoutines, type Routine } from '../../data/project-routines';
import { t } from '../../i18n';
import { scrimFlag } from '../../lib/root-flag';
import {
  draftOf,
  githubIssuesDraft,
  githubIssuesName,
  inputOf,
  problemsOf,
  runText,
  savedInput,
  scheduleText,
  stateText,
  type DraftField,
  type RoutineDraft,
  type RoutineInput,
} from './routines-model';

const saveRoutine = (projectId: string, routine: RoutineInput) =>
  sendProjectCommand('project.routine.save', { project_id: projectId, routine }, null);

/** The form that writes a new routine or changes one. */
export function RoutineEditor({
  routine,
  removed,
  save: keep,
  onBusy,
  onSaved,
  onCancel,
}: {
  /** The routine as listed now; the draft starts from the one the form opened on. */
  routine: RoutineInput | null;
  /** The routine being edited is no longer listed. */
  removed: boolean;
  /** Keeps the valid routine; a failure stays in the form. */
  save: (routine: RoutineInput) => Promise<{ ok: true } | { ok: false; error: string }>;
  onBusy: (busy: boolean) => void;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [opened] = useState(routine);
  const [draft, setDraft] = useState<RoutineDraft>(() => draftOf(routine));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const problems = problemsOf(draft);
  const change = (patch: Partial<RoutineDraft>) => setDraft({ ...draft, ...patch });
  const invalid = (field: DraftField) => problems.has(field) || undefined;
  const save = async () => {
    if (busy || removed || problems.size > 0) return;
    setBusy(true);
    onBusy(true);
    setFailed(null);
    const result = await keep(inputOf(draft, routine?.id, routine?.enabled ?? true, opened));
    setBusy(false);
    onBusy(false);
    if (!result.ok) setFailed(result.error);
    else onSaved();
  };
  const hours = t({ id: 'project.routines.hours', defaultMessage: 'Active hours' });
  const precheck = t({ id: 'project.routines.precheck', defaultMessage: 'Precheck' });
  const name = t({ id: 'project.routines.name', defaultMessage: 'Name' });
  const prompt = t({ id: 'project.routines.prompt', defaultMessage: 'Prompt' });
  const from = t({ id: 'project.routines.from', defaultMessage: 'From' });
  const to = t({ id: 'project.routines.to', defaultMessage: 'To' });
  const timeout = t({ id: 'project.routines.timeout', defaultMessage: 'Timeout (seconds)' });
  return (
    <>
      <div className="pj-rf">
        {opened === null && (
          <div className="pj-rf-row">
            <button
              type="button"
              className="btn ghost sm"
              disabled={busy}
              onClick={() => setDraft(githubIssuesDraft())}
            >
              {t(
                { id: 'project.routines.useTemplate', defaultMessage: 'Use template: {name}' },
                { name: githubIssuesName() },
              )}
            </button>
          </div>
        )}
        {removed && (
          <div className="pj-cerr" role="alert">
            {t({
              id: 'project.routines.removedNotice',
              defaultMessage: 'This routine has been deleted',
            })}
          </div>
        )}
        <div className="pj-rf-fld">
          <label className="pj-lb" htmlFor={`${id}-name`}>
            {name}
          </label>
          <input
            id={`${id}-name`}
            className="inp"
            aria-label={name}
            aria-invalid={invalid('name')}
            value={draft.name}
            readOnly={busy}
            onChange={(e) => change({ name: e.target.value })}
          />
        </div>
        <div className="pj-rf-fld">
          <label className="pj-lb" htmlFor={`${id}-prompt`}>
            {prompt}
          </label>
          <textarea
            id={`${id}-prompt`}
            className="inp pj-rf-txt"
            rows={4}
            aria-label={prompt}
            aria-invalid={invalid('prompt')}
            value={draft.prompt}
            readOnly={busy}
            onChange={(e) => change({ prompt: e.target.value })}
          />
        </div>
        <div className="pj-rf-fld">
          <label className="pj-lb" htmlFor={`${id}-when`}>
            {t({ id: 'project.routines.schedule', defaultMessage: 'Schedule' })}
          </label>
          <div className="pj-rf-row">
            <RadioGroup<RoutineDraft['schedule']>
              className="seg"
              aria-label={t({ id: 'project.routines.schedule', defaultMessage: 'Schedule' })}
              value={draft.schedule}
              disabled={busy}
              onValueChange={(schedule) => change({ schedule })}
            >
              <Radio.Root value="every">
                {t({ id: 'project.routines.scheduleEvery', defaultMessage: 'Every N minutes' })}
              </Radio.Root>
              <Radio.Root value="daily">
                {t({ id: 'project.routines.scheduleDaily', defaultMessage: 'Daily at HH:MM' })}
              </Radio.Root>
            </RadioGroup>
            {draft.schedule === 'every' ? (
              <input
                id={`${id}-when`}
                className="inp pj-rf-num"
                inputMode="numeric"
                aria-label={t({ id: 'project.routines.minutes', defaultMessage: 'Minutes' })}
                aria-invalid={invalid('every')}
                value={draft.every}
                readOnly={busy}
                onChange={(e) => change({ every: e.target.value })}
              />
            ) : (
              <input
                id={`${id}-when`}
                className="inp pj-rf-num"
                aria-label={t({ id: 'project.routines.time', defaultMessage: 'Time' })}
                aria-invalid={invalid('at')}
                value={draft.at}
                readOnly={busy}
                onChange={(e) => change({ at: e.target.value })}
              />
            )}
          </div>
        </div>
        <div className="pj-rf-row">
          <label className="pj-rf-sw">
            <input
              type="checkbox"
              className="ps-sw"
              checked={draft.hours}
              disabled={busy}
              onChange={(e) => change({ hours: e.target.checked })}
            />
            {hours}
          </label>
          {draft.hours && (
            <>
              <label className="pj-rf-sw">
                {from}
                <input
                  className="inp pj-rf-num"
                  aria-label={from}
                  aria-invalid={invalid('from')}
                  value={draft.from}
                  readOnly={busy}
                  onChange={(e) => change({ from: e.target.value })}
                />
              </label>
              <label className="pj-rf-sw">
                {to}
                <input
                  className="inp pj-rf-num"
                  aria-label={to}
                  aria-invalid={invalid('to')}
                  value={draft.to}
                  readOnly={busy}
                  onChange={(e) => change({ to: e.target.value })}
                />
              </label>
            </>
          )}
        </div>
        <div className="pj-rf-row">
          <label className="pj-rf-sw">
            <input
              type="checkbox"
              className="ps-sw"
              checked={draft.precheck}
              disabled={busy}
              onChange={(e) => change({ precheck: e.target.checked })}
            />
            {precheck}
          </label>
          {draft.precheck && (
            <label className="pj-rf-sw">
              {timeout}
              <input
                className="inp pj-rf-num"
                inputMode="numeric"
                aria-label={timeout}
                aria-invalid={invalid('timeout')}
                value={draft.timeout}
                readOnly={busy}
                onChange={(e) => change({ timeout: e.target.value })}
              />
            </label>
          )}
        </div>
        {draft.precheck && (
          <div className="pj-rf-fld">
            <label className="pj-lb" htmlFor={`${id}-argv`}>
              {t({ id: 'project.routines.command', defaultMessage: 'Command' })}
            </label>
            <textarea
              id={`${id}-argv`}
              className="inp pj-rf-txt mono"
              rows={3}
              spellCheck={false}
              aria-label={t({
                id: 'project.routines.argv',
                defaultMessage: 'Precheck command, one argument per line',
              })}
              placeholder={t({
                id: 'project.routines.argvExample',
                defaultMessage: 'gh\npr\nchecks',
              })}
              aria-invalid={invalid('argv')}
              value={draft.argv}
              readOnly={busy}
              onChange={(e) => change({ argv: e.target.value })}
            />
          </div>
        )}
        {failed && (
          <div className="pj-cerr" role="alert">
            {failed}
          </div>
        )}
      </div>
      <div className="pj-df">
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>
          {t({ id: 'sessions.parts.cancel', defaultMessage: 'Cancel' })}
        </button>
        <button
          type="button"
          className="btn pri"
          disabled={busy || removed || problems.size > 0}
          onClick={() => void save()}
        >
          {t({ id: 'project.routines.save', defaultMessage: 'Save' })}
        </button>
      </div>
    </>
  );
}

/** The project's timed routines: when each wakes the resident main agent and how its last run went. */
export function RoutinesCard({ projectId }: { projectId: string }) {
  const routines = useProjectRoutines(projectId);
  const now = useNow(60_000);
  // The routine a command is out for.
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ routine: Routine | null } | null>(null);
  // The open form whose save is out; it cannot be closed until the save returns.
  const [saving, setSaving] = useState<{ routine: Routine | null } | null>(null);
  const [removing, setRemoving] = useState<Routine | null>(null);
  const send = async (routine: Routine, run: () => ReturnType<typeof sendProjectCommand>) => {
    if (busy) return;
    setBusy(routine.id);
    setFailed(null);
    const result = await run();
    setBusy(null);
    if (!result.ok) setFailed(result.error);
    else routines.reload();
  };
  const ref = (routine: Routine) => ({ project_id: projectId, routine_id: routine.id });
  const runNow = (routine: Routine) =>
    send(routine, () => sendProjectCommand('project.routine.run', ref(routine), null));
  const toggle = (routine: Routine) =>
    send(routine, () =>
      saveRoutine(projectId, { ...savedInput(routine), enabled: !routine.enabled }),
    );
  const remove = async (routine: Routine) => {
    await send(routine, () => sendProjectCommand('project.routine.remove', ref(routine), null));
    setRemoving(null);
  };
  const title = t({ id: 'project.routines.title', defaultMessage: 'Routines' });
  const read = routines.read;
  const listed =
    editing?.routine && read ? read.routines.find((r) => r.id === editing.routine?.id) : undefined;
  return (
    <section className="pj-card" aria-label={title} aria-busy={routines.loading || undefined}>
      <div className="pj-ch">
        <h2 className="pj-h2">{title}</h2>
        <button
          type="button"
          className="btn ghost sm pj-end"
          onClick={() => setEditing({ routine: null })}
        >
          {t({ id: 'project.routines.new', defaultMessage: 'New routine' })}
        </button>
      </div>
      {routines.error && <Failure error={routines.error} onRetry={routines.reload} />}
      {failed && (
        <div className="pj-cerr" role="alert">
          {failed}
        </div>
      )}
      {!read && routines.loading && <Skeleton style={{ height: 9, width: 180 }} />}
      {read && read.routines.length > 0 && (
        <ul className="pj-ros">
          {read.routines.map((routine) => {
            const state = stateText(routine, now);
            const last = routine.last_run;
            return (
              <li key={routine.id} className="pj-ro" aria-label={routine.name}>
                <div className="pj-ro-h">
                  <Clip text={routine.name} className="pj-ro-nm" />
                  <span className="pj-dl">{scheduleText(routine)}</span>
                </div>
                {state && <span className="pj-rws-st">{state}</span>}
                <div className="pj-rw">
                  {last ? (
                    <>
                      <span className="pj-dl">{ageText(last.at, now)}</span>
                      <span className="pj-rws-st">{runText(last)}</span>
                    </>
                  ) : (
                    <span className="pj-sub">
                      {t({ id: 'project.routines.neverRun', defaultMessage: 'Not run yet' })}
                    </span>
                  )}
                </div>
                <div className="pj-ro-acts">
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={busy !== null}
                    onClick={() => void runNow(routine)}
                  >
                    {t({ id: 'project.routines.run', defaultMessage: 'Run now' })}
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={busy !== null}
                    onClick={() => void toggle(routine)}
                  >
                    {routine.enabled
                      ? t({ id: 'project.routines.pause', defaultMessage: 'Pause' })
                      : t({ id: 'project.routines.resume', defaultMessage: 'Resume' })}
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={busy !== null}
                    onClick={() => setEditing({ routine })}
                  >
                    {t({ id: 'project.routines.edit', defaultMessage: 'Edit' })}
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm dng"
                    disabled={busy !== null}
                    onClick={() => setRemoving(routine)}
                  >
                    {t({ id: 'project.routines.remove', defaultMessage: 'Delete' })}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Dialog.Root
        open={editing !== null}
        onOpenChange={(next) => {
          if (!next && saving !== editing) setEditing(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="pj-scrim" ref={scrimFlag} />
          <Dialog.Popup className="pj-dlg pj-rfd pop">
            <div className="pj-dh">
              <Dialog.Title className="pj-dt">
                {editing?.routine
                  ? t({ id: 'project.routines.editTitle', defaultMessage: 'Edit routine' })
                  : t({ id: 'project.routines.new', defaultMessage: 'New routine' })}
              </Dialog.Title>
            </div>
            {editing && (
              <RoutineEditor
                key={editing.routine?.id ?? ''}
                routine={listed ?? editing.routine}
                removed={editing.routine !== null && read !== null && listed === undefined}
                save={(routine) => saveRoutine(projectId, routine)}
                onBusy={(on) => setSaving((now) => (on ? editing : now === editing ? null : now))}
                onSaved={() => {
                  setEditing((now) => (now === editing ? null : now));
                  routines.reload();
                }}
                onCancel={() => setEditing(null)}
              />
            )}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
      <AlertDialog.Root
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next) setRemoving(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="pj-scrim" ref={scrimFlag} />
          <AlertDialog.Popup className="pj-dlg pj-rm pop">
            <div className="pj-dh">
              <AlertDialog.Title className="pj-dt">
                {t(
                  { id: 'project.routines.confirmRemove', defaultMessage: 'Delete {name}?' },
                  { name: removing?.name ?? '' },
                )}
              </AlertDialog.Title>
            </div>
            <div className="pj-df">
              <AlertDialog.Close className="btn">
                {t({ id: 'sessions.parts.cancel', defaultMessage: 'Cancel' })}
              </AlertDialog.Close>
              <button
                type="button"
                className="btn dng"
                disabled={busy !== null}
                onClick={() => removing && void remove(removing)}
              >
                {t({ id: 'project.routines.remove', defaultMessage: 'Delete' })}
              </button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </section>
  );
}
