import { DomainError, type Entity } from '@pantheon/domain';
import type {
  inputSchemas,
  ThemeAppliedPayload,
  ThemeList,
  ThemeRead,
  ThemeSetReceipt,
} from '@pantheon/protocol';
import { checkBackdrop, deriveTheme, themeCss, type ThemeInput } from '@pantheon/protocol/theme';
import { userOnly, type ControlContext, type Handlers } from './context.js';

type Input<K extends keyof typeof inputSchemas> = ReturnType<(typeof inputSchemas)[K]['parse']>;

export interface Theme extends Entity {
  label: string;
  input: ThemeInput;
  css: string;
  backdrop?: string;
  glass?: ThemeRead['glass'];
  modes: ('light' | 'dark')[];
  session_id?: string;
  created_at: number;
  /** Set on the one applied theme; none set is the default theme. */
  active?: true;
}

/** Canvas, text and accent in light, then in dark. */
function builtInInput(label: string, light: string[], dark: string[]): ThemeInput {
  const mode = ([surface, text, accent]: string[]) => ({
    anchors: { 'surface-0': surface!, 'text-primary': text! },
    roles: { accent: accent! },
  });
  return { label, light: mode(light), dark: mode(dark) };
}

/** The themes that ship with the app, by id; they are derived here and never saved. */
const builtInThemes: Record<string, ThemeInput> = {
  'builtin-travertine': builtInInput(
    'Travertine',
    ['#FBF7EE', '#3A2E22', '#8A6A3F'],
    ['#211C15', '#F1E6CF', '#C9A46A'],
  ),
  'builtin-dusk': builtInInput(
    'Dusk',
    ['#F3F5FB', '#1F2D54', '#24345F'],
    ['#141B33', '#F1E6CF', '#FFD58A'],
  ),
  'builtin-lapis': builtInInput(
    'Lapis',
    ['#F2F4FC', '#182760', '#2F4BA8'],
    ['#111839', '#E9E3CF', '#E9C46A'],
  ),
  'builtin-terracotta': builtInInput(
    'Terracotta',
    ['#FCF5F0', '#4A2A1A', '#B4532A'],
    ['#231711', '#FBF1E2', '#E07A4C'],
  ),
};

const isBuiltIn = (id: string) => id.startsWith('builtin-');

function builtInTheme(id: string): Theme | undefined {
  const input = builtInThemes[id];
  if (!input) return undefined;
  const { modes } = deriveTheme(input);
  return {
    id,
    revision: 0,
    label: input.label,
    input,
    css: themeCss(id, modes),
    modes: (['light', 'dark'] as const).filter((mode) => modes[mode]),
    created_at: 0,
  };
}

const findTheme = (ctx: ControlContext, id: string): Theme =>
  builtInTheme(id) ?? ctx.store.must<Theme>('themes', id);

// An applied built-in theme is kept as a row holding only its id and the active flag.
const activeTheme = (ctx: ControlContext) =>
  ctx.store.list<Theme>('themes').find((theme) => theme.active);

/** A slug of the label that no saved theme uses yet and that is not a built-in theme's. */
function themeId(ctx: ControlContext, label: string): string {
  const slug =
    label
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'theme';
  const base = /^builtin(-|$)/.test(slug) ? `theme-${slug}` : slug;
  let id = base;
  for (let n = 2; ctx.store.get<Theme>('themes', id); n++) id = `${base}-${n}`;
  return id;
}

function applyTheme(
  ctx: ControlContext,
  themeId: string | null,
  cause: string,
  bySession?: string,
): void {
  const current = activeTheme(ctx);
  if (current && isBuiltIn(current.id)) ctx.store.remove('themes', current.id, current.revision);
  else if (current) {
    const { active: _, ...rest } = current;
    ctx.store.update('themes', rest, current.revision);
  }
  if (themeId !== null && isBuiltIn(themeId))
    ctx.store.insert('themes', { id: themeId, revision: 1, active: true });
  else if (themeId !== null) {
    const next = ctx.store.must<Theme>('themes', themeId);
    ctx.store.update('themes', { ...next, active: true }, next.revision);
  }
  const previous = current?.id;
  ctx.store.event(
    'theme.applied',
    { id: 'app.theme', revision: 1 },
    '',
    {
      theme_id: themeId,
      ...(previous === undefined ? {} : { previous_theme_id: previous }),
      ...(bySession === undefined ? {} : { by_session_id: bySession }),
    } satisfies ThemeAppliedPayload,
    cause,
  );
}

