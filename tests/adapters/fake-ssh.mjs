// Stands in for `ssh host <script>` without a terminal: the script runs in its own session outside
// this process tree and is reached only through pipes, so ending this process sends it no signal.
// Arguments: a directory for the pipes, optionally a delay in ms for its standard error, then the script.
import { spawn, execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';

const pipes = ['in', 'out', 'err'].map((name) => path.join(process.argv[2], name));
execFileSync('mkfifo', pipes);
// The relay exits at once, so the script's shell is no descendant of this process.
spawn(
  process.execPath,
  [
    '-e',
    `require('node:child_process').spawn('/bin/sh', ['-c', 'exec <"$1" >"$2" 2>"$3"; exec /bin/sh -c "$4"', 'sh', ...process.argv.slice(1)], { detached: true, stdio: 'ignore' }).unref()`,
    ...pipes,
    process.argv.at(-1),
  ],
  { stdio: 'ignore' },
);
process.stdin.pipe(createWriteStream(pipes[0]));
const stderr = createReadStream(pipes[2]);
setTimeout(
  () => stderr.pipe(process.stderr),
  process.argv.length > 4 ? Number(process.argv[3]) : 0,
);
createReadStream(pipes[1])
  .on('end', () => process.exit(0))
  .pipe(process.stdout);
