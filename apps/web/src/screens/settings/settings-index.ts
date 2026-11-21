import { KNOWN_RUNTIMES, runtimeName } from '../../components/RuntimeGlyph';
import { DECISION_NAME, DELIVERY_NAME } from '../../data/notifications';
import { LOCALE_NAMES, t, type Message } from '../../i18n';
import { revealText } from '../../lib/platform-text';
import type { SettingsPage } from './view';

/** One setting the search can land on; the texts match in the loaded language and in English. */
export interface SettingRecord {
  id: string;
  page: SettingsPage;
  section?: Message;
  label: Message;
  keywords?: Message;
  options?: () => string[];
}

// Named so the message extractor reads these descriptors as messages.
const defineMessage = (message: Message): Message => message;

/** Each page's name, as the navigation shows it. */
export const PAGE_NAME: Record<SettingsPage, Message> = {
  general: defineMessage({ id: 'settings.pages.general', defaultMessage: 'General' }),
  appearance: defineMessage({ id: 'settings.pages.appearance', defaultMessage: 'Appearance' }),
  sessionDisplay: defineMessage({
    id: 'settings.pages.sessionDisplay',
    defaultMessage: 'Session display',
  }),
  diff: defineMessage({ id: 'settings.pages.diff', defaultMessage: 'Diff view' }),
  harness: defineMessage({ id: 'settings.pages.runtimes', defaultMessage: 'Runtimes' }),
  devices: defineMessage({ id: 'settings.devices.title', defaultMessage: 'Devices' }),
  editor: defineMessage({ id: 'settings.pages.openWith', defaultMessage: 'Open with' }),
  connections: defineMessage({ id: 'settings.pages.connections', defaultMessage: 'Connections' }),
  notifications: defineMessage({
    id: 'settings.pages.notifications',
    defaultMessage: 'Notifications',
  }),
  shortcuts: defineMessage({ id: 'settings.pages.shortcuts', defaultMessage: 'Shortcuts' }),
  usage: defineMessage({ id: 'settings.pages.usage', defaultMessage: 'Usage' }),
  data: defineMessage({ id: 'settings.pages.data', defaultMessage: 'Data' }),
  about: defineMessage({ id: 'settings.pages.about', defaultMessage: 'About' }),
  gates: defineMessage({ id: 'settings.pages.gates', defaultMessage: 'Gates' }),
  worktrees: defineMessage({
    id: 'settings.pages.worktrees',
    defaultMessage: 'Worktrees and merging',
  }),
  permissions: defineMessage({ id: 'settings.pages.permissions', defaultMessage: 'Permissions' }),
  external: defineMessage({
    id: 'settings.pages.external',
    defaultMessage: 'External requests',
  }),
  defaults: defineMessage({ id: 'settings.pages.defaults', defaultMessage: 'Default model' }),
  project: defineMessage({ id: 'settings.pages.project', defaultMessage: 'Project' }),
  extensions: defineMessage({ id: 'settings.pages.extensions', defaultMessage: 'Extensions' }),
  projects: defineMessage({ id: 'settings.pages.projects', defaultMessage: 'Projects' }),
};

const page = (key: SettingsPage): SettingRecord => ({
  id: `${key}.page`,
  page: key,
  label: PAGE_NAME[key],
});

const themeAndColour = defineMessage({
  id: 'settings.appearance.themeAndColour',
  defaultMessage: 'Theme and colour',
});
const text = defineMessage({ id: 'settings.appearance.text', defaultMessage: 'Text' });
const layout = defineMessage({ id: 'settings.appearance.layout', defaultMessage: 'Layout' });
const standard = () => t({ id: 'settings.appearance.standard', defaultMessage: 'Standard' });
const notificationDeliveries = () => Object.values(DELIVERY_NAME).map((name) => t(name));
const notificationEvents = defineMessage({
  id: 'settings.notifications.events',
  defaultMessage: 'Decisions',
});
const notificationDelivery = defineMessage({
  id: 'settings.notifications.delivery',
  defaultMessage: 'Delivery rules',
});
const notificationKeywords = defineMessage({
  id: 'settings.search.keywords.notificationCategory',
  defaultMessage: 'sound, alert, banner, mute, silent',
});
const sessionDisplayOff = () => t({ id: 'settings.sessionDisplay.off', defaultMessage: 'Off' });
const runtimes = () => KNOWN_RUNTIMES.flatMap((r) => [r, runtimeName(r)]);
const diffOptions = defineMessage({
  id: 'components.diff.options',
  defaultMessage: 'Diff options',
});
const languageAndSleep = defineMessage({
  id: 'settings.general.languageAndSleep',
  defaultMessage: 'Language and sleep',
});
const baseline = defineMessage({ id: 'settings.general.baseline', defaultMessage: 'Baseline' });
const environment = defineMessage({
  id: 'settings.environment.title',
  defaultMessage: 'Environment',
});
const sessionDefaults = defineMessage({
  id: 'settings.defaults.roles',
  defaultMessage: 'Model for each role',
});
const gate = defineMessage({ id: 'settings.gate.title', defaultMessage: 'Merge gate' });
const worktreeSetup = defineMessage({
  id: 'settings.worktreeSetup.title',
  defaultMessage: 'Worktrees',
});
const personal = defineMessage({
  id: 'settings.data.personal',
  defaultMessage: 'Personal settings',
});
const budgetAndQuota = defineMessage({
  id: 'settings.usage.budgetAndQuota',
  defaultMessage: 'Budget and quota',
});

