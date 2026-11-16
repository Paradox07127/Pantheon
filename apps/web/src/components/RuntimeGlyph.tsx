import type { WorkbenchSession } from '@pantheon/protocol';
import { useSessionDisplay } from '../data/session-display';
import { t } from '../i18n';
import { BrandMark, type Brand } from './BrandMark';
import './runtime-glyph.css';

/** What the UI does differently for a runtime. */
export interface RuntimeTraits {
  /** Permission modes a session can switch between; empty when the runtime has no switch. */
  modes: readonly WorkbenchSession['permission_mode'][];
  /** The runtime's own names of permission modes, where they differ from the shared ones. */
  modeNames: Partial<Record<WorkbenchSession['permission_mode'], string>>;
  /** What the composer puts before a skill name. */
  skillSigil: string;
  /** A picked skill is kept with its file path, to be sent beside the message. */
  skillPath: boolean;
  /** Creating a session sends the skills picked in its first message. */
  turnSkills: boolean;
  /** Who reviews the runtime's sessions unless told otherwise. */
  reviewer: string;
  /** What the extension settings call the runtime's apps switch. */
  appsLabel: string;
  /** The daemon lists the runtime's extensions, so the extension settings show a tab for it. */
  extensions: boolean;
}

interface RuntimeIdentity extends RuntimeTraits {
  name: string;
  /** CSS variable of the identity colour. */
  tone: string;
  /** The vendor mark the runtime is drawn with; without one it gets the generic glyph. */
  mark?: Brand;
  /** Who makes the models the runtime runs by default. */
  maker?: Brand;
}

/** The traits of a runtime the table does not list. */
const DEFAULT_TRAITS: RuntimeTraits = {
  modes: ['ask', 'auto_edit', 'plan'],
  modeNames: {},
  skillSigil: '/',
  skillPath: false,
  turnSkills: false,
  reviewer: 'claude',
  appsLabel: 'Apps',
  extensions: false,
};

