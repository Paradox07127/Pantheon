import net from 'node:net';

const wrapped = Symbol('ignoresTypeOfServiceEinval');

export function ignoreTypeOfServiceEinval(proto: {
  setTypeOfService?: (tos: number) => unknown;
}): void {
  const original = proto.setTypeOfService;
  if (!original || (original as { [wrapped]?: true })[wrapped]) return;
  const guarded = function (this: unknown, tos: number): unknown {
    try {
      return original.call(this, tos);
    } catch (error) {
      const { code, syscall } = error as NodeJS.ErrnoException;
      if (code === 'EINVAL' && syscall === 'setTypeOfService') return this;
      throw error;
    }
  };
  Object.assign(guarded, { [wrapped]: true });
  proto.setTypeOfService = guarded;
}

// undici 7 in Node 24 throws this uncaught on macOS when the peer has reset the socket; upstream fix nodejs/undici#5547.
if (process.platform === 'darwin') ignoreTypeOfServiceEinval(net.Socket.prototype);