export const themeHandlers: Handlers = {
  'theme.set': (ctx, p, c) => {
    if (!p.session_id) userOnly(p);
    const input = c.input as Input<'theme.set'>;
    const { modes, blocking, warnings } = deriveTheme(input);
    if (blocking.length > 0)
      throw new DomainError(
        'invalid_input',
        `Contrast too low; change these colours and set the theme again:\n${blocking.map((line) => `- ${line}`).join('\n')}`,
      );
    const problems = input.backdrop ? checkBackdrop(input.backdrop.svg) : [];
    if (problems.length > 0)
      throw new DomainError(
        'invalid_input',
        `The backdrop cannot be shown; fix it and set the theme again:\n${problems.map((line) => `- ${line}`).join('\n')}`,
      );
    const id = themeId(ctx, input.label);
    const theme: Theme = {
      id,
      revision: 1,
      label: input.label,
      input,
      css: themeCss(id, modes),
      ...(input.backdrop && {
        backdrop: input.backdrop.svg,
        ...(input.backdrop.glass !== undefined && { glass: input.backdrop.glass }),
      }),
      modes: (['light', 'dark'] as const).filter((mode) => modes[mode]),
      ...(p.session_id !== undefined && { session_id: p.session_id }),
      created_at: ctx.store.now(),
    };
    ctx.store.insert('themes', theme);
    applyTheme(ctx, id, c.command_id, p.session_id);
    return { theme_id: id, warnings } satisfies ThemeSetReceipt;
  },
  'theme.apply': (ctx, p, c) => {
    userOnly(p);
    const input = c.input as Input<'theme.apply'>;
    if (input.theme_id !== null) findTheme(ctx, input.theme_id);
    applyTheme(ctx, input.theme_id, c.command_id);
    return { theme_id: input.theme_id };
  },
  'theme.delete': (ctx, p, c) => {
    userOnly(p);
    const input = c.input as Input<'theme.delete'>;
    if (isBuiltIn(input.theme_id))
      throw new DomainError(
        'invalid_input',
        `${input.theme_id} is a built-in theme and cannot be deleted`,
      );
    if (ctx.store.must<Theme>('themes', input.theme_id).active) applyTheme(ctx, null, c.command_id);
    const theme = ctx.store.must<Theme>('themes', input.theme_id);
    ctx.store.remove('themes', theme.id, theme.revision);
    return { theme_id: theme.id };
  },
};

export function themeList(ctx: ControlContext): ThemeList {
  const saved = ctx.store
    .list<Theme>('themes')
    .filter((theme) => !isBuiltIn(theme.id))
    .reverse();
  const builtIns = Object.keys(builtInThemes).map((id) => builtInTheme(id)!);
  const themes = [...builtIns, ...saved].map((theme) => {
    const { modes } = deriveTheme(theme.input);
    const table = (modes.light ?? modes.dark)!;
    return {
      id: theme.id,
      label: theme.label,
      modes: theme.modes,
      has_backdrop: theme.backdrop !== undefined,
      built_in: isBuiltIn(theme.id),
      ...(theme.session_id !== undefined && { session_id: theme.session_id }),
      created_at: theme.created_at,
      swatches: { surface0: table['--bg']!, surface1: table['--sf']!, accent: table['--ac']! },
    };
  });
  return { active_theme_id: activeTheme(ctx)?.id ?? null, themes };
}

export function themeRead(ctx: ControlContext, themeId: string): ThemeRead {
  const theme = findTheme(ctx, themeId);
  return {
    id: theme.id,
    label: theme.label,
    css: theme.css,
    ...(theme.backdrop !== undefined && { backdrop: theme.backdrop }),
    ...(theme.glass !== undefined && { glass: theme.glass }),
    modes: theme.modes,
  };
}
