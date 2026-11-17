import { expect, it } from 'vitest';
import type { Principal, Session } from '@pantheon/domain';
import { command, type CommandType } from '@pantheon/protocol';
import { user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

const css = '[data-debug-region="sidebar"]{width:240px}\n@media (max-width:600px){main{gap:0}}';

function styles() {
  const f = workbenchFixture();
  const sessionOf = (purpose?: 'app_debug'): Principal => {
    const session = f.call<Session>('session.create', {
      project_id: f.project.id,
      runtime: f.adapter.name,
      input: 'Make the sidebar narrower',
      ...(purpose ? { purpose } : {}),
    });
    return {
      id: `session:${session.id}`,
      role: 'lead',
      project_id: f.project.id,
      session_id: session.id,
      expires_at: f.store.now() + 60_000,
    };
  };
  const run = <T = unknown>(type: CommandType, input: Record<string, unknown>, actor = user): T =>
    f.control.execute(actor, command(actor.id, type, input)) as T;
  const changes = () =>
    f.store.db
      .prepare("SELECT payload FROM events WHERE kind='style.changed' ORDER BY sequence")
      .all()
      .map((row) => JSON.parse((row as { payload: string }).payload) as unknown);
  return { f, sessionOf, run, changes, read: () => f.control.styleRead(user) };
}

it('reads an empty stylesheet that is on before the first change', () => {
  const s = styles();
  expect(s.read()).toEqual({ css: '', enabled: true, rules: 0, revision: 0 });
  expect(s.run('style.read', {})).toEqual(s.read());
});

it('stores the stylesheet the user sets, counts its rules and announces the change', () => {
  const s = styles();
  const receipt = s.run('style.set', { css });
  expect(receipt).toEqual({ css, enabled: true, rules: 3, revision: 1 });
  expect(s.read()).toEqual(receipt);
  expect(s.changes()).toEqual([{ revision: 1, enabled: true, rules: 3 }]);
});

it('lets an app debug session set the stylesheet and names it in the change', () => {
  const s = styles();
  const debug = s.sessionOf('app_debug');
  s.run('style.set', { css }, debug);
  expect(s.run('style.read', {}, debug)).toEqual({ css, enabled: true, rules: 3, revision: 1 });
  expect(s.changes()).toEqual([
    { revision: 1, enabled: true, rules: 3, by_session_id: debug.session_id },
  ]);
  for (const type of ['style.enable', 'style.clear'] as const)
    expect(() => s.run(type, { enabled: false }, debug), type).toThrow(
      expect.objectContaining({ code: 'permission_denied' }),
    );
  expect(() => s.run('style.set', { css: '' }, s.sessionOf())).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
  expect(s.read().css).toBe(css);
});

it('refuses a stylesheet that imports or loads from outside and keeps the stored one', () => {
  const s = styles();
  s.run('style.set', { css });
  for (const refused of [
    '@import "https://example.com/theme.css";',
    'body{background:url(https://example.com/a.png)}',
    "body{background:url('http://example.com/a.png')}",
  ])
    expect(() => s.run('style.set', { css: refused }), refused).toThrow();
  expect(s.read()).toMatchObject({ css, revision: 1 });
  const inline = 'body{background:url(data:image/png;base64,iVBORw0KGgo=)}';
  expect(s.run('style.set', { css: inline })).toMatchObject({ css: inline, revision: 2 });
});

it('turns the stylesheet off and on keeping its CSS, and clears it', () => {
  const s = styles();
  s.run('style.set', { css });
  expect(s.run('style.enable', { enabled: false })).toEqual({
    css,
    enabled: false,
    rules: 3,
    revision: 2,
  });
  expect(s.run('style.clear', {})).toEqual({ css: '', enabled: false, rules: 0, revision: 3 });
  expect(s.run('style.enable', { enabled: true })).toEqual({
    css: '',
    enabled: true,
    rules: 0,
    revision: 4,
  });
  expect(s.changes()).toEqual([
    { revision: 1, enabled: true, rules: 3 },
    { revision: 2, enabled: false, rules: 3 },
    { revision: 3, enabled: false, rules: 0 },
    { revision: 4, enabled: true, rules: 0 },
  ]);
});

it('keeps the stylesheet when control restarts', async () => {
  const s = styles();
  s.run('style.set', { css });
  s.run('style.enable', { enabled: false });
  await s.f.restart();
  expect(s.f.control.styleRead(user)).toEqual({ css, enabled: false, rules: 3, revision: 2 });
});
