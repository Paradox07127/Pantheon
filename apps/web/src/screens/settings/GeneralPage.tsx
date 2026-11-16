import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Minus, Plus } from 'lucide-react';
import type { BridgeResult, DesktopBridge } from '@pantheon/protocol';
import { Select } from '../../components/Select';
import { toast } from '../../components/Toast';
import { useAppSettings } from '../../data/app-settings';
import { failureText } from '../../data/needs-you';
import { setNotificationPrefs, useNotificationPrefs } from '../../data/notifications';
import { voiceSettingsChanged } from '../../data/voice';
import {
  chooseLocale,
  LOCALE_NAMES,
  LOCALES,
  localeChoice,
  t,
  type LocaleChoice,
} from '../../i18n';
import { ipcFailure } from './editors';
import { Row, Section } from './ProjectSettingsScreen';
import { AutoGitInitRow } from './ProjectsPage';
import './general-page.css';

/** The language of the interface, whether a running session keeps the computer awake, and the desktop app's own settings. */
export function GeneralPage() {
  const prefs = useNotificationPrefs();
  const language = t({ id: 'settings.appearance.language', defaultMessage: 'Language' });
  const keepAwake = t({
    id: 'settings.keepAwake.toggle',
    defaultMessage: 'Prevent sleep while a session runs',
  });
  const languages: { value: LocaleChoice; label: string }[] = [
    {
      value: 'system',
      label: t({ id: 'settings.appearance.languageSystem', defaultMessage: 'Match system' }),
    },
    ...LOCALES.map((locale) => ({ value: locale, label: LOCALE_NAMES[locale] })),
  ];
  const chosen = localeChoice();
  const choose = (next: LocaleChoice) =>
    void chooseLocale(next)
      ?.catch(ipcFailure)
      .then((result) => {
        const saved = result as BridgeResult<unknown>;
        if (!saved.ok) toast({ title: failureText(saved.error), kind: 'failure' });
      });
  return (
    <>
      <Section>
        <div className="ps-rows">
          <Row label={language} settingId="general.language">
            <Select value={chosen} onChange={choose} options={languages} aria-label={language} />
          </Row>
          <Row label={keepAwake} settingId="general.keepAwake">
            <input
              type="checkbox"
              className="ps-sw"
              aria-label={keepAwake}
              checked={prefs.keep_awake}
              onChange={(e) => setNotificationPrefs({ keep_awake: e.target.checked })}
            />
          </Row>
          {window.pantheon && <OpenAtLoginRow />}
          {window.pantheon && <ShellRows />}
          {window.pantheon && <AutoArchiveRow />}
          {window.pantheon && <AutoGitInitRow />}
        </div>
      </Section>
      {window.pantheon && <BaselineSection />}
    </>
  );
}

const ROUNDS_LOW = 1;
const ROUNDS_HIGH = 5;
type BaselineKey = 'baseline_rounds' | 'baseline_visuals' | 'baseline_range_story';

/** How a project baseline asks and explains: its question rounds, its charts and its story of recent commits. */
function BaselineSection() {
  const { settings, error, saving, save } = useAppSettings();
  // The setting last saved, whose row a failure shows under; null for a failed read.
  const [last, setLast] = useState<BaselineKey | null>(null);
  const write = (key: BaselineKey, value: number | boolean) => {
    setLast(key);
    void save({ [key]: value });
  };
  const alert = (key: BaselineKey | null) =>
    error !== null &&
    last === key && (
      <div className="ps-err gp-err" role="alert">
        {error}
      </div>
    );
  const title = t({ id: 'settings.general.baseline', defaultMessage: 'Baseline' });
  const rounds = t({ id: 'settings.general.baselineRounds', defaultMessage: 'Follow-up rounds' });
  const switchRow = (key: BaselineKey, label: string, settingId: string) =>
    settings && (
      <>
        <Row label={label} settingId={settingId}>
          <input
            type="checkbox"
            className="ps-sw"
            aria-label={label}
            checked={settings[key] as boolean}
            disabled={saving}
            onChange={(e) => write(key, e.target.checked)}
          />
        </Row>
        {alert(key)}
      </>
    );
  const value = settings?.baseline_rounds ?? ROUNDS_HIGH;
  const step = (by: number) => {
    const to = value + by;
    return {
      'aria-disabled': to < ROUNDS_LOW || to > ROUNDS_HIGH,
      onClick: () => {
        if (to >= ROUNDS_LOW && to <= ROUNDS_HIGH) write('baseline_rounds', to);
      },
    };
  };
  return (
    <Section title={title}>
      <div className="ps-rows">
        {settings && (
          <>
            <Row label={rounds} settingId="general.baselineRounds">
              <span className="gp-stp" role="group" aria-label={rounds}>
                <button
                  type="button"
                  className="ib"
                  aria-label={t({
                    id: 'settings.general.baselineFewerRounds',
                    defaultMessage: 'Fewer rounds',
                  })}
                  {...step(-1)}
                >
                  <Minus aria-hidden="true" />
                </button>
                <output aria-live="polite">{value}</output>
                <button
                  type="button"
                  className="ib"
                  aria-label={t({
                    id: 'settings.general.baselineMoreRounds',
                    defaultMessage: 'More rounds',
                  })}
                  {...step(1)}
                >
                  <Plus aria-hidden="true" />
                </button>
              </span>
            </Row>
            {alert('baseline_rounds')}
          </>
        )}
        {switchRow(
          'baseline_visuals',
          t({ id: 'settings.general.baselineVisuals', defaultMessage: 'Draw explanation charts' }),
          'general.baselineVisuals',
        )}
        {switchRow(
          'baseline_range_story',
          t({
            id: 'settings.general.baselineRangeStory',
            defaultMessage: 'Explain recent history on confirm',
          }),
          'general.baselineRangeStory',
        )}
        {alert(null)}
      </div>
    </Section>
  );
}

