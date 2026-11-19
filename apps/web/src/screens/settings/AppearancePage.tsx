import { useEffect, useState, type CSSProperties } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { ZOOM_FACTORS } from '@pantheon/protocol';
import { ThemeSwitch } from '../../components/ThemeSwitch';
import { toast } from '../../components/Toast';
import { useBoard } from '../../data/board';
import {
  ACCENTS,
  CODE_SIZE,
  DRAWER,
  drawerMax,
  INSPECTOR,
  READING_WIDTHS,
  saveLayout,
  setAccent,
  setAppearance,
  setLayout,
  setLook,
  SIDEBAR,
  TEXT_SIZE,
  useAccent,
  useAppearance,
  useLayout,
  useLook,
  useSystemAccent,
  useViewportWidth,
  type Accent,
  type CodeFamily,
  type Density,
  type InspectorOpening,
  type LineHeight,
  type Motion,
  type ReadingWidth,
  type SendKey,
  type UiFamily,
} from '../../data/layout';
import { failureText } from '../../data/needs-you';
import {
  applyTheme,
  defaultSwatches,
  deleteTheme,
  readUserTheme,
  setBackdropOn,
  useBackdropOn,
  useUserThemes,
  type Swatches,
} from '../../data/theme';
import { sessionTitle } from '../../data/transcript';
import { clearUserStyle, setUserStyleEnabled, useUserStyle } from '../../data/user-style';
import { t } from '../../i18n';
import { keyText } from '../../lib/shortcuts';
import { scrimFlag } from '../../lib/root-flag';
import { resolveTheme, useShell } from '../../store';
import { ipcFailure } from './editors';
import { Row, Section } from './ProjectSettingsScreen';

