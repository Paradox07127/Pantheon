import { id, requireThat, type PersonalKey, type Principal } from '@pantheon/domain';
import { inputSchemas } from '@pantheon/protocol';
import { userOnly, type ControlContext, type Handlers } from './context.js';

/** Every personal agent key in creation order, without its digest. */
export function personalKeyList(
  ctx: ControlContext,
  principal: Principal,
): Pick<PersonalKey, 'id' | 'label' | 'created_at' | 'revoked_at'>[] {
  userOnly(principal);
  return ctx.store
    .list<PersonalKey>('personal_keys')
    .map(({ digest: _, revision: __, ...listed }) => listed);
}

export const personalKeyHandlers: Handlers = {
  'personal.key.create': (ctx, p, c) => {
    const input = inputSchemas['personal.key.create'].parse(c.input);
    requireThat(
      ctx.issuePersonalKey,
      'daemon_unavailable',
      'Personal keys are issued by the daemon',
    );
    const keyId = id(),
      issued = ctx.issuePersonalKey(keyId);
    // The token file and its principal live outside the transaction.
    ctx.rollback?.push(() => ctx.discardPersonalKey?.(keyId));
    const key = ctx.store.insert<PersonalKey>('personal_keys', {
      id: keyId,
      revision: 1,
      label: input.label,
      digest: issued.digest,
      created_at: ctx.store.now(),
    });
    ctx.store.event('personal_key.created', key, '', { label: key.label }, c.command_id);
    return { key_id: keyId, token_file: issued.token_file };
  },
  'personal.key.revoke': (ctx, p, c) => {
    const input = inputSchemas['personal.key.revoke'].parse(c.input),
      key = ctx.store.must<PersonalKey>('personal_keys', input.key_id);
    requireThat(key.revoked_at === undefined, 'invalid_state', 'The key is revoked already');
    const revoked = ctx.store.update(
      'personal_keys',
      { ...key, revoked_at: ctx.store.now() },
      key.revision,
    );
    ctx.store.event('personal_key.revoked', revoked, '', {}, c.command_id);
    ctx.rollback?.push(() => ctx.restorePersonalKey?.(key.id, key.digest));
    ctx.revokePersonalKey?.(key.id);
    return { key_id: key.id, revoked_at: revoked.revoked_at };
  },
};
