// Runs `electron-vite dev --watch`. On macOS it runs a copy of Electron.app named Pantheon, since the
// menu bar and the Dock take the app's name from the bundle, not from the code.
import { execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
if (process.platform === 'darwin') {
  const electron = path.dirname(createRequire(import.meta.url).resolve('electron/package.json'));
  const version = JSON.parse(readFileSync(path.join(electron, 'package.json'), 'utf8')).version;
  const bundle = path.join(desktop, '.dev/Pantheon Dev.app');
  const appVersion = JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8')).version;
  const icon = path.join(desktop, 'build/icon.icns');
  const stamp = path.join(desktop, '.dev/electron-version');
  // A new Electron.app, app version or icon makes the copy again.
  const made = `${version} ${appVersion} ${statSync(icon).mtimeMs}`;
  if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== made) {
    rmSync(bundle, { recursive: true, force: true });
    mkdirSync(path.dirname(bundle), { recursive: true });
    execFileSync('ditto', [path.join(electron, 'dist/Electron.app'), bundle]);
    const plist = path.join(bundle, 'Contents/Info.plist');
    for (const [key, value] of [
      ['CFBundleName', 'Pantheon'],
      ['CFBundleDisplayName', 'Pantheon'],
      ['CFBundleIdentifier', 'dev.pantheon.desktop.dev'],
      // The About panel puts CFBundleVersion in brackets after the version.
      ['CFBundleShortVersionString', appVersion],
      ['CFBundleVersion', appVersion],
    ])
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
    // The About panel and Finder draw the bundle's icon file.
    copyFileSync(icon, path.join(bundle, 'Contents/Resources/electron.icns'));
    // The edited Info.plist breaks the ad-hoc signature, which macOS then refuses to launch.
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle]);
    // macOS caches the icon by bundle path and date, and ditto keeps Electron.app's date.
    utimesSync(bundle, new Date(), new Date());
    execFileSync(
      '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
      ['-f', bundle],
    );
    writeFileSync(stamp, made);
  }
  env.ELECTRON_EXEC_PATH = path.join(bundle, 'Contents/MacOS/Electron');
}
const child = spawn('electron-vite', ['dev', '--watch'], { cwd: desktop, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
