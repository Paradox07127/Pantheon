import { inputSchemas, type AppSettings } from '@pantheon/protocol';
import { userOnly, type ControlContext, type Handlers } from './context.js';
import { readUserConfig, userConfigDirectory, writeUserConfig } from './user-config.js';

export const appSettingsHandlers: Handlers = {
  'app.settings.set': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['app.settings.set'].parse(c.input);
    writeUserConfig(userConfigDirectory(ctx), input);
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
  };
}
