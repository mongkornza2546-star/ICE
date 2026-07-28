import { describe, expect, it } from 'vitest';
import {
  clearRecoveryForOwner,
  readRecovery,
  recoveryKey,
  writeRecovery,
} from '../src/lib/recoveryStorage';

describe('recovery storage', () => {
  it('keeps a draft isolated to its owner, date, and workspace mode', () => {
    writeRecovery('courier-1', '2026-07-28', 'pos', { shopId: 'shop-1' });

    expect(readRecovery<{ shopId: string }>('courier-1', '2026-07-28', 'pos')?.payload).toEqual({ shopId: 'shop-1' });
    expect(readRecovery('courier-2', '2026-07-28', 'pos')).toBeNull();
    expect(readRecovery('courier-1', '2026-07-29', 'pos')).toBeNull();
    expect(readRecovery('courier-1', '2026-07-28', 'withdrawal')).toBeNull();
  });

  it('expires drafts older than 48 hours', () => {
    window.localStorage.setItem(recoveryKey('courier-1', '2026-07-28', 'pos'), JSON.stringify({
      version: 1,
      ownerId: 'courier-1',
      serviceDate: '2026-07-28',
      savedAt: '2020-01-01T00:00:00.000Z',
      payload: { shopId: 'shop-1' },
    }));

    expect(readRecovery('courier-1', '2026-07-28', 'pos')).toBeNull();
  });

  it('clears all workspace drafts when the owner signs out', () => {
    writeRecovery('courier-1', '2026-07-28', 'pos', { shopId: 'shop-1' });
    writeRecovery('courier-1', '2026-07-28', 'withdrawal', { roundId: 'round-1' });
    writeRecovery('courier-2', '2026-07-28', 'pos', { shopId: 'shop-2' });

    clearRecoveryForOwner('courier-1');

    expect(readRecovery('courier-1', '2026-07-28', 'pos')).toBeNull();
    expect(readRecovery('courier-1', '2026-07-28', 'withdrawal')).toBeNull();
    expect(readRecovery('courier-2', '2026-07-28', 'pos')?.payload).toEqual({ shopId: 'shop-2' });
  });
});