/** Every runtime the UI knows, in display order: the only source of its name, colour, glyph and traits. */
const IDENTITY = new Map<string, RuntimeIdentity>([
  [
    'claude',
    {
      name: 'Claude',
      tone: '--rt-claude',
      mark: 'claude-code',
      maker: 'claude',
      modes: ['ask', 'auto_edit', 'plan'],
      modeNames: {},
      skillSigil: '/',
      skillPath: false,
      turnSkills: false,
      reviewer: 'codex',
      get appsLabel() {
        return t({
          id: 'components.runtime.claudeConnectors',
          defaultMessage: 'claude.ai connectors',
        });
      },
      extensions: true,
    },
  ],
  [
    'codex',
    {
      name: 'Codex',
      tone: '--rt-codex',
      mark: 'codex',
      maker: 'openai',
      // Codex cannot ask before each edit.
      modes: ['auto_edit', 'plan'],
      // Its sandbox modes: plan runs read-only, auto edit writes inside the workspace.
      modeNames: {
        get plan() {
          return t({ id: 'components.runtime.codexReadOnly', defaultMessage: 'Read only' });
        },
        get auto_edit() {
          return t({
            id: 'components.runtime.codexWorkspaceWrite',
            defaultMessage: 'Workspace write',
          });
        },
      },
      skillSigil: '$',
      skillPath: true,
      turnSkills: true,
      reviewer: 'claude',
      appsLabel: 'Apps',
      extensions: true,
    },
  ],
  [
    'agy',
    {
      name: 'agy',
      tone: '--rt-agy',
      mark: 'antigravity',
      maker: 'gemini',
      // Its ACP modes default, accept-edits and plan.
      modes: ['ask', 'auto_edit', 'plan'],
      modeNames: {},
      skillSigil: '/',
      skillPath: false,
      turnSkills: false,
      reviewer: 'claude',
      appsLabel: 'Apps',
      extensions: true,
    },
  ],
  [
    'grok',
    {
      name: 'grok',
      tone: '--rt-grok',
      mark: 'grok',
      maker: 'grok',
      // Its ACP session has no modes.
      modes: [],
      modeNames: {},
      skillSigil: '/',
      skillPath: false,
      turnSkills: false,
      reviewer: 'claude',
      appsLabel: 'Apps',
      extensions: true,
    },
  ],
  [
    'dsh',
    {
      name: 'DeepSeek',
      tone: '--rt-dsh',
      mark: 'deepseek',
      maker: 'deepseek',
      // Its sandbox, set at launch: plan runs read-only, auto edit writes inside the workspace.
      modes: ['auto_edit', 'plan'],
      modeNames: {},
      skillSigil: '/',
      skillPath: false,
      turnSkills: false,
      reviewer: 'claude',
      appsLabel: 'Apps',
      extensions: false,
    },
  ],
  [
    'muse',
    {
      name: 'Muse',
      tone: '--rt-muse',
      mark: 'meta',
      maker: 'meta',
      // Pantheon sets no ACP mode, so Muse keeps its own approval mode.
      modes: [],
      modeNames: {},
      skillSigil: '/',
      skillPath: false,
      turnSkills: false,
      reviewer: 'claude',
      appsLabel: 'Apps',
      extensions: false,
    },
  ],
  [
    'opencode',
    {
      name: 'OpenCode',
      tone: '--rt-opencode',
      mark: 'opencode',
      maker: 'opencode',
      // Pantheon sets no ACP mode.
      modes: [],
      modeNames: {},
      skillSigil: '/',
      skillPath: false,
      turnSkills: false,
      reviewer: 'claude',
      appsLabel: 'Apps',
      extensions: false,
    },
  ],
  [
    'cursor',
    {
      name: 'Cursor',
      tone: '--rt-cursor',
      mark: 'cursor',
      maker: 'cursor',
      // Pantheon sets no ACP mode.
      modes: [],
      modeNames: {},
      skillSigil: '/',
      skillPath: false,
      turnSkills: false,
      reviewer: 'claude',
      appsLabel: 'Apps',
      extensions: false,
    },
  ],
  [
    'copilot',
    {
      name: 'GitHub Copilot',
      tone: '--rt-copilot',
      mark: 'github-copilot',
      maker: 'github-copilot',
      // Pantheon sets no ACP mode.
      modes: [],
      modeNames: {},
      skillSigil: '/',
      skillPath: false,
      turnSkills: false,
      reviewer: 'claude',
      appsLabel: 'Apps',
      extensions: false,
    },
  ],
  [
    'gemini',
    {
      name: 'Gemini CLI',
      tone: '--rt-gemini',
      mark: 'gemini',
      maker: 'gemini',
      // Pantheon sets no ACP mode.
      modes: [],
      modeNames: {},
      skillSigil: '/',
      skillPath: false,
      turnSkills: false,
      reviewer: 'claude',
      appsLabel: 'Apps',
      extensions: false,
    },
  ],
  [
    'kilo',
    {
      name: 'Kilo Code',
      tone: '--rt-kilo',
      mark: 'kilo-code',
      maker: 'kilo-code',
      // Pantheon sets no ACP mode.
      modes: [],
      modeNames: {},
      skillSigil: '/',
      skillPath: false,
      turnSkills: false,
      reviewer: 'claude',
      appsLabel: 'Apps',
      extensions: false,
    },
  ],
  [
    'cline',
    {
      name: 'Cline',
      tone: '--rt-cline',
      mark: 'cline',
      maker: 'cline',
      // Pantheon sets no ACP mode.
      modes: [],
      modeNames: {},
      skillSigil: '/',
      skillPath: false,
      turnSkills: false,
      reviewer: 'claude',
      appsLabel: 'Apps',
      extensions: false,
    },
  ],
  [
    'qwen',
    {
      name: 'Qwen Code',
      tone: '--rt-qwen',
      mark: 'qwen',
      maker: 'qwen',
      // Pantheon sets no ACP mode.
      modes: [],
      modeNames: {},
      skillSigil: '/',
      skillPath: false,
      turnSkills: false,
      reviewer: 'claude',
      appsLabel: 'Apps',
      extensions: false,
    },
  ],
  [
    'kimi',
    {
      name: 'Kimi Code',
      tone: '--rt-kimi',
      mark: 'kimi',
      maker: 'kimi',
      // Pantheon sets no ACP mode.
      modes: [],
      modeNames: {},
      skillSigil: '/',
      skillPath: false,
      turnSkills: false,
      reviewer: 'claude',
      appsLabel: 'Apps',
      extensions: false,
    },
  ],
  [
    'goose',
    {
      name: 'Goose',
      tone: '--rt-goose',
      mark: 'goose',
      maker: 'goose',
      // Pantheon sets no ACP mode.
      modes: [],
      modeNames: {},
      skillSigil: '/',
      skillPath: false,
      turnSkills: false,
      reviewer: 'claude',
      appsLabel: 'Apps',
      extensions: false,
    },
  ],
  [
    'openhands',
    {
      name: 'OpenHands',
      tone: '--rt-openhands',
      mark: 'openhands',
      maker: 'openhands',
      // Pantheon sets no ACP mode.
      modes: [],
      modeNames: {},
      skillSigil: '/',
      skillPath: false,
      turnSkills: false,
      reviewer: 'claude',
      appsLabel: 'Apps',
      extensions: false,
    },
  ],
  [
    'kiro',
    {
      name: 'Kiro',
      tone: '--rt-kiro',
      mark: 'kiro',
      maker: 'kiro',
      // Pantheon sets no ACP mode.
      modes: [],
      modeNames: {},
      skillSigil: '/',
      skillPath: false,
      turnSkills: false,
      reviewer: 'claude',
      appsLabel: 'Apps',
      extensions: false,
    },
  ],
  [
    'junie',
    {
      name: 'Junie',
      tone: '--rt-junie',
      mark: 'junie',
      maker: 'junie',
      // Pantheon sets no ACP mode.
      modes: [],
      modeNames: {},
      skillSigil: '/',
      skillPath: false,
      turnSkills: false,
      reviewer: 'claude',
      appsLabel: 'Apps',
      extensions: false,
    },
  ],
  [
    'devin',
    {
      name: 'Devin',
      tone: '--rt-devin',
      mark: 'devin',
      maker: 'devin',
      // Pantheon sets no ACP mode.
      modes: [],
      modeNames: {},
      skillSigil: '/',
      skillPath: false,
      turnSkills: false,
      reviewer: 'claude',
      appsLabel: 'Apps',
      extensions: false,
    },
  ],
  [
    'vibe',
    {
      name: 'Mistral Vibe',
      tone: '--rt-vibe',
      mark: 'mistral',
      maker: 'mistral',
      // Pantheon sets no ACP mode.
      modes: [],
      modeNames: {},
      skillSigil: '/',
      skillPath: false,
      turnSkills: false,
      reviewer: 'claude',
      appsLabel: 'Apps',
      extensions: false,
    },
  ],
  [
    'auggie',
    {
      name: 'Augment',
      tone: '--mu',
      // Pantheon sets no ACP mode.
      modes: [],
      modeNames: {},
      skillSigil: '/',
      skillPath: false,
      turnSkills: false,
      reviewer: 'claude',
      appsLabel: 'Apps',
      extensions: false,
    },
  ],
  [
    'hermes',
    {
      name: 'Hermes Agent',
      tone: '--rt-hermes',
      mark: 'hermes-agent',
      maker: 'hermes-agent',
      // Pantheon sets no ACP mode.
      modes: [],
      modeNames: {},
      skillSigil: '/',
      skillPath: false,
      turnSkills: false,
      reviewer: 'claude',
      appsLabel: 'Apps',
      extensions: false,
    },
  ],
  [
    'omp',
    {
      name: 'omp',
      tone: '--mu',
      // Pantheon sets no ACP mode.
      modes: [],
      modeNames: {},
      skillSigil: '/',
      skillPath: false,
      turnSkills: false,
      reviewer: 'claude',
      appsLabel: 'Apps',
      extensions: false,
    },
  ],
  [
    'codebuddy',
    {
      name: 'CodeBuddy',
      tone: '--rt-codebuddy',
      mark: 'codebuddy',
      maker: 'codebuddy',
      // Pantheon sets no ACP mode.
      modes: [],
      modeNames: {},
      skillSigil: '/',
      skillPath: false,
      turnSkills: false,
      reviewer: 'claude',
      appsLabel: 'Apps',
      extensions: false,
    },
  ],
  [
    'droid',
    {
      name: 'Factory Droid',
      tone: '--mu',
      // Pantheon sets no ACP mode.
      modes: [],
      modeNames: {},
      skillSigil: '/',
      skillPath: false,
      turnSkills: false,
      reviewer: 'claude',
      appsLabel: 'Apps',
      extensions: false,
    },
  ],
  [
    'qoder',
    {
      name: 'Qoder',
      tone: '--rt-qoder',
      mark: 'qoder',
      maker: 'qoder',
      // Pantheon sets no ACP mode.
      modes: [],
      modeNames: {},
      skillSigil: '/',
      skillPath: false,
      turnSkills: false,
      reviewer: 'claude',
      appsLabel: 'Apps',
      extensions: false,
    },
  ],
]);
const ORDER = [...IDENTITY.keys()];

