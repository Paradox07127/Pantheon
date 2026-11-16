import {
  id,
  requireThat,
  type Project,
  type Session,
  type Visual,
  type VisualContent,
} from '@pantheon/domain';
import {
  visualSpecs,
  type inputSchemas,
  type VisualChangedPayload,
  type VisualDrawnPayload,
  type ZodIssue,
} from '@pantheon/protocol';
import { projectAccess, userOnly, type ControlContext, type Handlers } from './context.js';

type Input<K extends keyof typeof inputSchemas> = ReturnType<(typeof inputSchemas)[K]['parse']>;

export interface VisualDrawReceipt {
  visual_id: string;
  revision: number;
  issues?: ZodIssue[];
}

function pinVisual(
  ctx: ControlContext,
  visual: Visual,
  size: 'S' | 'M' | 'L',
  width?: 4 | 6 | 8 | 12,
): Visual {
  const position =
    visual.pin?.position ??
    1 +
      Math.max(
        -1,
        ...ctx.store
          .list<Visual>('visuals')
          .filter((item) => item.project_id === visual.project_id && item.pin)
          .map((item) => item.pin!.position),
      );
  return {
    ...visual,
    pin: { ...visual.pin, size, position, ...(width === undefined ? {} : { width }) },
    updated_at: ctx.store.now(),
  };
}

/** Records that a pin or unpin was stored, so every window reads the visual and the board again. */
function changed(ctx: ControlContext, c: { command_id: string }, visual: Visual): Visual {
  ctx.store.event(
    'visual.changed',
    visual,
    visual.project_id,
    { visual_ids: [visual.id] } satisfies VisualChangedPayload,
    c.command_id,
  );
  return visual;
}

export const visualHandlers: Handlers = {
  'visual.draw': (ctx, p, c) => {
    requireThat(p.session_id, 'permission_denied', 'Drawing requires a session credential');
    const session = ctx.store.must<Session>('sessions', p.session_id);
    const input = c.input as Input<'visual.draw'> & VisualContent;
    const previous = input.replaces ? ctx.store.get<Visual>('visuals', input.replaces) : undefined;
    requireThat(
      !input.replaces || previous?.session_id === session.id,
      'permission_denied',
      'replaces must name a visual drawn by the same session',
    );
    const result = visualSpecs[input.kind].safeParse(input.spec);
    const now = ctx.store.now();
    let visual: Visual = {
      ...previous,
      id: previous?.id ?? id(),
      project_id: session.project_id,
      session_id: session.id,
      title: input.title,
      source: input.source,
      size: input.size,
      error: result.success
        ? undefined
        : result.error.issues.slice(0, 20).map((issue) => ({
            message: issue.message,
            path: issue.path as (string | number)[],
          })),
      ...({ kind: input.kind, spec: input.spec } as VisualContent),
      revision: (previous?.revision ?? 0) + 1,
      created_at: previous?.created_at ?? now,
      updated_at: now,
    };
    if (input.pin) visual = pinVisual(ctx, visual, input.pin);
    if (previous) ctx.store.saveVisual(visual);
    else ctx.store.insert('visuals', visual);
    ctx.store.event(
      'visual.drawn',
      session,
      session.project_id,
      {
        visual_id: visual.id,
        title: visual.title,
        kind: visual.kind,
        revision: visual.revision,
        ...(result.success ? {} : { failed: true as const }),
      } satisfies VisualDrawnPayload,
      c.command_id,
    );
    return {
      visual_id: visual.id,
      revision: visual.revision,
      ...(result.success
        ? {}
        : {
            issues: result.error.issues.map((issue) => ({
              ...issue,
              path: ['spec', ...issue.path],
            })),
          }),
    } satisfies VisualDrawReceipt;
  },
  'visual.read': (ctx, p, c) => {
    userOnly(p);
    const input = c.input as Input<'visual.read'>;
    const visual = ctx.store.must<Visual>('visuals', input.visual_id);
    projectAccess(ctx, p, visual.project_id, c.type);
    return visual;
  },
  'visual.list': (ctx, p, c) => {
    userOnly(p);
    const input = c.input as Input<'visual.list'>;
    projectAccess(ctx, p, input.project_id, c.type);
    const visuals = ctx.store
      .list<Visual>('visuals')
      .reverse()
      .filter(
        (visual) =>
          visual.project_id === input.project_id &&
          (input.session_id === undefined || visual.session_id === input.session_id) &&
          (!input.pinned || visual.pin),
      )
      .sort((a, b) =>
        input.pinned ? a.pin!.position - b.pin!.position : b.created_at - a.created_at,
      )
      .slice(0, 200);
    return { visuals };
  },
  'visual.pin': (ctx, p, c) => {
    userOnly(p);
    const input = c.input as Input<'visual.pin'>;
    const visual = ctx.store.must<Visual>('visuals', input.visual_id);
    projectAccess(ctx, p, visual.project_id, c.type);
    return changed(ctx, c, ctx.store.saveVisual(pinVisual(ctx, visual, input.size, input.width)));
  },
  'visual.unpin': (ctx, p, c) => {
    userOnly(p);
    const input = c.input as Input<'visual.unpin'>;
    const visual = ctx.store.must<Visual>('visuals', input.visual_id);
    projectAccess(ctx, p, visual.project_id, c.type);
    const { pin, ...rest } = visual;
    return changed(ctx, c, ctx.store.saveVisual({ ...rest, updated_at: ctx.store.now() }));
  },
  'visual.arrange': (ctx, p, c) => {
    userOnly(p);
    const input = c.input as Input<'visual.arrange'>;
    projectAccess(ctx, p, input.project_id, c.type);
    const pinned = new Map(
      ctx.store
        .list<Visual>('visuals')
        .filter((visual) => visual.project_id === input.project_id && visual.pin)
        .map((visual) => [visual.id, visual]),
    );
    requireThat(
      input.order.length === pinned.size &&
        new Set(input.order).size === pinned.size &&
        input.order.every((id) => pinned.has(id)),
      'invalid_input',
      'order must contain exactly the pinned visual ids of this project',
    );
    const visuals = input.order.map((id, position) => {
      const visual = pinned.get(id)!;
      return ctx.store.saveVisual({
        ...visual,
        pin: { ...visual.pin!, position },
        updated_at: ctx.store.now(),
      });
    });
    ctx.store.event(
      'visual.changed',
      ctx.store.must<Project>('projects', input.project_id),
      input.project_id,
      { visual_ids: input.order } satisfies VisualChangedPayload,
      c.command_id,
    );
    return { visuals };
  },
};
