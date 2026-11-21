import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { command, commandSchema, inputSchemas, USER_PRINCIPAL_ID } from '@pantheon/protocol';
import {
  addRow,
  checkGate,
  DEFAULT_TIMEOUT_SECONDS,
  gateSetRequest,
  joinArgv,
  knownGitFolder,
  moveRow,
  removeRow,
  rowsOf,
  savedGate,
  splitArgv,
  type GateCommand,
  type GateRow,
} from '@/screens/settings/gate';

const saved: GateCommand[] = [
  { name: 'typecheck', argv: ['pnpm', 'exec', 'tsc', '-b'] },
  {
    name: 'unit tests',
    argv: ['pnpm', 'exec', 'vitest', 'run', 'tests/a b.test.ts'],
    timeout_ms: 300000,
  },
];

const row = (name: string, line: string, timeout = '', id = 0): GateRow => ({
  id,
  name,
  line,
  timeout,
  enabled: true,
  skippable: false,
});

describe('splitting a command line', () => {
  it.each([
    ['splits on any whitespace', '  pnpm\texec   tsc -b ', ['pnpm', 'exec', 'tsc', '-b']],
    [
      'keeps single-quoted text as written',
      `echo 'a  b' 'x\\"y' ''`,
      ['echo', 'a  b', 'x\\"y', ''],
    ],
    [
      'reads only \\" and \\\\ as escapes inside double quotes',
      String.raw`node -e "say \"hi\" \\ \n"`,
      ['node', '-e', String.raw`say "hi" \ \n`],
    ],
    [
      'takes the next character literally after a backslash outside quotes',
      String.raw`ls a\ b \'c\"`,
      ['ls', 'a b', `'c"`],
    ],
    ['joins quoted and bare parts of one word', `--name='a b'"c d"e`, ['--name=a bc de']],
    [
      'passes pipes, redirects, variables and globs on as plain arguments',
      'cat log | grep x > out $HOME *.ts && echo ~',
      ['cat', 'log', '|', 'grep', 'x', '>', 'out', '$HOME', '*.ts', '&&', 'echo', '~'],
    ],
  ])('%s', (_name, line, argv) => {
    expect(splitArgv(line)).toEqual({ ok: true, argv });
  });

  it('refuses an unclosed quote', () => {
    expect(splitArgv(`echo 'open`).ok).toBe(false);
    expect(splitArgv(`echo "open \\"`).ok).toBe(false);
  });

  it('writes saved arguments back as a line that splits into the same arguments', () => {
    const argv = ['node', '-e', `console.log("it's")`, '', 'a\\b', 'plain', '$HOME'];
    expect(splitArgv(joinArgv(argv))).toEqual({ ok: true, argv });
    expect(joinArgv(['pnpm', 'exec', 'tsc'])).toBe('pnpm exec tsc');
  });
});