export function AppearancePage() {
  const theme = useShell((s) => s.theme);
  const setTheme = useShell((s) => s.setTheme);
  const appearance = useAppearance();
  const look = useLook();
  const layout = useLayout();
  const viewport = useViewportWidth();
  // Stays null without the desktop app, which alone can zoom the page.
  const [zoom, setZoom] = useState<number | null>(null);
  const askZoom = (factor?: number) =>
    void window.pantheon
      ?.zoomFactor(factor)
      .catch(ipcFailure)
      .then((result) => {
        if (result.ok) setZoom(result.value);
      });
  // The menu zooms too; a zoom resizes the page in CSS pixels.
  useEffect(() => {
    const refresh = () => askZoom();
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('resize', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('resize', refresh);
    };
  }, []);
  const densityTitle = t({ id: 'settings.appearance.density', defaultMessage: 'Density' });
  const standard = t({ id: 'settings.appearance.standard', defaultMessage: 'Standard' });
  const textSize = t({ id: 'settings.appearance.textSize', defaultMessage: 'Interface text size' });
  const uiFamily = t({ id: 'settings.appearance.uiFamily', defaultMessage: 'Interface font' });
  const lineHeight = t({ id: 'settings.appearance.lineHeight', defaultMessage: 'Line height' });
  const custom = t({ id: 'settings.appearance.fontCustom', defaultMessage: 'Custom' });
  const readingWidth = t({
    id: 'settings.appearance.readingWidth',
    defaultMessage: 'Reading width',
  });
  const zoomTitle = t({ id: 'settings.appearance.zoom', defaultMessage: 'Zoom' });
  const inspectorOpening = t({
    id: 'settings.appearance.inspectorOpening',
    defaultMessage: 'Open the inspector',
  });
  const keepLayout = (patch: Parameters<typeof setLayout>[0]) => {
    setLayout(patch);
    saveLayout();
  };
  const colorblind = t({
    id: 'settings.appearance.colorblind',
    defaultMessage: 'Colour-blind friendly colours',
  });
  const codeFont = t({ id: 'settings.appearance.codeFont', defaultMessage: 'Code text size' });
  const codeFamily = t({ id: 'settings.appearance.codeFamily', defaultMessage: 'Code font' });
  const reduceMotion = t({
    id: 'settings.appearance.reduceMotion',
    defaultMessage: 'Reduce motion',
  });
  const collapseAtStart = t({
    id: 'settings.appearance.collapseSidebarAtStart',
    defaultMessage: 'Collapse the sidebar at start',
  });
  const sendKeyTitle = t({ id: 'settings.appearance.sendKey', defaultMessage: 'Send key' });
  const sendWith = (keys: string) =>
    t(
      { id: 'settings.appearance.sendWith', defaultMessage: '{keys} sends' },
      { keys: keyText(keys) },
    );
  const sidebarWidth = t({
    id: 'settings.appearance.sidebarWidth',
    defaultMessage: 'Sidebar width',
  });
  const inspectorWidth = t({
    id: 'settings.appearance.inspectorWidth',
    defaultMessage: 'Inspector width',
  });
  const drawerWidth = t({ id: 'settings.appearance.drawerWidth', defaultMessage: 'Drawer width' });
  const { list, active } = useUserThemes();
  const activeBuiltIn = list?.themes.some((saved) => saved.built_in && saved.id === active?.id);
  const backdropOn = useBackdropOn();
  const backdrop = t({ id: 'settings.appearance.backdrop', defaultMessage: 'Animated background' });
  const accent = useAccent();
  const systemAccent = useSystemAccent();
  const accentTitle = t({ id: 'settings.appearance.accent', defaultMessage: 'Accent colour' });
  const accentNames: Record<Accent, string> = {
    default: t({ id: 'settings.appearance.accentDefault', defaultMessage: 'Default' }),
    system: t({ id: 'settings.appearance.accentSystem', defaultMessage: 'Match system' }),
    bronze: t({ id: 'settings.appearance.accentBronze', defaultMessage: 'Bronze' }),
    lapis: t({ id: 'settings.appearance.accentLapis', defaultMessage: 'Lapis' }),
    terracotta: t({ id: 'settings.appearance.accentTerracotta', defaultMessage: 'Terracotta' }),
    verdigris: t({ id: 'settings.appearance.accentVerdigris', defaultMessage: 'Verdigris' }),
    porphyry: t({ id: 'settings.appearance.accentPorphyry', defaultMessage: 'Porphyry' }),
  };
  return (
    <>
      <ThemeCards />
      <Section>
        <div className="ps-rows">
          <Row
            label={t({ id: 'settings.appearance.scheme', defaultMessage: 'Light and dark' })}
            settingId="appearance.theme"
          >
            <ThemeSwitch value={theme} onValueChange={setTheme} withText />
          </Row>
          <Row label={accentTitle} settingId="appearance.accent">
            <RadioGroup<Accent>
              className="ps-acc"
              aria-label={accentTitle}
              value={accent}
              onValueChange={(next) => setAccent(next)}
            >
              {ACCENTS.filter((choice) => choice !== 'system' || systemAccent !== null).map(
                (choice) => (
                  <Radio.Root
                    key={choice}
                    value={choice}
                    className="ps-acc-sw"
                    aria-label={accentNames[choice]}
                    style={{
                      background:
                        choice === 'default'
                          ? 'var(--tx)'
                          : choice === 'system'
                            ? systemAccent!
                            : `var(--accent-${choice})`,
                    }}
                  />
                ),
              )}
            </RadioGroup>
          </Row>
          {active?.backdrop !== undefined && (
            <Row label={backdrop} settingId="appearance.backdrop">
              <input
                type="checkbox"
                className="ps-sw"
                aria-label={backdrop}
                checked={backdropOn}
                onChange={(e) => setBackdropOn(e.target.checked)}
              />
            </Row>
          )}
          <Row label={colorblind} settingId="appearance.colorblind">
            <input
              type="checkbox"
              className="ps-sw"
              aria-label={colorblind}
              checked={look.colorblind}
              onChange={(e) => setLook({ colorblind: e.target.checked })}
            />
          </Row>
          {active && !activeBuiltIn && (
            <SavedThemeRow key={active.id} id={active.id} label={active.label} />
          )}
          <UserStyleRow />
        </div>
      </Section>
      <Section title={t({ id: 'settings.appearance.text', defaultMessage: 'Text' })}>
        <div className="ps-rows">
          <Row label={textSize} settingId="appearance.chatFont">
            <SizeInput
              label={textSize}
              value={appearance.chat_font}
              min={TEXT_SIZE.min}
              max={TEXT_SIZE.max}
              onSave={(chat_font) => setAppearance({ chat_font })}
            />
          </Row>
          <Row label={uiFamily} settingId="appearance.uiFamily">
            <RadioGroup<UiFamily>
              className="seg"
              aria-label={uiFamily}
              value={look.ui_family}
              onValueChange={(ui_family) => setLook({ ui_family })}
            >
              <Radio.Root value="default">
                {t({ id: 'settings.appearance.uiFamilyDefault', defaultMessage: 'Default' })}
              </Radio.Root>
              <Radio.Root value="mono">
                {t({ id: 'settings.appearance.uiFamilyMono', defaultMessage: 'Monospace' })}
              </Radio.Root>
              <Radio.Root value="custom">{custom}</Radio.Root>
            </RadioGroup>
            {look.ui_family === 'custom' && (
              <FontName
                label={t({
                  id: 'settings.appearance.uiFontName',
                  defaultMessage: 'Interface font name',
                })}
                value={look.ui_font_name}
                onChange={(ui_font_name) => setLook({ ui_font_name })}
              />
            )}
          </Row>
          <Row label={lineHeight} settingId="appearance.lineHeight">
            <RadioGroup<LineHeight>
              className="seg"
              aria-label={lineHeight}
              value={appearance.line_height}
              onValueChange={(line_height) => setAppearance({ line_height })}
            >
              <Radio.Root value="compact">
                {t({ id: 'settings.appearance.compact', defaultMessage: 'Compact' })}
              </Radio.Root>
              <Radio.Root value="standard">{standard}</Radio.Root>
              <Radio.Root value="relaxed">
                {t({ id: 'settings.appearance.relaxed', defaultMessage: 'Relaxed' })}
              </Radio.Root>
            </RadioGroup>
          </Row>
          <Row label={codeFamily} settingId="appearance.codeFamily">
            <RadioGroup<CodeFamily>
              className="seg"
              aria-label={codeFamily}
              value={look.code_family}
              onValueChange={(code_family) => setLook({ code_family })}
            >
              <Radio.Root value="bundled">
                {t({ id: 'settings.appearance.codeFamilyBundled', defaultMessage: 'Built-in' })}
              </Radio.Root>
              <Radio.Root value="system">
                {t({
                  id: 'settings.appearance.codeFamilySystem',
                  defaultMessage: 'System monospace',
                })}
              </Radio.Root>
              <Radio.Root value="custom">{custom}</Radio.Root>
            </RadioGroup>
            {look.code_family === 'custom' && (
              <FontName
                label={t({
                  id: 'settings.appearance.codeFontName',
                  defaultMessage: 'Code font name',
                })}
                value={look.code_font_name}
                onChange={(code_font_name) => setLook({ code_font_name })}
              />
            )}
          </Row>
          <Row label={codeFont} settingId="appearance.codeFont">
            <SizeInput
              label={codeFont}
              value={look.code_font}
              min={CODE_SIZE.min}
              max={CODE_SIZE.max}
              onSave={(code_font) => setLook({ code_font })}
            />
          </Row>
        </div>
      </Section>
      <Section title={t({ id: 'settings.appearance.layout', defaultMessage: 'Layout' })}>
        <div className="ps-rows">
          <Row
            label={densityTitle}
            hint={t({
              id: 'settings.appearance.densityHint',
              defaultMessage: 'Compact uses less spacing',
            })}
            settingId="appearance.density"
          >
            <RadioGroup<Density>
              className="seg"
              aria-label={densityTitle}
              value={appearance.density}
              onValueChange={(density) => setAppearance({ density })}
            >
              <Radio.Root value="standard">{standard}</Radio.Root>
              <Radio.Root value="compact">
                {t({ id: 'settings.appearance.compact', defaultMessage: 'Compact' })}
              </Radio.Root>
            </RadioGroup>
          </Row>
          <Row label={readingWidth} settingId="appearance.readingWidth">
            <RadioGroup<ReadingWidth>
              className="seg"
              aria-label={readingWidth}
              value={appearance.reading_width}
              onValueChange={(reading_width) => setAppearance({ reading_width })}
            >
              {READING_WIDTHS.map((width) => (
                <Radio.Root key={width} value={width}>
                  {width === 'none'
                    ? t({ id: 'settings.common.noLimit', defaultMessage: 'No limit' })
                    : String(width)}
                </Radio.Root>
              ))}
            </RadioGroup>
          </Row>
          {zoom !== null && (
            <Row label={zoomTitle} settingId="appearance.zoom">
              <RadioGroup<number>
                className="seg"
                aria-label={zoomTitle}
                value={zoom}
                onValueChange={(factor) => askZoom(factor)}
              >
                {ZOOM_FACTORS.map((factor) => (
                  <Radio.Root key={factor} value={factor}>
                    {`${Math.round(factor * 100)}%`}
                  </Radio.Root>
                ))}
              </RadioGroup>
            </Row>
          )}
          <Row label={inspectorOpening} settingId="appearance.inspectorOpening">
            <RadioGroup<InspectorOpening>
              className="seg"
              aria-label={inspectorOpening}
              value={appearance.inspector}
              onValueChange={(inspector) => setAppearance({ inspector })}
            >
              <Radio.Root value="auto">
                {t({ id: 'settings.appearance.inspectorAuto', defaultMessage: 'By window width' })}
              </Radio.Root>
              <Radio.Root value="always">
                {t({ id: 'settings.appearance.inspectorAlways', defaultMessage: 'Always' })}
              </Radio.Root>
              <Radio.Root value="never">
                {t({ id: 'settings.appearance.inspectorNever', defaultMessage: 'Never' })}
              </Radio.Root>
            </RadioGroup>
          </Row>
          <Row label={sendKeyTitle} settingId="appearance.sendKey">
            <RadioGroup<SendKey>
              className="seg"
              aria-label={sendKeyTitle}
              value={look.send_key}
              onValueChange={(send_key) => setLook({ send_key })}
            >
              <Radio.Root value="enter">{sendWith('Enter')}</Radio.Root>
              <Radio.Root value="meta-enter">{sendWith('Meta+Enter')}</Radio.Root>
            </RadioGroup>
          </Row>
          <Row label={reduceMotion} settingId="appearance.motion">
            <RadioGroup<Motion>
              className="seg"
              aria-label={reduceMotion}
              value={look.motion}
              onValueChange={(motion) => setLook({ motion })}
            >
              <Radio.Root value="system">
                {t({ id: 'settings.appearance.motionSystem', defaultMessage: 'Match system' })}
              </Radio.Root>
              <Radio.Root value="reduced">
                {t({ id: 'settings.appearance.motionOn', defaultMessage: 'On' })}
              </Radio.Root>
              <Radio.Root value="full">
                {t({ id: 'settings.appearance.motionOff', defaultMessage: 'Off' })}
              </Radio.Root>
            </RadioGroup>
          </Row>
          <Row label={sidebarWidth} settingId="appearance.sidebarWidth">
            <PxInput
              label={sidebarWidth}
              value={layout.sidebar.width}
              min={SIDEBAR.min}
              max={SIDEBAR.max}
              onSave={(width) => keepLayout({ sidebar: { ...layout.sidebar, width } })}
            />
          </Row>
          <Row label={collapseAtStart} settingId="appearance.collapseSidebarAtStart">
            <input
              type="checkbox"
              className="ps-sw"
              aria-label={collapseAtStart}
              checked={layout.collapse_sidebar_at_start}
              onChange={(e) => keepLayout({ collapse_sidebar_at_start: e.target.checked })}
            />
          </Row>
          <Row label={inspectorWidth} settingId="appearance.inspectorWidth">
            <PxInput
              label={inspectorWidth}
              value={layout.inspector}
              min={INSPECTOR.min}
              max={INSPECTOR.max}
              onSave={(inspector) => keepLayout({ inspector })}
            />
          </Row>
          <Row
            label={drawerWidth}
            hint={t({
              id: 'settings.appearance.drawerWidthHint',
              defaultMessage: 'The task drawer on the board',
            })}
            settingId="appearance.drawerWidth"
          >
            <PxInput
              label={drawerWidth}
              value={layout.drawer}
              min={DRAWER.min}
              max={drawerMax(viewport)}
              onSave={(drawer) => keepLayout({ drawer })}
            />
          </Row>
        </div>
      </Section>
    </>
  );
}