/** Whether the system opens the app at login; only macOS and Windows keep login items for it. */
function OpenAtLoginRow() {
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void window.pantheon
      ?.openAtLogin()
      .catch(ipcFailure)
      .then((result) => {
        if (result.ok) setOn(result.value);
        else
          setError(
            t(
              {
                id: 'settings.general.shellReadFailed',
                defaultMessage: 'Could not read the desktop app settings: {message}',
              },
              { message: result.error.message },
            ),
          );
      });
  }, []);
  const set = (next: boolean) => {
    setError(null);
    void window.pantheon
      ?.setOpenAtLogin(next)
      .catch(ipcFailure)
      .then((result) => {
        if (result.ok) setOn(result.value);
        else
          setError(
            t(
              {
                id: 'settings.general.shellSaveFailed',
                defaultMessage: 'Could not save the setting: {message}',
              },
              { message: result.error.message },
            ),
          );
      });
  };
  const label = t({ id: 'settings.general.openAtLogin', defaultMessage: 'Open at login' });
  return (
    <>
      {on !== null && (
        <Row label={label} settingId="general.openAtLogin">
          <input
            type="checkbox"
            className="ps-sw"
            aria-label={label}
            checked={on}
            onChange={(e) => set(e.target.checked)}
          />
        </Row>
      )}
      {error !== null && (
        <div className="ps-err gp-err" role="alert">
          {error}
        </div>
      )}
    </>
  );
}

/** Whether the daemon archives a session once it is merged. */
function AutoArchiveRow() {
  const { settings, error, saving, save } = useAppSettings();
  const label = t({
    id: 'settings.general.autoArchiveMerged',
    defaultMessage: 'Archive sessions after they merge',
  });
  return (
    <>
      {settings && (
        <Row label={label} settingId="general.autoArchiveMerged">
          <input
            type="checkbox"
            className="ps-sw"
            aria-label={label}
            checked={settings.auto_archive_merged}
            disabled={saving}
            onChange={(e) => void save({ auto_archive_merged: e.target.checked })}
          />
        </Row>
      )}
      {error !== null && (
        <div className="ps-err gp-err" role="alert">
          {error}
        </div>
      )}
    </>
  );
}

type ShellPrefs = Required<Parameters<DesktopBridge['setShellPrefs']>[0]>;
type ShellSwitch = 'keep_running_on_close' | 'show_tray_icon' | 'voice_input';
type IconShape = ShellPrefs['tray_icon'];
type IconColour = ShellPrefs['app_icon'] extends `${string}-${infer Colour}` ? Colour : never;

const ICON_IMAGES = import.meta.glob<string>('../../assets/app-icons/*.png', {
  eager: true,
  import: 'default',
});
const iconImage = (icon: ShellPrefs['app_icon']) =>
  ICON_IMAGES[`../../assets/app-icons/${icon}.png`];
