import { randomBytes } from 'node:crypto';

export function newRunId(): string {
  return `run_${randomBytes(6).toString('hex')}`;
}