describe('checking the draft', () => {
  it('reports an empty name, an empty command line and a timeout that is not whole positive milliseconds', () => {
    const check = checkGate(saved, [
      row(' ', 'pnpm test'),
      row('lint', '   '),
      row('zero', 'true', '0'),
      row('fraction', 'true', '1.0005'),
      row('negative', 'true', '-3'),
      row('word', 'true', 'ten'),
      row('quote', `echo 'open`),
    ]);
    expect(check.status).toBe('invalid');
    expect(check.commands).toBeNull();
    expect(check.rows.map((r) => r.errors.length > 0)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(check.rows[1]!.argv).toEqual([]);
    expect(check.rows[6]!.argv).toBeNull();
  });

  it('refuses arguments and names the protocol refuses', () => {
    const long = 'x'.repeat(65537);
    const check = checkGate(
      [],
      [
        row('empty argument', `printf '%s' ''`),
        row('nul byte', "printf 'a\0b'"),
        row('long argument', `echo ${long}`),
        row(long, 'true'),
      ],
    );
    expect(check.status).toBe('invalid');
    expect(check.rows.map((r) => r.errors.length > 0)).toEqual([true, true, true, true]);
  });

  it('keeps a saved timeout of whole milliseconds that are not whole seconds', () => {
    const exact: GateCommand[] = [{ name: 'quick', argv: ['true'], timeout_ms: 1500 }];
    expect(checkGate(exact, rowsOf(exact)).status).toBe('unchanged');
    const renamed = checkGate(exact, [{ ...rowsOf(exact)[0]!, name: 'quick check' }]);
    expect(renamed.status).toBe('ready');
    expect(renamed.commands).toEqual([{ name: 'quick check', argv: ['true'], timeout_ms: 1500 }]);
  });

  it('can save once every row is valid and something changed', () => {
    const check = checkGate(saved, [
      row(' build ', 'pnpm build', ''),
      row('tests', `vitest run 'a b'`, '90'),
    ]);
    expect(check.status).toBe('ready');
    expect(check.rows.every((r) => r.errors.length === 0)).toBe(true);
    expect(check.commands).toEqual([
      { name: 'build', argv: ['pnpm', 'build'] },
      { name: 'tests', argv: ['vitest', 'run', 'a b'], timeout_ms: 90000 },
    ]);
  });

  it('has nothing to save when the draft matches the saved gate', () => {
    expect(checkGate(saved, rowsOf(saved)).status).toBe('unchanged');
    expect(checkGate([], []).status).toBe('unchanged');
    expect(checkGate(saved, moveRow(moveRow(rowsOf(saved), 0, 1), 1, -1)).status).toBe('unchanged');
  });

  it('counts a reorder, a removal and clearing as changes', () => {
    expect(checkGate(saved, moveRow(rowsOf(saved), 0, 1)).status).toBe('ready');
    expect(checkGate(saved, removeRow(rowsOf(saved), 1)).status).toBe('ready');
    const cleared = checkGate(saved, []);
    expect(cleared.status).toBe('ready');
    expect(cleared.commands).toEqual([]);
  });

  it('adds empty rows with their own keys and keeps moves inside the list', () => {
    const rows = addRow(addRow(rowsOf(saved)));
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.id)).size).toBe(4);
    expect(rows[3]).toMatchObject({ name: '', line: '', timeout: '' });
    expect(moveRow(rows, 0, -1)).toBe(rows);
    expect(moveRow(rows, 3, 1)).toBe(rows);
    expect(rowsOf(saved)[1]).toMatchObject({ timeout: '300' });
  });

  it('shows the timeout the landing step applies to a command without one', () => {
    const landing = readFileSync(
      new URL('../../packages/control/src/landing.ts', import.meta.url),
      'utf8',
    );
    const applied = /timeoutMs: command\.timeout_ms \?\? (\d+)/.exec(landing)?.[1];
    expect(Number(applied)).toBe(DEFAULT_TIMEOUT_SECONDS * 1000);
  });
});

describe('per-folder gates', () => {
  const project = {
    roots: ['/work/app', '/work/site', '/work/docs'],
    gates: { '/work/app': saved, '/work/site': [] },
  };

  it('reads each folder its own saved gate', () => {
    expect(savedGate(project, '/work/app')).toBe(saved);
    expect(savedGate(project, '/work/site')).toEqual([]);
    expect(savedGate(project, '/work/docs')).toEqual([]);
    expect(savedGate({}, '/work/app')).toEqual([]);
  });

  it('knows a folder is git from a saved gate or the baseline gate, else leaves it unknown', () => {
    const baseline = {
      result: {
        folders: [
          { root: '/work/docs', gate: [] },
          { root: '/work/other', gate: [{ name: 'build' }] },
        ],
      },
    };
    expect(knownGitFolder(project, null, '/work/app')).toBe(true);
    expect(knownGitFolder(project, null, '/work/site')).toBe(true);
    expect(knownGitFolder(project, baseline, '/work/docs')).toBe(false);
    expect(knownGitFolder({}, baseline, '/work/other')).toBe(true);
    expect(knownGitFolder({}, { state: 'running' } as never, '/work/app')).toBe(false);
  });
});

describe('the save command', () => {
  const project = { id: 'project-1', revision: 7, roots: ['/work/app', '/work/docs'] };

  it('sends the commands for the chosen folder in the shape the protocol takes', () => {
    const check = checkGate([], [row('build', 'pnpm build', '30')]);
    const request = gateSetRequest(project, '/work/docs', check.commands!);
    expect(request).toEqual({
      type: 'project.gate.set',
      input: {
        project_id: 'project-1',
        root: '/work/docs',
        commands: [{ name: 'build', argv: ['pnpm', 'build'], timeout_ms: 30000 }],
      },
      expected_revision: 7,
    });
    const sent = command(USER_PRINCIPAL_ID, request.type, request.input, request.expected_revision);
    expect(commandSchema.parse(sent)).toEqual(sent);
    expect(inputSchemas['project.gate.set'].parse(sent.input)).toEqual(request.input);
  });

  it('sends an empty list to clear the gate', () => {
    const request = gateSetRequest(project, '/work/app', []);
    expect(request.input).toEqual({ project_id: 'project-1', root: '/work/app', commands: [] });
    expect(request.expected_revision).toBe(7);
    expect(inputSchemas['project.gate.set'].parse(request.input)).toEqual(request.input);
  });
});
