// Compiles the built-in voice engine into apps/desktop/stage/voice/pantheon-voice; does nothing off macOS.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'darwin') {
  const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const output = path.join(desktop, 'stage/voice');
  mkdirSync(output, { recursive: true });
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  execFileSync(
    'xcrun',
    [
      'swiftc',
      '-O',
      '-target',
      `${arch}-apple-macos26.0`,
      path.join(desktop, 'native/voice/main.swift'),
      '-o',
      path.join(output, 'pantheon-voice'),
    ],
    { stdio: 'inherit' },
  );
}
