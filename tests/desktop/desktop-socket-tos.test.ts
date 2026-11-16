import { describe, expect, it } from 'vitest';
import { ignoreTypeOfServiceEinval } from '../../apps/desktop/src/main/socket-tos.js';

function fakeProto(code: string) {
  let calls = 0;
  const proto = {
    setTypeOfService(_tos: number): unknown {
      calls += 1;
      throw Object.assign(new Error(`setTypeOfService ${code}`), {
        code,
        syscall: 'setTypeOfService',
      });
    },
  };
  return { proto, calls: () => calls };
}

describe('socket type-of-service guard', () => {
  it('swallows EINVAL from setTypeOfService and returns the receiver', () => {
    const { proto } = fakeProto('EINVAL');
    ignoreTypeOfServiceEinval(proto);
    const socket = Object.create(proto) as typeof proto;
    expect(() => socket.setTypeOfService(0)).not.toThrow();
    expect(socket.setTypeOfService(0)).toBe(socket);
  });

  it('rethrows other setTypeOfService errors unchanged', () => {
    const { proto } = fakeProto('EBADF');
    ignoreTypeOfServiceEinval(proto);
    expect(() => proto.setTypeOfService(0)).toThrow(expect.objectContaining({ code: 'EBADF' }));
  });

  it('wraps only once when applied twice', () => {
    const { proto, calls } = fakeProto('EINVAL');
    ignoreTypeOfServiceEinval(proto);
    const wrapped = proto.setTypeOfService;
    ignoreTypeOfServiceEinval(proto);
    expect(proto.setTypeOfService).toBe(wrapped);
    proto.setTypeOfService(0);
    expect(calls()).toBe(1);
  });

  it('leaves a prototype without setTypeOfService alone', () => {
    const proto: { setTypeOfService?: (tos: number) => unknown } = {};
    ignoreTypeOfServiceEinval(proto);
    expect(proto).toEqual({});
  });
});
