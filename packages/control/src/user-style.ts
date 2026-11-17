import type { Entity } from '@pantheon/domain';
import type { inputSchemas, StyleChangedPayload, UserStyleRead } from '@pantheon/protocol';
import { userOnly, type ControlContext, type Handlers } from './context.js';

type Input<K extends keyof typeof inputSchemas> = ReturnType<(typeof inputSchemas)[K]['parse']>;

interface UserStyle extends Entity {
  css: string;
  enabled: boolean;
}

const STYLE_ID = 'app.style';

function rules(css: string): number {
  return css.replace(/\/\*[\s\S]*?\*\//g, '').split('{').length - 1;
}

function view(style: UserStyle | undefined): UserStyleRead {
  return {
    css: style?.css ?? '',
    enabled: style?.enabled ?? true,
    rules: rules(style?.css ?? ''),
    revision: style?.revision ?? 0,
  };
}

function changeStyle(
  ctx: ControlContext,
  change: Pick<UserStyle, 'css' | 'enabled'>,
  cause: string,
  bySession?: string,
): UserStyleRead {
  const current = ctx.store.get<UserStyle>('user_styles', STYLE_ID);
  const next = current
    ? ctx.store.update<UserStyle>('user_styles', { ...current, ...change }, current.revision)
    : ctx.store.insert<UserStyle>('user_styles', { id: STYLE_ID, revision: 1, ...change });
  const read = view(next);
  ctx.store.event(
    'style.changed',
    next,
    '',
    {
      revision: read.revision,
      enabled: read.enabled,
      rules: read.rules,
      ...(bySession === undefined ? {} : { by_session_id: bySession }),
    } satisfies StyleChangedPayload,
    cause,
  );
  return read;
}

export const styleHandlers: Handlers = {
  'style.set': (ctx, p, c) => {
    if (!p.session_id) userOnly(p);
    const input = c.input as Input<'style.set'>;
    return changeStyle(ctx, { css: input.css, enabled: true }, c.command_id, p.session_id);
  },
  'style.enable': (ctx, p, c) => {
    userOnly(p);
    const input = c.input as Input<'style.enable'>;
    return changeStyle(ctx, { css: styleRead(ctx).css, enabled: input.enabled }, c.command_id);
  },
  'style.clear': (ctx, p, c) => {
    userOnly(p);
    return changeStyle(ctx, { css: '', enabled: styleRead(ctx).enabled }, c.command_id);
  },
};

export function styleRead(ctx: ControlContext): UserStyleRead {
  return view(ctx.store.get<UserStyle>('user_styles', STYLE_ID));
}
