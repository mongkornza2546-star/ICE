import { describe, expect, it } from 'vitest';
import { getCreditAccountStatus } from '../src/features/financial-operations/components/CreditReceivablesManager';
import type { Receivable } from '../src/features/financial-operations/types';

const base: Receivable = {
  shop_id: 'shop-1',
  shop_code: 'S001',
  shop_name: 'ร้านทดสอบ',
  credit_limit: 1_000,
  available_credit_amount: 1_000,
  outstanding_amount: 0,
  overdue_amount: 0,
  oldest_due_date: null,
  charges: [],
};

describe('credit account status priority', () => {
  it('uses the required priority from suspended through normal', () => {
    expect(getCreditAccountStatus({ ...base })).toBe('normal');
    expect(getCreditAccountStatus({ ...base, outstanding_amount: 800 })).toBe('near_limit');
    expect(getCreditAccountStatus({ ...base, outstanding_amount: 1_000 })).toBe('at_limit');
    expect(getCreditAccountStatus({ ...base, outstanding_amount: 900, overdue_amount: 100 })).toBe('overdue');
    expect(getCreditAccountStatus({ ...base, outstanding_amount: 1_100, overdue_amount: 100 })).toBe('over_limit');
    expect(getCreditAccountStatus({ ...base, outstanding_amount: 1_100, overdue_amount: 100, credit_suspended: true })).toBe('suspended');
  });

  it('never marks an unlimited account as near or over its limit', () => {
    expect(getCreditAccountStatus({ ...base, credit_limit: null, available_credit_amount: null, outstanding_amount: 9_999 })).toBe('normal');
  });
});