/** The runtimes the table lists, in its order. */
export const KNOWN_RUNTIMES: readonly string[] = ORDER;

export const runtimeTraits = (runtime: string): RuntimeTraits =>
  IDENTITY.get(runtime) ?? DEFAULT_TRAITS;

/** Model id patterns, case aside, and who makes those models. */
const MAKERS: [RegExp, Brand][] = [
  [/^(?:claude-|(?:opus|sonnet|haiku)\b)/i, 'claude'],
  [/^(?:gpt-|o\d|codex-)/i, 'openai'],
  [/^gemini-/i, 'gemini'],
  [/^grok-/i, 'grok'],
  [/^deepseek-/i, 'deepseek'],
  [/^muse-/i, 'meta'],
  [/^qwen/i, 'qwen'],
  [/^kimi-/i, 'kimi'],
  [/^(?:mistral|devstral|codestral)/i, 'mistral'],
];

const identity = (runtime: string): Pick<RuntimeIdentity, 'name' | 'tone'> =>
  IDENTITY.get(runtime) ?? { name: runtime, tone: '--mu' };

export const runtimeName = (runtime: string | null): string =>
  runtime === null
    ? t({ id: 'components.runtime.unknown', defaultMessage: 'Unknown runtime' })
    : identity(runtime).name;

