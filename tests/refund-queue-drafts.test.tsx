import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: client }));
import { RefundQueuePanel } from '../src/features/financial-operations/components/RefundQueuePanel';

it('keeps each refund method and reference attached to its own obligation', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  client.rpc.mockImplementation((name: string) => Promise.resolve({ error: null, data: name === 'get_refund_queue'
    ? ['A', 'B'].map((id) => ({ id, shop_code: id, shop_name: `ร้าน ${id}`, receipt_number: id,
      charge_number: id, amount: 100, status: 'pending', reason: 'แก้ไขบิล', settlement: null }))
    : { gross_received: 200, refunded_amount: 0, net_received: 200 } }));
  render(<RefundQueuePanel />);
  const methods = await screen.findAllByLabelText('วิธีคืนเงิน');
  const references = screen.getAllByLabelText('เลขอ้างอิงการคืนเงิน');
  fireEvent.change(methods[0], { target: { value: 'bank_transfer' } });
  fireEvent.change(references[0], { target: { value: 'REF-A' } });
  expect((methods[1] as HTMLSelectElement).value).toBe('cash');
  expect((references[1] as HTMLInputElement).value).toBe('');
  fireEvent.click(screen.getAllByRole('button', { name: 'บันทึกคืนเงิน' })[1]);
  await waitFor(() => expect(client.rpc).toHaveBeenCalledWith('settle_refund', expect.objectContaining({
    p_obligation_id: 'B', p_refund_method: 'cash', p_reference_number: null,
  })));
  confirm.mockRestore();
});
