import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@pantheon/domain';
import { command } from '@pantheon/protocol';
import {
  AGENT_SCOPE,
  OUTSIDE_PERSONAL_SCOPE,
  PERSONAL_COMMANDS,
  PERSONAL_QUERIES,
  agentScopeMarkdown,
  personalQuery,
} from '@pantheon/control';
import { fixture } from '../helpers.js';

const personal: Principal = { id: 'personal:k1', role: 'personal' };
const outside = expect.objectContaining({
  code: 'permission_denied',
  message: OUTSIDE_PERSONAL_SCOPE,
});
const listed: readonly string[] = [...PERSONAL_QUERIES, ...PERSONAL_COMMANDS];
const actions = AGENT_SCOPE.flatMap((row) => row.personal_actions);

it.each(listed)('puts %s of the personal lists in exactly one scope row', (action) => {
  expect(actions.filter((entry) => entry === action)).toEqual([action]);
});

it('lists in the scope table only actions on the personal lists', () => {
  expect(actions.filter((action) => !listed.includes(action))).toEqual([]);
});

describe('the commands the scope table keeps from a personal principal', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    f = await fixture();
  });
  afterAll(() => f.close());

  it.each(AGENT_SCOPE.flatMap((row) => row.never_personal))(
    'refuses %s from a personal principal',
    (type) => {
      expect(() => f.control.execute(personal, command(personal.id, type, {}))).toThrow(outside);
    },
  );
});

it.each(['board.view', 'agent.list'])('refuses the %s query to a personal principal', (method) => {
  expect(() => personalQuery(personal, method)).toThrow(outside);
});

it('keeps the scope table in docs/architecture.md equal to the one in code', () => {
  const doc = readFileSync(
    fileURLToPath(new URL('../../docs/architecture.md', import.meta.url)),
    'utf8',
  );
  const block = /<!-- agent-scope:start -->\n([\s\S]*?)\n<!-- agent-scope:end -->/.exec(doc)?.[1];
  expect(block, `Paste between the agent-scope markers:\n${agentScopeMarkdown()}`).toBe(
    agentScopeMarkdown(),
  );
});