const ALL_COLOURS: readonly IconColour[] = [
  'travertine',
  'black',
  'white',
  'dusk',
  'terracotta',
  'lapis',
];
/** The colours each shape comes in; the desktop shell's APP_ICONS holds the same pairs. */
const SHAPE_COLOURS: Record<IconShape, readonly IconColour[]> = {
  pantheon: ['travertine', 'black', 'white'],
  monad: ALL_COLOURS,
  sigma: ALL_COLOURS,
};
const shapeNames = (): Record<IconShape, string> => ({
  pantheon: t({ id: 'settings.general.iconShapePantheon', defaultMessage: 'Pantheon' }),
  monad: t({ id: 'settings.general.iconShapeMonad', defaultMessage: 'Monad' }),
  sigma: t({ id: 'settings.general.iconShapeSigma', defaultMessage: 'Sigma' }),
});
const colourNames = (): Record<IconColour, string> => ({
  travertine: t({ id: 'settings.general.iconColourTravertine', defaultMessage: 'Travertine' }),
  black: t({ id: 'settings.general.iconColourBlack', defaultMessage: 'Black' }),
  white: t({ id: 'settings.general.iconColourWhite', defaultMessage: 'White' }),
  dusk: t({ id: 'settings.general.iconColourDusk', defaultMessage: 'Dusk' }),
  terracotta: t({ id: 'settings.general.iconColourTerracotta', defaultMessage: 'Terracotta' }),
  lapis: t({ id: 'settings.general.iconColourLapis', defaultMessage: 'Lapis' }),
});

/** A menu bar icon as the menu bar draws it, in the text colour. */
function TrayGlyph({ shape }: { shape: IconShape }) {
  return (
    <svg width={18} height={18} viewBox="0 0 36 36" aria-hidden="true">
      <g
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2.5}
      >
        {shape === 'pantheon' ? (
          <>
            <polygon points="4,14 18,6.5 32,14" fill="currentColor" />
            <line x1="7" y1="17.5" x2="29" y2="17.5" strokeWidth={1.6} />
            <line x1="9" y1="21" x2="9" y2="27.5" strokeWidth={3} />
            <line x1="15" y1="21" x2="15" y2="27.5" strokeWidth={3} />
            <line x1="21" y1="21" x2="21" y2="27.5" strokeWidth={3} />
            <line x1="27" y1="21" x2="27" y2="27.5" strokeWidth={3} />
            <line x1="4" y1="31" x2="32" y2="31" />
          </>
        ) : shape === 'monad' ? (
          <>
            <circle cx="18" cy="18" r="12.5" />
            <circle cx="18" cy="18" r="4" fill="currentColor" stroke="none" />
          </>
        ) : (
          <path d="M27 11 V7.5 H9 L18 18 L9 28.5 H27 V25" strokeWidth={3} />
        )}
      </g>
    </svg>
  );
}

/** The last path segment, on macOS, Linux or Windows. */
const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

