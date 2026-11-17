import type { NeedsYouItem } from '@pantheon/domain';
import {
  inputSchemas,
  NEEDS_YOU_DECISIONS,
  type AppSettings,
  type AttentionDelivery,
} from '@pantheon/protocol';
import { withinHours } from './agent-always-on.js';
import { userOnly, type ControlContext, type Handlers } from './context.js';
import { readUserConfig, userConfigDirectory, writeUserConfig } from './user-config.js';

/** A question that has waited this long reaches the user now, whatever the rules say. */
const OVERDUE_QUESTION_MS = 4 * 3_600_000;

export const appSettingsHandlers: Handlers = {
  'app.settings.set': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['app.settings.set'].parse(c.input);
    const dir = userConfigDirectory(ctx);
    writeUserConfig(
      dir,
      input.attention_delivery
        ? {
            ...input,
            attention_delivery: {
              ...readUserConfig(dir).attention_delivery,
              ...input.attention_delivery,
            },
          }
        : input,
    );
    ctx.store.event(
      'app.settings_set',
      { id: 'app.settings', revision: 1 },
      '',
      input,
      c.command_id,
    );
    return readAppSettings(ctx);
  },
};

export function readAppSettings(ctx: ControlContext): AppSettings {
  const config = readUserConfig(ctx.userConfigDir);
  return {
    auto_git_init: config.auto_git_init ?? true,
    auto_archive_merged: config.auto_archive_merged ?? false,
    session_recap: config.session_recap ?? true,
    attention_delivery: Object.fromEntries(
      NEEDS_YOU_DECISIONS.map((kind) => [kind, config.attention_delivery?.[kind] ?? 'now']),
    ) as AppSettings['attention_delivery'],
    ...(config.quiet_hours && { quiet_hours: config.quiet_hours }),
    baseline_rounds: config.baseline_rounds ?? 5,
    baseline_visuals: config.baseline_visuals ?? true,
    baseline_range_story: config.baseline_range_story ?? true,
  };
}

/** How the item reaches the user at `now`: an overdue question always now, else quiet hours hold now for the brief. */
export function deliveryFor(
  settings: Pick<AppSettings, 'attention_delivery' | 'quiet_hours'>,
  item: Pick<NeedsYouItem, 'decision' | 'created_at'>,
  now: number,
): AttentionDelivery {
  if (item.decision === 'question' && now - item.created_at > OVERDUE_QUESTION_MS) return 'now';
  const delivery = settings.attention_delivery[item.decision];
  return delivery === 'now' && settings.quiet_hours && withinHours(settings.quiet_hours, now)
    ? 'brief'
    : delivery;
}
