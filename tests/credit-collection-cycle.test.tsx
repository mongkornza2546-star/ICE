import { describe, expect, it } from 'vitest';
import { formatCreditCollectionCycle } from '../src/lib/creditCollectionCycle';

describe('credit collection cycle labels', () => {
  it('formats weekly, month-end, and net-day cycles in Thai', () => {
    expect(formatCreditCollectionCycle({
      credit_due_rule: 'weekly', credit_days: null, credit_collection_weekday: 5,
    })).toBe('รอบเก็บเงิน: ทุกวันศุกร์');
    expect(formatCreditCollectionCycle({
      credit_due_rule: 'end_of_month', credit_days: null, credit_collection_weekday: null,
    })).toBe('รอบเก็บเงิน: ทุกสิ้นเดือน');
    expect(formatCreditCollectionCycle({
      credit_due_rule: 'net_days', credit_days: 30, credit_collection_weekday: null,
    })).toBe('รอบเก็บเงิน: หลังส่งสินค้า 30 วัน');
  });
});