/** The default theme, the built-in ones, then each saved theme, newest first; pressing one applies it. */
function ThemeCards() {
  const list = useUserThemes().list;
  const board = useBoard((s) => s.board);
  const scheme = useShell((s) => s.theme);
  const dark =
    resolveTheme(scheme, window.matchMedia('(prefers-color-scheme: dark)').matches) === 'dark';
  const [fallback, setFallback] = useState<Swatches | null>(null);
  useEffect(() => setFallback(defaultSwatches(dark)), [dark]);
  const title = t({ id: 'settings.appearance.theme', defaultMessage: 'Theme' });
  const activeId = list?.active_theme_id ?? null;
  const builtInNames: Record<string, string> = {
    'builtin-travertine': t({
      id: 'settings.appearance.builtinTheme.travertine',
      defaultMessage: 'Travertine',
    }),
    'builtin-dusk': t({ id: 'settings.appearance.builtinTheme.dusk', defaultMessage: 'Dusk' }),
    'builtin-lapis': t({ id: 'settings.appearance.builtinTheme.lapis', defaultMessage: 'Lapis' }),
    'builtin-terracotta': t({
      id: 'settings.appearance.builtinTheme.terracotta',
      defaultMessage: 'Terracotta',
    }),
  };
  const from = (sessionId: string | undefined) => {
    const session = board?.sessions.find((s) => s.id === sessionId);
    return session && sessionTitle(session, board!);
  };
  const pick = async (id: string | null) => {
    const result = await applyTheme(id);
    if (!result.ok) toast({ title: failureText(result.error), kind: 'failure' });
  };
  return (
    <section className="ps-sec" aria-label={title} aria-busy={list === null || undefined}>
      <div className="ps-sec-hd">
        <h3>{title}</h3>
      </div>
      <div className="ps-thm-grid">
        <ThemeCard
          label={t({ id: 'settings.appearance.defaultTheme', defaultMessage: 'Default' })}
          swatches={fallback}
          selected={activeId === null}
          onPick={() => void pick(null)}
        />
        {list?.themes.map((saved) => (
          <ThemeCard
            key={saved.id}
            label={(saved.built_in && builtInNames[saved.id]) || saved.label}
            from={from(saved.session_id)}
            swatches={saved.swatches}
            selected={saved.id === activeId}
            onPick={() => void pick(saved.id)}
          />
        ))}
      </div>
    </section>
  );
}