/** Every setting, in navigation order and in each page's order. */
export const SETTINGS_INDEX: SettingRecord[] = [
  page('general'),
  {
    id: 'general.language',
    page: 'general',
    section: languageAndSleep,
    label: defineMessage({ id: 'settings.appearance.language', defaultMessage: 'Language' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.language',
      defaultMessage: 'locale, chinese, english, translation',
    }),
    options: () => [
      t({ id: 'settings.appearance.languageSystem', defaultMessage: 'Match system' }),
      ...Object.values(LOCALE_NAMES),
    ],
  },
  {
    id: 'general.keepAwake',
    page: 'general',
    section: languageAndSleep,
    label: defineMessage({
      id: 'settings.keepAwake.toggle',
      defaultMessage: 'Prevent sleep while a session runs',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.keepAwake',
      defaultMessage: 'keep awake, caffeinate, power',
    }),
  },
  {
    id: 'general.openAtLogin',
    page: 'general',
    section: languageAndSleep,
    label: defineMessage({ id: 'settings.general.openAtLogin', defaultMessage: 'Open at login' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.openAtLogin',
      defaultMessage: 'startup, launch at login, login item, autostart',
    }),
  },
  {
    id: 'general.keepRunning',
    page: 'general',
    section: languageAndSleep,
    label: defineMessage({
      id: 'settings.general.keepRunning',
      defaultMessage: 'Keep running after the window closes',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.keepRunning',
      defaultMessage: 'quit, close, background, hide window',
    }),
  },
  {
    id: 'general.trayIcon',
    page: 'general',
    section: languageAndSleep,
    label: defineMessage({
      id: 'settings.general.trayIcon',
      defaultMessage: 'Show the icon in the menu bar',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.trayIcon',
      defaultMessage: 'tray, system tray, status bar, menu bar icon',
    }),
  },
  {
    id: 'general.appIcon',
    page: 'general',
    section: languageAndSleep,
    label: defineMessage({ id: 'settings.general.appIcon', defaultMessage: 'App icon' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.appIcon',
      defaultMessage: 'icon, taskbar, black',
    }),
  },
  {
    id: 'general.voiceInput',
    page: 'general',
    section: languageAndSleep,
    label: defineMessage({ id: 'settings.general.voiceInput', defaultMessage: 'Voice input' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.voiceInput',
      defaultMessage: 'dictation, speech, microphone',
    }),
  },
  {
    id: 'general.voiceEngine',
    page: 'general',
    section: languageAndSleep,
    label: defineMessage({
      id: 'settings.general.voiceEngine',
      defaultMessage: 'Voice recognition engine',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.voiceEngine',
      defaultMessage: 'speech recognition, transcription, dictation, executable',
    }),
  },
  {
    id: 'general.autoArchiveMerged',
    page: 'general',
    section: languageAndSleep,
    label: defineMessage({
      id: 'settings.general.autoArchiveMerged',
      defaultMessage: 'Archive sessions after they merge',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.autoArchiveMerged',
      defaultMessage: 'archive, merged, clean up, auto archive',
    }),
  },
  {
    id: 'general.sessionRecap',
    page: 'general',
    section: languageAndSleep,
    label: defineMessage({
      id: 'settings.general.sessionRecap',
      defaultMessage: 'Session progress recap',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.sessionRecap',
      defaultMessage: 'recap, summary, where it stands, headline',
    }),
  },
  {
    id: 'general.baselineRounds',
    page: 'general',
    section: baseline,
    label: defineMessage({
      id: 'settings.general.baselineRounds',
      defaultMessage: 'Follow-up rounds',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.baselineRounds',
      defaultMessage: 'baseline, questions, question rounds',
    }),
  },
  {
    id: 'general.baselineVisuals',
    page: 'general',
    section: baseline,
    label: defineMessage({
      id: 'settings.general.baselineVisuals',
      defaultMessage: 'Draw explanation charts',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.baselineVisuals',
      defaultMessage: 'baseline, charts, visuals, pin',
    }),
  },

  page('appearance'),
  {
    id: 'appearance.theme',
    page: 'appearance',
    section: themeAndColour,
    label: defineMessage({ id: 'settings.appearance.scheme', defaultMessage: 'Light and dark' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.theme',
      defaultMessage: 'dark, light, night, colour scheme, color scheme',
    }),
    options: () => [
      t({ id: 'components.themeSwitch.light', defaultMessage: 'Light' }),
      t({ id: 'components.themeSwitch.dark', defaultMessage: 'Dark' }),
      t({ id: 'components.themeSwitch.system', defaultMessage: 'Match system' }),
    ],
  },
  {
    id: 'appearance.accent',
    page: 'appearance',
    section: themeAndColour,
    label: defineMessage({ id: 'settings.appearance.accent', defaultMessage: 'Accent colour' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.accent',
      defaultMessage: 'accent, highlight, button colour, button color',
    }),
  },
  {
    id: 'appearance.colorblind',
    page: 'appearance',
    section: themeAndColour,
    label: defineMessage({
      id: 'settings.appearance.colorblind',
      defaultMessage: 'Colour-blind friendly colours',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.colorblind',
      defaultMessage: 'color blind, accessibility, contrast',
    }),
  },
  {
    id: 'appearance.chatFont',
    page: 'appearance',
    section: text,
    label: defineMessage({
      id: 'settings.appearance.textSize',
      defaultMessage: 'Interface text size',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.chatFont',
      defaultMessage: 'font, font size, text size, bigger, smaller',
    }),
  },
  {
    id: 'appearance.uiFamily',
    page: 'appearance',
    section: text,
    label: defineMessage({ id: 'settings.appearance.uiFamily', defaultMessage: 'Interface font' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.uiFamily',
      defaultMessage: 'font, typeface, font family, monospace',
    }),
    options: () => [
      t({ id: 'settings.appearance.uiFamilyDefault', defaultMessage: 'Default' }),
      t({ id: 'settings.appearance.uiFamilyMono', defaultMessage: 'Monospace' }),
      t({ id: 'settings.appearance.fontCustom', defaultMessage: 'Custom' }),
    ],
  },
  {
    id: 'appearance.lineHeight',
    page: 'appearance',
    section: text,
    label: defineMessage({ id: 'settings.appearance.lineHeight', defaultMessage: 'Line height' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.lineHeight',
      defaultMessage: 'line spacing, leading',
    }),
    options: () => [
      t({ id: 'settings.appearance.compact', defaultMessage: 'Compact' }),
      standard(),
      t({ id: 'settings.appearance.relaxed', defaultMessage: 'Relaxed' }),
    ],
  },
  {
    id: 'appearance.codeFamily',
    page: 'appearance',
    section: text,
    label: defineMessage({ id: 'settings.appearance.codeFamily', defaultMessage: 'Code font' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.codeFamily',
      defaultMessage: 'font, typeface, monospace, font family',
    }),
    options: () => [
      t({ id: 'settings.appearance.codeFamilyBundled', defaultMessage: 'Built-in' }),
      t({ id: 'settings.appearance.codeFamilySystem', defaultMessage: 'System monospace' }),
      t({ id: 'settings.appearance.fontCustom', defaultMessage: 'Custom' }),
    ],
  },
  {
    id: 'appearance.codeFont',
    page: 'appearance',
    section: text,
    label: defineMessage({ id: 'settings.appearance.codeFont', defaultMessage: 'Code text size' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.codeFont',
      defaultMessage: 'font, font size, text size, monospace',
    }),
  },
  {
    id: 'appearance.density',
    page: 'appearance',
    section: layout,
    label: defineMessage({ id: 'settings.appearance.density', defaultMessage: 'Density' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.density',
      defaultMessage: 'spacing, padding, compact',
    }),
    options: () => [
      standard(),
      t({ id: 'settings.appearance.compact', defaultMessage: 'Compact' }),
    ],
  },
  {
    id: 'appearance.readingWidth',
    page: 'appearance',
    section: layout,
    label: defineMessage({
      id: 'settings.appearance.readingWidth',
      defaultMessage: 'Reading width',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.readingWidth',
      defaultMessage: 'line length, column width',
    }),
    options: () => [t({ id: 'settings.common.noLimit', defaultMessage: 'No limit' })],
  },
  {
    id: 'appearance.zoom',
    page: 'appearance',
    section: layout,
    label: defineMessage({ id: 'settings.appearance.zoom', defaultMessage: 'Zoom' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.zoom',
      defaultMessage: 'scale, magnify, interface size, bigger, smaller',
    }),
  },
  {
    id: 'appearance.inspectorOpening',
    page: 'appearance',
    section: layout,
    label: defineMessage({
      id: 'settings.appearance.inspectorOpening',
      defaultMessage: 'Open the inspector',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.inspectorOpening',
      defaultMessage: 'side panel, details panel',
    }),
    options: () => [
      t({ id: 'settings.appearance.inspectorAuto', defaultMessage: 'By window width' }),
      t({ id: 'settings.appearance.inspectorAlways', defaultMessage: 'Always' }),
      t({ id: 'settings.appearance.inspectorNever', defaultMessage: 'Never' }),
    ],
  },
  {
    id: 'appearance.sendKey',
    page: 'appearance',
    section: layout,
    label: defineMessage({ id: 'settings.appearance.sendKey', defaultMessage: 'Send key' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.sendKey',
      defaultMessage: 'enter, return, submit, newline, cmd enter',
    }),
  },
  {
    id: 'appearance.motion',
    page: 'appearance',
    section: layout,
    label: defineMessage({
      id: 'settings.appearance.reduceMotion',
      defaultMessage: 'Reduce motion',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.motion',
      defaultMessage: 'animation, transitions, reduce motion',
    }),
    options: () => [
      t({ id: 'settings.appearance.motionSystem', defaultMessage: 'Match system' }),
      t({ id: 'settings.appearance.motionOn', defaultMessage: 'On' }),
      t({ id: 'settings.appearance.motionOff', defaultMessage: 'Off' }),
    ],
  },
  {
    id: 'appearance.sidebarWidth',
    page: 'appearance',
    section: layout,
    label: defineMessage({
      id: 'settings.appearance.sidebarWidth',
      defaultMessage: 'Sidebar width',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.sidebarWidth',
      defaultMessage: 'resize',
    }),
  },
  {
    id: 'appearance.collapseSidebarAtStart',
    page: 'appearance',
    section: layout,
    label: defineMessage({
      id: 'settings.appearance.collapseSidebarAtStart',
      defaultMessage: 'Collapse the sidebar at start',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.collapseSidebarAtStart',
      defaultMessage: 'fold, hide, sidebar, launch, startup',
    }),
  },
  {
    id: 'appearance.inspectorWidth',
    page: 'appearance',
    section: layout,
    label: defineMessage({
      id: 'settings.appearance.inspectorWidth',
      defaultMessage: 'Inspector width',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.inspectorWidth',
      defaultMessage: 'panel width, resize',
    }),
  },
  {
    id: 'appearance.drawerWidth',
    page: 'appearance',
    section: layout,
    label: defineMessage({
      id: 'settings.appearance.drawerWidth',
      defaultMessage: 'Drawer width',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.drawerWidth',
      defaultMessage: 'panel width, resize',
    }),
  },

  page('sessionDisplay'),
  {
    id: 'sessionDisplay.stateMotion',
    page: 'sessionDisplay',
    section: PAGE_NAME.sessionDisplay,
    label: defineMessage({
      id: 'settings.sessionDisplay.stateMotion',
      defaultMessage: 'Status animation',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.stateMotion',
      defaultMessage: 'motion, spin, pulse, status icon',
    }),
    options: () => [
      t({ id: 'settings.sessionDisplay.stateMotionAll', defaultMessage: 'All' }),
      t({
        id: 'settings.sessionDisplay.stateMotionWaiting',
        defaultMessage: 'Only waiting on you',
      }),
      sessionDisplayOff(),
    ],
  },
  {
    id: 'sessionDisplay.timeline',
    page: 'sessionDisplay',
    section: PAGE_NAME.sessionDisplay,
    label: defineMessage({ id: 'settings.sessionDisplay.timeline', defaultMessage: 'Timeline' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.timeline',
      defaultMessage: 'milestones, rail, marks',
    }),
    options: () => [
      t({ id: 'settings.sessionDisplay.timelineLabels', defaultMessage: 'With labels' }),
      t({ id: 'settings.sessionDisplay.timelineMarks', defaultMessage: 'Marks only' }),
      sessionDisplayOff(),
    ],
  },
  {
    id: 'sessionDisplay.overview',
    page: 'sessionDisplay',
    section: PAGE_NAME.sessionDisplay,
    label: defineMessage({
      id: 'settings.sessionDisplay.overview',
      defaultMessage: 'Overview card',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.overview',
      defaultMessage: 'floating card, summary',
    }),
    options: () => [
      t({ id: 'settings.sessionDisplay.overviewOpen', defaultMessage: 'Open' }),
      t({ id: 'settings.sessionDisplay.overviewFolded', defaultMessage: 'Folded to one line' }),
      sessionDisplayOff(),
    ],
  },
  {
    id: 'sessionDisplay.planBar',
    page: 'sessionDisplay',
    section: PAGE_NAME.sessionDisplay,
    label: defineMessage({
      id: 'settings.sessionDisplay.planBar',
      defaultMessage: 'Plan progress in the session bar',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.planBar',
      defaultMessage: 'todo, steps, strip',
    }),
  },
  {
    id: 'sessionDisplay.toolCalls',
    page: 'sessionDisplay',
    section: PAGE_NAME.sessionDisplay,
    label: defineMessage({ id: 'settings.sessionDisplay.toolCalls', defaultMessage: 'Tool calls' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.toolCalls',
      defaultMessage: 'transcript, collapse, expand, failed, verbose',
    }),
    options: () => [
      t({ id: 'settings.sessionDisplay.toolCallsFolded', defaultMessage: 'All folded' }),
      t({ id: 'settings.sessionDisplay.toolCallsOpenFailed', defaultMessage: 'Open when failed' }),
      t({ id: 'settings.sessionDisplay.toolCallsExpanded', defaultMessage: 'All open' }),
    ],
  },
  {
    id: 'sessionDisplay.runningSend',
    page: 'sessionDisplay',
    section: PAGE_NAME.sessionDisplay,
    label: defineMessage({
      id: 'settings.sessionDisplay.runningSend',
      defaultMessage: 'Messages sent while running',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.runningSend',
      defaultMessage: 'queue, steer, interrupt, send key',
    }),
    options: () => [
      t({ id: 'sessions.composer.queue', defaultMessage: 'Queue' }),
      t({ id: 'sessions.composer.steer', defaultMessage: 'Steer' }),
    ],
  },
  {
    id: 'sessionDisplay.reasoning',
    page: 'sessionDisplay',
    section: PAGE_NAME.sessionDisplay,
    label: defineMessage({
      id: 'settings.sessionDisplay.reasoning',
      defaultMessage: 'Show reasoning',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.reasoning',
      defaultMessage: 'thinking, thoughts',
    }),
  },
  {
    id: 'sessionDisplay.vendorMarks',
    page: 'sessionDisplay',
    section: PAGE_NAME.sessionDisplay,
    label: defineMessage({
      id: 'settings.sessionDisplay.vendorMarks',
      defaultMessage: 'Vendor icons',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.vendorMarks',
      defaultMessage: 'runtime logo, brand, monochrome, colour',
    }),
    options: () => [
      t({ id: 'settings.sessionDisplay.vendorMarksBrand', defaultMessage: 'Brand colours' }),
      t({ id: 'settings.sessionDisplay.vendorMarksMono', defaultMessage: 'One colour' }),
    ],
  },
  {
    id: 'sessionDisplay.contextUsage',
    page: 'sessionDisplay',
    section: PAGE_NAME.sessionDisplay,
    label: defineMessage({
      id: 'settings.sessionDisplay.contextUsage',
      defaultMessage: 'Context and usage',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.contextUsage',
      defaultMessage: 'tokens, context window, ring',
    }),
  },

  page('diff'),
  {
    id: 'diff.view',
    page: 'diff',
    section: diffOptions,
    label: defineMessage({ id: 'settings.diff.view', defaultMessage: 'Default view' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.diffView',
      defaultMessage: 'side by side, inline, split, unified',
    }),
    options: () => [
      t({ id: 'settings.diff.unified', defaultMessage: 'Unified' }),
      t({ id: 'settings.diff.split', defaultMessage: 'Split' }),
    ],
  },
  {
    id: 'diff.tabSize',
    page: 'diff',
    section: diffOptions,
    label: defineMessage({ id: 'settings.diff.tabSize', defaultMessage: 'Tab width' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.diffTabSize',
      defaultMessage: 'tab size, indentation, spaces',
    }),
  },
  {
    id: 'diff.wrap',
    page: 'diff',
    section: diffOptions,
    label: defineMessage({ id: 'components.diff.wrap', defaultMessage: 'Wrap long lines' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.diffWrap',
      defaultMessage: 'line wrap, soft wrap',
    }),
  },
  {
    id: 'diff.ignoreWhitespace',
    page: 'diff',
    section: diffOptions,
    label: defineMessage({
      id: 'components.diff.ignoreWhitespace',
      defaultMessage: 'Hide whitespace-only changes',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.diffWhitespace',
      defaultMessage: 'ignore whitespace, spaces, indentation',
    }),
  },
  {
    id: 'diff.collapse',
    page: 'diff',
    section: diffOptions,
    label: defineMessage({ id: 'components.diff.collapse', defaultMessage: 'Fold files on open' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.diffCollapse',
      defaultMessage: 'collapse, fold, unchanged lines',
    }),
  },

  page('harness'),
  {
    id: 'harness.enable',
    page: 'harness',
    section: PAGE_NAME.harness,
    label: defineMessage({
      id: 'settings.search.harnessEnable',
      defaultMessage: 'Enable a runtime',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.harnessEnable',
      defaultMessage: 'turn on, turn off, agent',
    }),
    options: runtimes,
  },
  {
    id: 'harness.binary',
    page: 'harness',
    section: PAGE_NAME.harness,
    label: defineMessage({ id: 'settings.search.harnessBinary', defaultMessage: 'Binary path' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.harnessBinary',
      defaultMessage: 'executable, cli, command, location',
    }),
    options: runtimes,
  },
  {
    id: 'harness.args',
    page: 'harness',
    section: PAGE_NAME.harness,
    label: defineMessage({ id: 'settings.search.harnessArgs', defaultMessage: 'Launch arguments' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.harnessArgs',
      defaultMessage: 'args, argv, flags, options, command line',
    }),
    options: runtimes,
  },
  {
    id: 'harness.account',
    page: 'harness',
    section: PAGE_NAME.harness,
    label: defineMessage({ id: 'settings.runtimes.account', defaultMessage: 'Account' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.harnessAccount',
      defaultMessage: 'sign in, login, email, connected, connection, plan',
    }),
    options: runtimes,
  },
  {
    id: 'harness.models',
    page: 'harness',
    section: PAGE_NAME.harness,
    label: defineMessage({ id: 'settings.harness.models', defaultMessage: 'Available models' }),
  },
  {
    id: 'harness.artifacts',
    page: 'harness',
    section: PAGE_NAME.harness,
    label: defineMessage({ id: 'settings.harness.artifacts', defaultMessage: 'Publish artifacts' }),
    options: runtimes,
  },
  {
    id: 'harness.unverifiedIsolation',
    page: 'harness',
    section: PAGE_NAME.harness,
    label: defineMessage({
      id: 'settings.runtimes.unverifiedIsolation',
      defaultMessage: 'Allow without verified isolation',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.unverifiedIsolation',
      defaultMessage: 'sandbox, isolation, worktree, unsafe, admission',
    }),
    options: runtimes,
  },
  {
    id: 'harness.kinds',
    page: 'harness',
    section: PAGE_NAME.harness,
    label: defineMessage({ id: 'settings.harness.kinds', defaultMessage: 'Session kinds' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.harnessKinds',
      defaultMessage: 'code, review, text, capabilities',
    }),
    options: runtimes,
  },
  {
    id: 'harness.backends',
    page: 'harness',
    label: defineMessage({ id: 'settings.harness.backends', defaultMessage: 'Backends' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.harnessBackends',
      defaultMessage: 'api, endpoint, base url, provider, key',
    }),
  },

  page('editor'),
  {
    id: 'editor.editor',
    page: 'editor',
    section: defineMessage({ id: 'settings.editor.files', defaultMessage: 'Files' }),
    label: defineMessage({ id: 'settings.editor.openWith', defaultMessage: 'Open with' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.editor',
      defaultMessage: 'ide, vs code, cursor, zed, open in',
    }),
    options: () => [t({ id: 'settings.editor.editor', defaultMessage: 'Editor' })],
  },
  {
    id: 'editor.terminal',
    page: 'editor',
    section: defineMessage({ id: 'settings.editor.terminal', defaultMessage: 'Terminal' }),
    label: defineMessage({
      id: 'settings.editor.externalTerminal',
      defaultMessage: 'External terminal',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.terminal',
      defaultMessage: 'shell, console, iterm, warp, ghostty',
    }),
  },
  {
    id: 'editor.browser',
    page: 'editor',
    section: defineMessage({ id: 'settings.editor.browser', defaultMessage: 'Browser' }),
    label: defineMessage({
      id: 'settings.editor.externalBrowser',
      defaultMessage: 'External browser',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.browser',
      defaultMessage: 'link, web, chrome, safari, firefox, arc, edge',
    }),
  },
  {
    id: 'editor.changes',
    page: 'editor',
    section: defineMessage({ id: 'settings.editor.changes', defaultMessage: 'Changes' }),
    label: defineMessage({ id: 'settings.editor.viewWith', defaultMessage: 'View with' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.changesViewer',
      defaultMessage: 'diff, review, changes',
    }),
    options: () => [
      t({ id: 'settings.editor.inAppDiff', defaultMessage: 'In-app diff' }),
      t({ id: 'settings.editor.editor', defaultMessage: 'Editor' }),
    ],
  },

  page('connections'),
  {
    id: 'connections.github',
    page: 'connections',
    label: defineMessage({ id: 'settings.connections.github', defaultMessage: 'GitHub' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.github',
      defaultMessage: 'gh, account, git host, sign in',
    }),
  },
  {
    id: 'connections.huggingface',
    page: 'connections',
    label: defineMessage({
      id: 'settings.connections.huggingface',
      defaultMessage: 'Hugging Face',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.huggingface',
      defaultMessage: 'hf, models, datasets, account, sign in',
    }),
  },
  {
    id: 'connections.cloudflare',
    page: 'connections',
    label: defineMessage({ id: 'settings.connections.cloudflare', defaultMessage: 'Cloudflare' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.cloudflare',
      defaultMessage: 'wrangler, workers, pages, account, sign in',
    }),
  },

  page('devices'),

  page('notifications'),
  ...Object.entries(DECISION_NAME).map(([kind, label]): SettingRecord => ({
    id: `notifications.${kind}`,
    page: 'notifications',
    section: notificationEvents,
    label,
    keywords: notificationKeywords,
    options: notificationDeliveries,
  })),
  {
    id: 'notifications.quietHours',
    page: 'notifications',
    section: notificationDelivery,
    label: defineMessage({
      id: 'settings.notifications.quietHours',
      defaultMessage: 'Quiet hours',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.quietHours',
      defaultMessage: 'do not disturb, night, mute, schedule',
    }),
  },
  {
    id: 'notifications.badge',
    page: 'notifications',
    section: notificationDelivery,
    label: defineMessage({
      id: 'settings.notifications.badge',
      defaultMessage: 'Show the count on the app icon',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.notificationBadge',
      defaultMessage: 'badge, unread, number, Dock, taskbar',
    }),
  },
  {
    id: 'notifications.test',
    page: 'notifications',
    section: notificationDelivery,
    label: defineMessage({
      id: 'settings.notifications.test',
      defaultMessage: 'Send a test notification',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.notificationTest',
      defaultMessage: 'try, check, alert',
    }),
  },

  page('shortcuts'),
  {
    id: 'shortcuts.keys',
    page: 'shortcuts',
    label: defineMessage({
      id: 'components.shortcuts.title',
      defaultMessage: 'Keyboard shortcuts',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.shortcuts',
      defaultMessage: 'keys, hotkeys, key bindings, keymap',
    }),
  },

  page('usage'),
  {
    id: 'usage.targets',
    page: 'usage',
    label: defineMessage({ id: 'settings.usage.targets', defaultMessage: 'Token targets' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.usageTargets',
      defaultMessage: 'budget, cost, quota, limit',
    }),
  },
  {
    id: 'project.budget',
    page: 'project',
    section: budgetAndQuota,
    label: defineMessage({
      id: 'data.workflowPolicy.param.projectBudget',
      defaultMessage: 'Project budget (input tokens)',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.projectBudget',
      defaultMessage: 'cost, limit',
    }),
  },
  {
    id: 'usage.runtimeQuotaThreshold',
    page: 'usage',
    section: budgetAndQuota,
    label: defineMessage({
      id: 'data.workflowPolicy.param.runtimeQuotaThreshold',
      defaultMessage: 'Runtime quota threshold (%)',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.runtimeQuotaThreshold',
      defaultMessage: 'quota, rate limit, usage limit',
    }),
  },

  page('data'),
  {
    id: 'data.folder',
    page: 'data',
    label: defineMessage({ id: 'settings.data.title', defaultMessage: 'Data folder' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.dataFolder',
      defaultMessage: 'directory, location, path',
    }),
    options: () => [revealText()],
  },
  {
    id: 'data.personal',
    page: 'data',
    label: personal,
    keywords: defineMessage({
      id: 'settings.search.keywords.personalSettings',
      defaultMessage: 'backup, restore, preferences',
    }),
    options: () => [
      t({ id: 'settings.data.export', defaultMessage: 'Export…' }),
      t({ id: 'settings.data.import', defaultMessage: 'Import…' }),
    ],
  },
  {
    id: 'data.export',
    page: 'data',
    section: personal,
    label: defineMessage({ id: 'settings.data.exportRow', defaultMessage: 'Export' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.personalExport',
      defaultMessage: 'backup, save settings',
    }),
  },
  {
    id: 'data.import',
    page: 'data',
    section: personal,
    label: defineMessage({ id: 'settings.data.importRow', defaultMessage: 'Import' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.personalImport',
      defaultMessage: 'restore, load settings',
    }),
  },
  {
    id: 'data.diagnostics',
    page: 'data',
    section: defineMessage({ id: 'settings.data.diagnostics', defaultMessage: 'Diagnostics' }),
    label: defineMessage({
      id: 'settings.data.diagnosticsLog',
      defaultMessage: 'Export diagnostic log',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.diagnostics',
      defaultMessage: 'logs, debug, support',
    }),
  },

  page('about'),
  {
    id: 'about.versions',
    page: 'about',
    label: defineMessage({ id: 'settings.about.versions', defaultMessage: 'Versions' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.aboutVersions',
      defaultMessage: 'app, daemon, protocol, electron, build',
    }),
  },
  {
    id: 'about.dataFolder',
    page: 'about',
    label: defineMessage({ id: 'settings.data.title', defaultMessage: 'Data folder' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.dataFolder',
      defaultMessage: 'directory, location, path',
    }),
    options: () => [revealText()],
  },
  {
    id: 'about.logs',
    page: 'about',
    label: defineMessage({ id: 'settings.about.logs', defaultMessage: 'Logs' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.aboutLogs',
      defaultMessage: 'log, folder, debug',
    }),
  },
  {
    id: 'about.diagnostics',
    page: 'about',
    label: defineMessage({ id: 'settings.about.diagnostics', defaultMessage: 'Diagnostics' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.aboutDiagnostics',
      defaultMessage: 'support, report, system, copy',
    }),
  },

  page('projects'),
  page('gates'),
  {
    id: 'gates.gate',
    page: 'gates',
    label: gate,
    keywords: defineMessage({
      id: 'settings.search.keywords.gate',
      defaultMessage: 'checks, tests, verification, worktree',
    }),
  },
  {
    id: 'gates.handbackLimit',
    page: 'gates',
    section: gate,
    label: defineMessage({ id: 'settings.gate.onFail', defaultMessage: 'When a gate fails' }),
  },
  {
    id: 'gates.runner',
    page: 'gates',
    section: gate,
    label: defineMessage({ id: 'settings.gate.runner', defaultMessage: 'Where gates run' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.gateRunner',
      defaultMessage: 'gate runner, daemon, session worktree',
    }),
    options: () => [
      t({ id: 'settings.gate.runner.daemon', defaultMessage: 'daemon' }),
      t({ id: 'settings.gate.runner.session', defaultMessage: 'Session worktree' }),
    ],
  },
  {
    id: 'gates.name',
    page: 'gates',
    section: gate,
    label: defineMessage({ id: 'settings.gate.name', defaultMessage: 'Name' }),
  },
  {
    id: 'gates.commandLine',
    page: 'gates',
    section: gate,
    label: defineMessage({ id: 'settings.gate.line', defaultMessage: 'Command line' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.gateCommand',
      defaultMessage: 'script, argv',
    }),
  },
  {
    id: 'gates.timeout',
    page: 'gates',
    section: gate,
    label: defineMessage({ id: 'settings.gate.timeoutField', defaultMessage: 'Timeout (s)' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.gateTimeout',
      defaultMessage: 'seconds, time limit',
    }),
  },

  page('worktrees'),
  {
    id: 'worktrees.location',
    page: 'worktrees',
    section: worktreeSetup,
    label: defineMessage({ id: 'settings.worktreeSetup.location', defaultMessage: 'Location' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.worktreeLocation',
      defaultMessage: 'folder, directory, path, finder',
    }),
  },
  {
    id: 'worktrees.copyPaths',
    page: 'worktrees',
    section: worktreeSetup,
    label: defineMessage({
      id: 'settings.worktreeSetup.copyPaths',
      defaultMessage: 'Copy these files',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.copyPaths',
      defaultMessage: 'copy, env, untracked, gitignore',
    }),
  },
  {
    id: 'worktrees.setupCommand',
    page: 'worktrees',
    section: worktreeSetup,
    label: defineMessage({ id: 'settings.worktreeSetup.command', defaultMessage: 'Setup command' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.setupCommand',
      defaultMessage: 'install, dependencies, script, bootstrap',
    }),
  },
  {
    id: 'worktrees.cleanup',
    page: 'worktrees',
    section: defineMessage({ id: 'settings.worktreeSetup.cleanup', defaultMessage: 'Cleanup' }),
    label: defineMessage({
      id: 'settings.worktreeSetup.cleanupRow',
      defaultMessage: 'Clean up old worktrees',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.cleanup',
      defaultMessage: 'delete, prune, archived, disk space',
    }),
  },

  page('permissions'),
  {
    id: 'permissions.rules',
    page: 'permissions',
    label: defineMessage({
      id: 'settings.permissions.rules',
      defaultMessage: 'Always-allowed rules',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.permissionRules',
      defaultMessage: 'approval, allow, permission rule, always allow',
    }),
  },

  page('external'),
  {
    id: 'external.mode',
    page: 'external',
    label: defineMessage({
      id: 'settings.external.requests',
      defaultMessage: 'Requests received',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.externalMode',
      defaultMessage: 'github, issue, notification, start on its own, approve, poll',
    }),
  },

  page('defaults'),
  {
    id: 'defaults.runtime',
    page: 'defaults',
    section: sessionDefaults,
    label: defineMessage({ id: 'settings.common.runtime', defaultMessage: 'Runtime' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.defaultRuntime',
      defaultMessage: 'harness, agent',
    }),
    options: runtimes,
  },
  {
    id: 'defaults.model',
    page: 'defaults',
    section: sessionDefaults,
    label: defineMessage({ id: 'sessions.composer.model', defaultMessage: 'Model' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.defaultModel',
      defaultMessage: 'reasoning effort, thinking',
    }),
  },
  {
    id: 'defaults.writer',
    page: 'defaults',
    section: sessionDefaults,
    label: defineMessage({ id: 'settings.defaults.writer', defaultMessage: 'Writing code' }),
  },
  {
    id: 'defaults.reviewer',
    page: 'defaults',
    section: sessionDefaults,
    label: defineMessage({ id: 'settings.defaults.reviewer', defaultMessage: 'Outside review' }),
  },
  {
    id: 'defaults.fallback',
    page: 'defaults',
    section: sessionDefaults,
    label: defineMessage({ id: 'settings.defaults.fallback', defaultMessage: 'If unavailable' }),
  },
  {
    id: 'defaults.permissionMode',
    page: 'defaults',
    section: sessionDefaults,
    label: defineMessage({
      id: 'settings.defaults.permissionMode',
      defaultMessage: 'Permission mode',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.permissionMode',
      defaultMessage: 'approval, sandbox, auto accept, bypass',
    }),
  },
  {
    id: 'defaults.singleModel',
    page: 'defaults',
    section: sessionDefaults,
    label: defineMessage({
      id: 'settings.defaults.leadModelForAll',
      defaultMessage: "Tasks and reviews also use the lead's model",
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.singleModel',
      defaultMessage: 'single model, one model, routing, reviewer',
    }),
  },

  page('project'),
  {
    id: 'project.name',
    page: 'project',
    section: environment,
    label: defineMessage({ id: 'settings.environment.name', defaultMessage: 'Project name' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.projectName',
      defaultMessage: 'rename, title',
    }),
  },
  {
    id: 'project.folders',
    page: 'project',
    section: environment,
    label: defineMessage({ id: 'projects.folders.label', defaultMessage: 'Folders' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.folders',
      defaultMessage: 'directories, repository, roots, worktree',
    }),
  },
  {
    id: 'project.variables',
    page: 'project',
    section: environment,
    label: defineMessage({
      id: 'projects.variables.label',
      defaultMessage: 'Environment variables',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.variables',
      defaultMessage: 'env, secrets, api key',
    }),
  },
  {
    id: 'project.remove',
    page: 'project',
    label: defineMessage({ id: 'settings.general.remove', defaultMessage: 'Remove project' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.removeProject',
      defaultMessage: 'delete, forget, close project',
    }),
  },
  {
    id: 'general.autoGitInit',
    page: 'general',
    section: languageAndSleep,
    label: defineMessage({
      id: 'settings.projects.autoGitInit',
      defaultMessage: 'Automatic git init',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.autoGitInit',
      defaultMessage: 'repository, initialize',
    }),
  },

  page('extensions'),
  {
    id: 'extensions.mcp',
    page: 'extensions',
    label: defineMessage({ id: 'settings.extensions.mcp', defaultMessage: 'MCP servers' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.mcp',
      defaultMessage: 'tools, model context protocol',
    }),
  },
  {
    id: 'extensions.plugins',
    page: 'extensions',
    label: defineMessage({ id: 'settings.extensions.plugins', defaultMessage: 'Plugins' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.plugins',
      defaultMessage: 'add-ons, addons',
    }),
  },
  {
    id: 'extensions.skills',
    page: 'extensions',
    label: defineMessage({ id: 'settings.extensions.skills', defaultMessage: 'Skills' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.skills',
      defaultMessage: 'abilities',
    }),
  },
  {
    id: 'extensions.apps',
    page: 'extensions',
    label: defineMessage({ id: 'settings.search.apps', defaultMessage: 'Apps' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.apps',
      defaultMessage: 'connectors, integrations',
    }),
  },
  {
    id: 'extensions.hooks',
    page: 'extensions',
    label: defineMessage({ id: 'settings.search.hooks', defaultMessage: 'Hooks' }),
    keywords: defineMessage({
      id: 'settings.search.keywords.hooks',
      defaultMessage: 'events, lifecycle, scripts',
    }),
  },
  {
    id: 'extensions.refresh',
    page: 'extensions',
    // The page header holds the refresh, so it joins the first group.
    section: defineMessage({ id: 'settings.extensions.mcp', defaultMessage: 'MCP servers' }),
    label: defineMessage({
      id: 'settings.extensions.refresh',
      defaultMessage: 'Refresh inventory',
    }),
    keywords: defineMessage({
      id: 'settings.search.keywords.refresh',
      defaultMessage: 'reload, rescan',
    }),
  },
];
