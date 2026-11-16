import { constants, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { requireThat } from '@pantheon/domain';

export const artifactLimit = 8 * 1024 * 1024;
export const textLimit = 1024 * 1024;
const flags = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;

export function readBoundedSync(file: string, limit = artifactLimit): Buffer {
  const fd = openSync(file, flags);
  try {
    const stat = fstatSync(fd);
    requireThat(stat.isFile(), 'invalid_file', 'Input must be a regular file');
    requireThat(stat.size <= limit, 'file_too_large', `Input exceeds ${limit} bytes`);
    const bytes = Buffer.alloc(Math.min(stat.size, limit) + 1);
    let length = 0,
      count: number;
    while (
      length < bytes.length &&
      (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0
    )
      length += count;
    requireThat(length <= stat.size, 'file_too_large', 'Input grew while being read');
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}
