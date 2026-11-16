import { expect, it, vi } from 'vitest';
import { nodes, text } from './web-hook-host.js';
import { LoadError } from '@/components/LoadError';

const buttons = (tree: ReturnType<typeof LoadError>) =>
  nodes(tree).filter((n) => n.type === 'button');

it('says what failed to load in an alert and retries with a button named retry', () => {
  const onRetry = vi.fn();
  const tree = LoadError({ message: 'Could not read the plan', onRetry });
  expect(tree.props.role).toBe('alert');
  expect(text(tree)).toContain('Could not read the plan');
  const retry = buttons(tree)[0]!;
  expect(text(retry)).toBe('重试');
  retry.props.onClick();
  expect(onRetry).toHaveBeenCalledTimes(1);
});

it('offers no retry button when nothing can be retried', () => {
  const tree = LoadError({ message: 'Could not read the plan' });
  expect(tree.props.role).toBe('alert');
  expect(text(tree)).toBe('Could not read the plan');
  expect(buttons(tree)).toEqual([]);
});
