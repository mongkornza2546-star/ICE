import { expect, it } from 'vitest';
import { parseBoothRanges } from '../src/features/event-management/boothRanges';

it('expands the 300-booth example and preserves padded codes', () => {
  expect(parseBoothRanges('A1 ถึง 250\nF1-F40\nT1–T10').booths).toHaveLength(300);
  expect(parseBoothRanges('a01-a03, A02').booths).toEqual(['A01', 'A02', 'A03']);
});
it.each(['A250-1', 'A1-B40', 'A0-10', 'A1-1000000000', 'A1-1000 F1-1', 'A1.5', 'A9007199254740993'])('rejects unsafe range %s', (input) => {
  expect(parseBoothRanges(input).error).toBeTruthy();
  expect(parseBoothRanges(input).booths).toEqual([]);
});
it('allows empty input and single booths', () => {
  expect(parseBoothRanges('')).toEqual({ booths: [], error: null });
  expect(parseBoothRanges('A1 F1 T1').booths).toEqual(['A1', 'F1', 'T1']);
});
