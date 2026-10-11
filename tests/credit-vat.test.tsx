import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { deliverySubtotal, exclusiveVat } from '../src/lib/vat';
import { printBillingStatement } from '../src/lib/billingStatementPrint';
import { printSalesDocument, salesDocumentFromStored } from '../src/lib/salesDocumentPrint';
import { BillingStatementsSection } from '../src/features/financial-operations/components/BillingStatementsSection';
import { VatBreakdown } from '../src/features/financial-operations/components/VatBreakdown';
import type { BillingStatement, ReceivableCharge } from '../src/features/financial-operations/types';
import type { ShopPaymentProfile } from '../src/types/app';
import { paymentProfileFingerprintValue } from '../src/offline/fingerprints';
import { validateOfflineCommand, validateOfflineSyncResponse } from '../src/offline/contracts';
import fixtures from '../contracts/employee-offline-v1.fixtures.json';

function printWindow() {
  return { document: document.implementation.createHTMLDocument(), addEventListener: vi.fn(), focus: vi.fn(), print: vi.fn(), close: vi.fn() } as unknown as Window;
}
const statement: BillingStatement = {
  id: 's', statement_number: 'BIL2610-00001', shop_id: 'shop', shop_code: 'S1', shop_name: 'ร้าน VAT', shop_location: null,
  status: 'active', issued_service_date: '2026-10-11', issued_at: '2026-10-11T04:00:00Z', created_by_name: 'Admin', voided_at: null, void_reason: null,
  subtotal_amount: 1000, vat_amount: 70, gross_amount: 1070, total_amount: 570, outstanding_amount: 470,
  items: [{ charge_id: 'c', charge_number: 'INV2610-00001', service_date: '2026-10-11', due_date: '2026-10-11', billed_amount: 570, outstanding_amount: 470 }],
};

describe('exclusive credit VAT', () => {
  it('rounds VAT once per bill, preserves non-VAT totals and handles fractional baht', () => {
    expect(exclusiveVat(1000)).toEqual({ subtotal: 1000, vat: 70, total: 1070 });
    expect(exclusiveVat(12.5)).toEqual({ subtotal: 12.5, vat: .88, total: 13.38 });
    expect(exclusiveVat(1000, 0)).toEqual({ subtotal: 1000, vat: 0, total: 1000 });
    expect(exclusiveVat(.15)).toEqual({ subtotal: .15, vat: .01, total: .16 });
    expect(deliverySubtotal([{ ice_type_id: 'ice', quantity: .5 }], [{ ice_type_id: 'ice', unit_price: 2.01 }])).toBe(1.01);
    expect(exclusiveVat(deliverySubtotal([{ ice_type_id: 'ice', quantity: .5 }], [{ ice_type_id: 'ice', unit_price: 2.01 }])).total).toBe(1.08);
  });
  it('shows the full tax and separates money already received', () => {
    render(<VatBreakdown subtotal={1000} vat={70} total={1070} rate={7} paid={500} />);
    const text = screen.getByLabelText('รายละเอียด VAT').textContent;
    expect(text).toContain('VAT 7%');
    expect(text).toContain('70.00');
    expect(text).toContain('570.00');
  });
  it('prints full VAT, payments before statement issue, and payments after issue without taxing the balance again', () => {
    const target = printWindow();
    printBillingStatement(statement, target);
    const text = target.document.body.textContent;
    expect(text).toContain('ค่าสินค้าก่อน VAT: ฿1,000.00');
    expect(text).toContain('VAT: ฿70.00');
    expect(text).toContain('ชำระก่อนออกใบวางบิล: ฿500.00');
    expect(text).toContain('ยอดวางบิล฿570.00');
    expect(text).toContain('ชำระหลังออกใบวางบิล: ฿100.00');
    expect(text).toContain('คงเหลือ: ฿470.00');
  });
  it('prints the immutable invoice breakdown', () => {
    const target = printWindow();
    const payload = salesDocumentFromStored({ ...fixtures.results.delivery.print_document,
      subtotal_amount: 233.75, vat_rate: 7, vat_amount: 16.36, total_amount: 250.11, document_type: 'INV', payment_term: 'credit', status: 'active',
    });
    printSalesDocument(payload, target);
    expect(target.document.body.textContent).toContain('ค่าสินค้าก่อน VAT ฿233.75');
    expect(target.document.body.textContent).toContain('VAT 7% ฿16.36');
    expect(target.document.body.textContent).toContain('฿250.11');
  });
  it('previews a mixed statement using full bill snapshots and outstanding totals', () => {
    const charge: ReceivableCharge = { charge_id: 'c', charge_number: 'INV1', service_date: '2026-10-11', due_date: '2026-10-11',
      subtotal_amount: 1000, vat_rate: 7, vat_amount: 70, original_amount: 1070, allocated_amount: 500, outstanding_amount: 570,
      assigned_collection_run_id: null, days_overdue: 0, payment_status: 'partial', due_status: 'due_today' };
    render(<BillingStatementsSection busy={false} charges={[charge, { ...charge, charge_id: 'old', vat_rate: 0, vat_amount: 0, subtotal_amount: 100, original_amount: 100, allocated_amount: 0, outstanding_amount: 100 }]} statements={[]} serviceDate="2026-10-11" onCreate={vi.fn()} onVoid={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'ออกใบวางบิล' }));
    const text = screen.getByLabelText('รายละเอียด VAT').textContent;
    expect(text).toContain('1,100.00');
    expect(text).toContain('70.00');
    expect(text).toContain('670.00');
  });
  it('changes the offline policy fingerprint only for enabled VAT', () => {
    const profile = fixtures.fingerprints.find(f => f.name === 'payment_profile')!.input as ShopPaymentProfile;
    expect(paymentProfileFingerprintValue({ ...profile, vat_enabled: false })).toEqual(paymentProfileFingerprintValue(profile));
    expect(paymentProfileFingerprintValue({ ...profile, vat_enabled: true })).not.toEqual(paymentProfileFingerprintValue(profile));
  });
  it('validates queued VAT totals, rejects missing tax snapshots and prevents VAT on non-credit sales', () => {
    const command = structuredClone(fixtures.commands.find(c => c.type === 'delivery')!);
    const vatCommand = { ...command, payload: { ...command.payload, expectedVatRate: 7, expectedTotal: 250.11 } };
    expect(validateOfflineCommand(vatCommand).valid).toBe(true);
    expect(validateOfflineCommand({ ...vatCommand, payload: { ...vatCommand.payload, expectedTotal: 233.75 } }).valid).toBe(false);
    expect(validateOfflineCommand({ ...vatCommand, payload: { ...vatCommand.payload, paymentTerm: 'end_of_day' } }).valid).toBe(false);
    expect(validateOfflineCommand({ ...command, payload: { ...command.payload, expectedTotal: 250.11 } }).valid).toBe(false);
  });
  it('validates server VAT against invoice line items and the returned invoice snapshot', () => {
    const result = { ...structuredClone(fixtures.results.delivery), subtotal_amount: 233.75, vat_amount: 16.36, vat_rate: 7, total_amount: 250.11 };
    result.print_document = { ...result.print_document, ...{ subtotal_amount: 233.75, vat_amount: 16.36, vat_rate: 7, total_amount: 250.11 } };
    const response = { command_id: fixtures.commands[3].commandId, status: 'applied', result, resolution_version: 1 };
    expect(validateOfflineSyncResponse('delivery', response).valid).toBe(true);
    expect(validateOfflineSyncResponse('delivery', { ...response, result: { ...result, vat_amount: 16.35 } }).valid).toBe(false);
  });
});
