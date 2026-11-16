import { afterEach, expect, it, vi } from 'vitest';
import { type HookHost, mount as host, nodes, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
import { Collapsible } from '../../apps/web/node_modules/@base-ui/react/collapsible/index.mjs';
import type { RequestItem } from '@/data/transcript';
import type { PendingPermission } from '@/screens/sessions/model';
import { AnsweredRequest } from '@/screens/sessions/parts';
import { RequestSlot } from '@/screens/sessions/SessionsScreen';

const needs = { items: [], loading: false, error: null, reload: () => {} };
const waiting: RequestItem = {
  kind: 'request',
  id: 'req-1',
  tool: 'Bash',
  input: {},
  questions: [],
};
const permission: PendingPermission = {
  id: 'approval-1',
  tool: 'Bash',
  revision: 1,
  request: 'req-1',
};

let props: { item: RequestItem; permission?: PendingPermission };
afterEach(() => unmountAll());

const mount = () => host(() => RequestSlot({ ...props, needs, folders: [], enter: '' }));
const count = (h: HookHost<any>, type: unknown) => nodes(h.value).filter((n) => n.type === type);
// The card element: whatever renders the permission inside the folding panel.
const cards = (h: HookHost<any>) =>
  nodes(h.value).filter((n) => n.props?.permission?.id === permission.id);

it('folds the waiting card into a single result row when the request is answered', () => {
  props = { item: waiting, permission };
  const h = mount();
  expect(cards(h)).toHaveLength(1);
  expect(count(h, AnsweredRequest)).toHaveLength(0);
  expect(count(h, Collapsible.Root)[0]!.props.open).toBe(true);

  props = { item: { ...waiting, outcome: 'approve' } };
  h.render();
  expect(count(h, AnsweredRequest)).toHaveLength(1);
  // The card stays mounted closed so its panel can fold away.
  expect(count(h, Collapsible.Root)[0]!.props.open).toBe(false);
  expect(cards(h)).toHaveLength(1);
});

it('shows only the result row of a request answered before the slot mounted', () => {
  props = { item: { ...waiting, outcome: 'reject' } };
  const h = mount();
  expect(count(h, AnsweredRequest)).toHaveLength(1);
  expect(cards(h)).toHaveLength(0);
  expect(count(h, Collapsible.Root)).toHaveLength(0);
});

it('gives an approval that replaces another under the same request a card of its own', () => {
  props = { item: waiting, permission };
  const h = mount();
  const first = cards(h)[0]!;
  const replacement = { ...permission, id: 'approval-2', revision: 2 };
  props = { item: waiting, permission: replacement };
  h.render();
  const second = nodes(h.value).find((n) => n.props?.permission?.id === 'approval-2')!;
  expect(second.type).toBe(first.type);
  expect(second.key).not.toBe(first.key);
});
