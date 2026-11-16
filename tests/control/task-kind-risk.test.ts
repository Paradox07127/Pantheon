import { expect, it } from 'vitest';
import { kindOfPaths } from '../../packages/control/dist/task-kind.js';

it.each([
  'migrations/add-column.sql',
  'src/authentication.ts',
  'src/auth/session.ts',
  'src/concurrency.ts',
  'src/public-api.ts',
  'src/secrets.ts',
  'src/迁移.ts',
  'src/认证.ts',
  'src/并发.ts',
  'src/公开API.ts',
  'src/密钥.ts',
])('rates the risky scope %s at least t3', (file) => {
  expect(kindOfPaths([file])?.tier).toBe('t3');
  expect(kindOfPaths(['src/author.ts', 'src/secretary.ts'])?.tier).toBe('t1');
});
