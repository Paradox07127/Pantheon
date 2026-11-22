import {
  ATTENTION_KINDS,
  DEFAULT_ATTENTION_DELIVERY,
  inputSchemas,
  type AppSettings,
} from '@pantheon/protocol';
import { userOnly, type ControlContext, type Handlers } from './context.js';
import { readUserConfig, userConfigDirectory, writeUserConfig } from './user-config.js';

export { deliveryFor } from '@pantheon/protocol';

export const appSettingsHandlers: Handlers = {
  'app.settings.set': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['app.settings.set'].parse(c.input);
    const dir = userConfigDirectory(ctx);
    const { quiet_hours, ...rest } = input;
    writeUserConfig(dir, {
      ...rest,
      // Null clears the quiet hours.
      ...(quiet_hours !== undefined && { quiet_hours: quiet_hours ?? undefined }),
      ...(input.attention_delivery && {
        attention_delivery: {
          ...readUserConfig(dir).attention_delivery,
          ...input.attention_delivery,
        },
      }),
    });
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
    brief_prose: config.brief_prose ?? true,
    attention_delivery: Object.fromEntries(
      ATTENTION_KINDS.map((kind) => [
        kind,
        config.attention_delivery?.[kind] ?? DEFAULT_ATTENTION_DELIVERY[kind],
      ]),
    ) as AppSettings['attention_delivery'],
    ...(config.quiet_hours && { quiet_hours: config.quiet_hours }),
  };
}