/** A small window in the theme's canvas, surface and ink over its name; null colours draw the app's own. */
function ThemeCard(props: {
  label: string;
  from?: string;
  swatches: Swatches | null;
  selected: boolean;
  onPick: () => void;
}) {
  const colours = props.swatches && {
    '--th-0': props.swatches.surface0,
    '--th-1': props.swatches.surface1,
    '--th-a': props.swatches.accent,
  };
  return (
    <button
      type="button"
      className="ps-thc"
      aria-pressed={props.selected}
      style={(colours ?? undefined) as CSSProperties | undefined}
      onClick={props.onPick}
    >
      <span className="ps-thc-mini" aria-hidden="true">
        <span className="ps-thc-sd">
          <i />
          <i />
          <i />
        </span>
        <span className="ps-thc-ct">
          <i />
          <i />
          <b />
        </span>
      </span>
      <span className="ps-thc-nm">
        <b>{props.label}</b>
        {props.from && <span className="mu">{props.from}</span>}
        <span className="ps-thc-sw" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </span>
    </button>
  );
}

/** The applied saved theme: its name, a JSON copy of it and, once confirmed, deleting it. */
function SavedThemeRow({ id, label }: { id: string; label: string }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const exportTheme = async () => {
    const read = await readUserTheme(id);
    if (!read.ok) {
      toast({ title: failureText(read.error), kind: 'failure' });
      return;
    }
    // The bridge has no save dialog; a download link gets the browser's, or Electron's.
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(read.value, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `${id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url));
  };
  const remove = async () => {
    setBusy(true);
    const result = await deleteTheme(id);
    setBusy(false);
    if (result.ok) setConfirming(false);
    else toast({ title: failureText(result.error), kind: 'failure' });
  };
  return (
    <Row label={label} settingId="appearance.savedTheme">
      <button type="button" className="btn sm" onClick={() => void exportTheme()}>
        {t({ id: 'settings.appearance.exportTheme', defaultMessage: 'Export' })}
      </button>
      <button type="button" className="btn sm dng" onClick={() => setConfirming(true)}>
        {t({ id: 'settings.appearance.deleteTheme', defaultMessage: 'Delete' })}
      </button>
      <AlertDialog.Root
        open={confirming}
        onOpenChange={(next) => {
          if (!next && !busy) setConfirming(false);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="pj-scrim" ref={scrimFlag} />
          <AlertDialog.Popup className="pj-dlg pj-rm pop">
            <div className="pj-dh">
              <AlertDialog.Title className="pj-dt">
                {t(
                  {
                    id: 'settings.appearance.deleteThemeTitle',
                    defaultMessage: 'Delete theme “{label}”?',
                  },
                  { label },
                )}
              </AlertDialog.Title>
            </div>
            <AlertDialog.Description className="pj-rm-body">
              {t({
                id: 'settings.appearance.deleteThemeBody',
                defaultMessage:
                  'The theme is deleted for good and the default theme applies again. This cannot be undone.',
              })}
            </AlertDialog.Description>
            <div className="pj-df">
              <span style={{ flex: 1 }} />
              <AlertDialog.Close className="btn" disabled={busy}>
                {t({ id: 'sessions.parts.cancel', defaultMessage: 'Cancel' })}
              </AlertDialog.Close>
              <button
                type="button"
                className="btn dng"
                disabled={busy}
                aria-disabled={busy || undefined}
                onClick={() => void remove()}
              >
                {t({ id: 'settings.appearance.deleteThemeConfirm', defaultMessage: 'Delete' })}
              </button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </Row>
  );
}

/** The user stylesheet a session wrote: on or off, its rule count and, once confirmed, clearing it. */
function UserStyleRow() {
  const style = useUserStyle();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!style?.css) return null;
  const label = t({ id: 'settings.appearance.userStyle', defaultMessage: 'User styles' });
  const enable = async (enabled: boolean) => {
    const result = await setUserStyleEnabled(enabled);
    if (!result.ok) toast({ title: failureText(result.error), kind: 'failure' });
  };
  const clear = async () => {
    setBusy(true);
    const result = await clearUserStyle();
    setBusy(false);
    if (result.ok) setConfirming(false);
    else toast({ title: failureText(result.error), kind: 'failure' });
  };
  return (
    <Row label={label}>
      <span className="mu">
        {t(
          {
            id: 'settings.appearance.userStyleRules',
            defaultMessage: '{count, plural, one {# rule} other {# rules}}',
          },
          { count: style.rules },
        )}
      </span>
      <input
        type="checkbox"
        className="ps-sw"
        aria-label={label}
        checked={style.enabled}
        onChange={(e) => void enable(e.target.checked)}
      />
      <button type="button" className="btn sm dng" onClick={() => setConfirming(true)}>
        {t({ id: 'settings.appearance.clearUserStyle', defaultMessage: 'Clear' })}
      </button>
      <AlertDialog.Root
        open={confirming}
        onOpenChange={(next) => {
          if (!next && !busy) setConfirming(false);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="pj-scrim" ref={scrimFlag} />
          <AlertDialog.Popup className="pj-dlg pj-rm pop">
            <div className="pj-dh">
              <AlertDialog.Title className="pj-dt">
                {t({
                  id: 'settings.appearance.clearUserStyleTitle',
                  defaultMessage: 'Clear the user styles?',
                })}
              </AlertDialog.Title>
            </div>
            <AlertDialog.Description className="pj-rm-body">
              {t({
                id: 'settings.appearance.clearUserStyleBody',
                defaultMessage: 'The stylesheet is deleted for good. This cannot be undone.',
              })}
            </AlertDialog.Description>
            <div className="pj-df">
              <span style={{ flex: 1 }} />
              <AlertDialog.Close className="btn" disabled={busy}>
                {t({ id: 'sessions.parts.cancel', defaultMessage: 'Cancel' })}
              </AlertDialog.Close>
              <button
                type="button"
                className="btn dng"
                disabled={busy}
                aria-disabled={busy || undefined}
                onClick={() => void clear()}
              >
                {t({ id: 'settings.appearance.clearUserStyleConfirm', defaultMessage: 'Clear' })}
              </button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </Row>
  );
}

/** A whole number of px typed in; a value outside min..max stays unsaved and shows the range. */
function PxInput(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  onSave: (px: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const commit = () => {
    if (draft === null) return;
    const width = Number(draft.trim());
    if (/^\d+$/.test(draft.trim()) && width >= props.min && width <= props.max) {
      props.onSave(width);
      setDraft(null);
      setInvalid(false);
    } else setInvalid(true);
  };
  return (
    <>
      <input
        className="ps-px"
        inputMode="numeric"
        spellCheck={false}
        aria-label={props.label}
        aria-invalid={invalid || undefined}
        value={draft ?? String(props.value)}
        onChange={(e) => {
          setDraft(e.target.value);
          setInvalid(false);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
      <span className="mu">px</span>
      {invalid && (
        <span className="ps-err" role="alert">
          {t(
            { id: 'settings.appearance.widthRange', defaultMessage: 'Enter {min} to {max} px' },
            { min: props.min, max: props.max },
          )}
        </span>
      )}
    </>
  );
}

/** A text size from a slider or typed in px. */
function SizeInput(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  onSave: (px: number) => void;
}) {
  return (
    <>
      <input
        type="range"
        className="ps-range"
        min={props.min}
        max={props.max}
        step={1}
        aria-label={props.label}
        value={props.value}
        onChange={(e) => props.onSave(Number(e.target.value))}
      />
      <PxInput
        {...props}
        label={t(
          { id: 'settings.appearance.sizeInPx', defaultMessage: '{name} in px' },
          { name: props.label },
        )}
      />
    </>
  );
}

/** The name of an installed font, applied as it is typed. */
function FontName(props: { label: string; value: string; onChange: (name: string) => void }) {
  return (
    <input
      className="ps-font"
      spellCheck={false}
      aria-label={props.label}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
    />
  );
}
