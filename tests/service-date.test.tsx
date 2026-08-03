import { describe, expect, it } from 'vitest';
import { bangkokDayUtcRange, toBangkokDateString } from '../src/lib/serviceDate';

describe('toBangkokDateString', () => {
  it('uses the Bangkok calendar date before 07:00 local time', () => {
    expect(toBangkokDateString(new Date('2026-07-21T18:00:00.000Z'))).toBe('2026-07-22');
  });

  it('keeps the Bangkok date at the end of the local day', () => {
    expect(toBangkokDateString(new Date('2026-07-22T16:59:59.999Z'))).toBe('2026-07-22');
  });
});

describe('bangkokDayUtcRange', () => {
  it('returns the UTC bounds for one complete Bangkok calendar day', () => {
    expect(bangkokDayUtcRange('2026-08-03')).toEqual({
      start: '2026-08-02T17:00:00.000Z',
      end: '2026-08-03T17:00:00.000Z',
    });
  });
});
