import { describe, expect, it } from 'vitest';
import { formatCreditCollectionCycle } from '../src/lib/creditCollectionCycle';

describe('semi-monthly credit collection cycle', () => {
  it('describes the two calendar cutoffs clearly', () => {
    expect(formatCreditCollectionCycle({ credit_due_rule: 'semi_monthly' }))
      .toBe('รอบเก็บเงิน: รอบครึ่งเดือน (วันที่ 1–15 / 16–สิ้นเดือน)');
  });
});