export const runtimeColor = (runtime: string | null): string =>
  `var(${runtime === null ? '--mu' : identity(runtime).tone})`;

const rank = (runtime: string) => (IDENTITY.has(runtime) ? ORDER.indexOf(runtime) : ORDER.length);

/** Known runtimes in table order, then other runtimes by name. */
export const compareRuntimes = (a: string, b: string): number =>
  rank(a) - rank(b) || a.localeCompare(b);

/** Which runtime does the work, by its vendor's mark; a runtime without one gets the generic glyph. */
export function RuntimeGlyph({ runtime, size = 16 }: { runtime: string; size?: number }) {
  const mono = useSessionDisplay().vendor_marks === 'mono';
  if (!runtime) return null;
  const mark = IDENTITY.get(runtime)?.mark;
  if (mark)
    return (
      <BrandMark
        brand={mark}
        size={size}
        fill={mono ? 'currentColor' : runtimeColor(runtime)}
        mono={mono}
      />
    );
  return (
    <svg
      aria-hidden
      className="rtg"
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="var(--mu)"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3.5 3.5h7v7h-7Z" />
    </svg>
  );
}

/**
 * The mark of the model's maker, put before its name; nothing for a maker the table does not
 * know, or `beside` the glyph of a runtime whose own models come from the same maker.
 */
export function ModelMark({
  model,
  beside,
  size = 16,
}: {
  model: string | null | undefined;
  beside?: string | null;
  size?: number;
}) {
  const mono = useSessionDisplay().vendor_marks === 'mono';
  const maker = model ? (MAKERS.find(([pattern]) => pattern.test(model))?.[1] ?? null) : null;
  if (!maker || (beside && IDENTITY.get(beside)?.maker === maker)) return null;
  return <BrandMark brand={maker} size={size} fill="currentColor" mono={mono} />;
}
