import { describe, expect, it } from 'vitest';
import { toBangkokDateString } from '../src/lib/serviceDate';

describe('toBangkokDateString', () => {
  it('uses the Bangkok calendar date before 07:00 local time', () => {
    expect(toBangkokDateString(new Date('2026-07-21T18:00:00.000Z'))).toBe('2026-07-22');
  });

  it('keeps the Bangkok date at the end of the local day', () => {
    expect(toBangkokDateString(new Date('2026-07-22T16:59:59.999Z'))).toBe('2026-07-22');
  });
});