/** The settings the desktop shell keeps for this machine; only the desktop app has them. */
function ShellRows() {
  const [prefs, setPrefs] = useState<ShellPrefs | null>(null);
  // key is the setting whose row the failure shows under; null before any row is there.
  const [error, setError] = useState<{ key: keyof ShellPrefs | null; message: string } | null>(
    null,
  );
  useEffect(() => {
    void window.pantheon
      ?.shellPrefs()
      .catch(ipcFailure)
      .then((result) => {
        if (result.ok) setPrefs(result.value);
        else
          setError({
            key: null,
            message: t(
              {
                id: 'settings.general.shellReadFailed',
                defaultMessage: 'Could not read the desktop app settings: {message}',
              },
              { message: result.error.message },
            ),
          });
      });
  }, []);
  const failed = (key: keyof ShellPrefs, message: string) =>
    setError({
      key,
      message: t(
        {
          id: 'settings.general.shellSaveFailed',
          defaultMessage: 'Could not save the setting: {message}',
        },
        { message },
      ),
    });
  // Only the latest save or choice sets the prefs; an earlier one answering late holds older values.
  const latest = useRef(0);
  const save = (key: keyof ShellPrefs, patch: Partial<ShellPrefs>) => {
    setError(null);
    const at = ++latest.current;
    void window.pantheon
      ?.setShellPrefs(patch)
      .catch(ipcFailure)
      .then((result) => {
        if (!result.ok) return failed(key, result.error.message);
        if (at === latest.current) setPrefs(result.value);
        if (key === 'voice_input' || key === 'voice_engine') voiceSettingsChanged();
      });
  };
  // The shell saves the path the user picks; the page never sends one.
  const choose = () => {
    setError(null);
    const at = ++latest.current;
    void window.pantheon
      ?.chooseVoiceEngine()
      .catch(ipcFailure)
      .then((result) => {
        if (!result.ok) return failed('voice_engine', result.error.message);
        const path = result.value;
        if (path === null) return;
        if (at === latest.current)
          setPrefs((before) => before && { ...before, voice_engine: path });
        voiceSettingsChanged();
      });
  };
  const alert = (key: keyof ShellPrefs | null) =>
    error !== null &&
    error.key === key && (
      <div className="ps-err gp-err" role="alert">
        {error.message}
      </div>
    );
  if (prefs === null) return alert(null);
  const switchRow = (key: ShellSwitch, label: string, settingId: string): ReactNode => (
    <>
      <Row label={label} settingId={settingId}>
        <input
          type="checkbox"
          className="ps-sw"
          aria-label={label}
          checked={prefs[key]}
          onChange={(e) => save(key, { [key]: e.target.checked })}
        />
      </Row>
      {alert(key)}
    </>
  );
  const engine = prefs.voice_engine;
  const appIcon = t({ id: 'settings.general.appIcon', defaultMessage: 'App icon' });
  const shapeGroup = t({ id: 'settings.general.appIconShape', defaultMessage: 'App icon shape' });
  const colourGroup = t({
    id: 'settings.general.appIconColour',
    defaultMessage: 'App icon colour',
  });
  const menuBarIcon = t({ id: 'settings.general.menuBarIcon', defaultMessage: 'Menu bar icon' });
  const trayIcon = t({
    id: 'settings.general.trayIcon',
    defaultMessage: 'Show the icon in the menu bar',
  });
  const shapes = shapeNames();
  const colours = colourNames();
  const [shape, colour] = prefs.app_icon.split('-') as [IconShape, IconColour];
  // A shape that does not come in the chosen colour shows, and is saved, in travertine.
  const iconOf = (pick: IconShape): ShellPrefs['app_icon'] =>
    `${pick}-${SHAPE_COLOURS[pick].includes(colour) ? colour : 'travertine'}`;
  return (
    <>
      {switchRow(
        'keep_running_on_close',
        t({
          id: 'settings.general.keepRunning',
          defaultMessage: 'Keep running after the window closes',
        }),
        'general.keepRunning',
      )}
      <Row label={trayIcon} settingId="general.trayIcon">
        <span className="gp-tray">
          <input
            type="checkbox"
            className="ps-sw"
            aria-label={trayIcon}
            checked={prefs.show_tray_icon}
            onChange={(e) => save('show_tray_icon', { show_tray_icon: e.target.checked })}
          />
          {prefs.show_tray_icon && (
            <span role="radiogroup" aria-label={menuBarIcon} className="gp-icons">
              {(Object.keys(SHAPE_COLOURS) as IconShape[]).map((id) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={prefs.tray_icon === id}
                  aria-label={shapes[id]}
                  className="gp-icon gp-glyph"
                  onClick={() => save('tray_icon', { tray_icon: id })}
                >
                  <TrayGlyph shape={id} />
                </button>
              ))}
            </span>
          )}
        </span>
      </Row>
      {alert('show_tray_icon')}
      {alert('tray_icon')}
      <Row label={appIcon} settingId="general.appIcon">
        <div className="gp-icon-pick">
          <div role="radiogroup" aria-label={shapeGroup} className="gp-icons">
            {(Object.keys(SHAPE_COLOURS) as IconShape[]).map((id) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={shape === id}
                aria-label={shapes[id]}
                className="gp-icon"
                onClick={() => save('app_icon', { app_icon: iconOf(id) })}
              >
                <img src={iconImage(iconOf(id))} alt="" width={56} height={56} />
              </button>
            ))}
          </div>
          <div role="radiogroup" aria-label={colourGroup} className="gp-icons">
            {SHAPE_COLOURS[shape].map((id) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={colour === id}
                aria-label={colours[id]}
                className="gp-swatch"
                style={{ background: `var(--icon-${id})` }}
                onClick={() => save('app_icon', { app_icon: `${shape}-${id}` })}
              />
            ))}
          </div>
        </div>
      </Row>
      {alert('app_icon')}
      {switchRow(
        'voice_input',
        t({ id: 'settings.general.voiceInput', defaultMessage: 'Voice input' }),
        'general.voiceInput',
      )}
      <Row
        label={t({
          id: 'settings.general.voiceEngine',
          defaultMessage: 'Voice recognition engine',
        })}
        settingId="general.voiceEngine"
      >
        {engine === null ? (
          <span className="gp-engine">
            {t({
              id: 'settings.general.voiceEngineBuiltIn',
              defaultMessage: 'Built into the system',
            })}
          </span>
        ) : (
          <span className="gp-engine mono" title={engine}>
            {fileName(engine)}
          </span>
        )}
        <button type="button" className="btn" disabled={!prefs.voice_input} onClick={choose}>
          {t({ id: 'settings.general.voiceEngineChoose', defaultMessage: 'Choose…' })}
        </button>
        {engine !== null && (
          <button
            type="button"
            className="btn"
            disabled={!prefs.voice_input}
            onClick={() => save('voice_engine', { voice_engine: null })}
          >
            {t({
              id: 'settings.general.voiceEngineReset',
              defaultMessage: 'Use the built-in one',
            })}
          </button>
        )}
      </Row>
      {alert('voice_engine')}
    </>
  );
}
