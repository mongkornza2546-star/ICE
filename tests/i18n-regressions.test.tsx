import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useState, type ReactNode } from 'react';
import { LanguageProvider, LanguageSwitcher, uiDateTimeFormat } from '../src/i18n';
import { EmployeeEventDialog } from '../src/features/employee-events/EmployeeEventDialog';
import { ManagerRoundControl } from '../src/ManagerRoundControl';
import type { DeliveryRound } from '../src/types/app';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc } }));

function mount(children: ReactNode) {
  const root = document.createElement('div');
  root.id = 'root';
  document.body.append(root);
  return render(<LanguageProvider><LanguageSwitcher />{children}</LanguageProvider>, { container: root });
}
afterEach(() => { document.getElementById('root')?.remove(); rpc.mockReset(); });

it('keeps business text unchanged when it matches UI copy, including after updates', async () => {
  function BusinessData() {
    const [name, setName] = useState('ร้านค้า');
    return <><b data-testid="shop-name">{name}</b><button onClick={() => setName('เงินสด')}>change</button></>;
  }
  mount(<BusinessData />);
  fireEvent.change(screen.getByLabelText('ภาษา'), { target: { value: 'my' } });
  await waitFor(() => expect(screen.getByTestId('shop-name').textContent).toBe('ร้านค้า'));
  fireEvent.click(screen.getByText('change'));
  await waitFor(() => expect(screen.getByTestId('shop-name').textContent).toBe('เงินสด'));
});

it('translates the real event portal and restores Thai without losing its input', async () => {
  mount(<EmployeeEventDialog title="เพิ่มบูธ" context="ร้านค้า" busy={false} onClose={() => {}} onSubmit={() => {}} submitLabel="บันทึกบูธ"><input aria-label="draft" defaultValue="เงินสด" /></EmployeeEventDialog>);
  const dialog = screen.getByRole('dialog');
  expect(document.getElementById('root')!.contains(dialog)).toBe(false);
  fireEvent.change(document.querySelector('.language-switcher select')!, { target: { value: 'my' } });
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'ပယ်ဖျက်ရန်' })).toBeTruthy());
  expect(within(dialog).getByText('ร้านค้า')).toBeTruthy();
  expect((within(dialog).getByLabelText('draft') as HTMLInputElement).value).toBe('เงินสด');
  fireEvent.change(document.querySelector('.language-switcher select')!, { target: { value: 'th' } });
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'ยกเลิก' })).toBeTruthy());
});

it('requires a reason for Other and sends the original reason after a language switch', async () => {
  rpc.mockImplementation(async (name: string) => ({ data: name === 'get_round_control_summary'
    ? { stop_counts: { delivered: 0, problem: 0, pending: 0, total: 0 }, ice_counts: [] }
    : { can_cancel: true, blockers: [], status: 'open' }, error: null }));
  const round: DeliveryRound = { id: 'round-1', name: 'ร้านค้า', service_date: '2026-10-10', status: 'open', round_type: 'daily', opened_at: '2026-10-10T00:00:00Z', closed_at: null };
  mount(<ManagerRoundControl round={round} onClosed={async () => {}} onCancelled={async () => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'ยกเลิกรายการเดิม' }));
  fireEvent.change(screen.getByLabelText('ภาษา'), { target: { value: 'my' } });
  const select = screen.getByRole('dialog').querySelector('select')!;
  await waitFor(() => expect(select.options[3].text).toBe('အခြား'));
  fireEvent.change(select, { target: { value: select.options[3].value } });
  const detail = screen.getByRole('dialog').querySelector('textarea')!;
  expect(detail.required).toBe(true);
  fireEvent.submit(screen.getByRole('dialog'));
  expect(rpc.mock.calls.some(([name]) => name === 'cancel_delivery_round')).toBe(false);
  fireEvent.change(detail, { target: { value: 'เหตุผลที่กรอกเอง' } });
  fireEvent.submit(screen.getByRole('dialog'));
  await waitFor(() => expect(rpc).toHaveBeenCalledWith('cancel_delivery_round', { p_round_id: 'round-1', p_reason: 'เหตุผลที่กรอกเอง' }));
});

it('defaults UI timestamps to Bangkok even on a non-Bangkok host', () => {
  mount(null);
  fireEvent.change(screen.getByLabelText('ภาษา'), { target: { value: 'my' } });
  const formatter = uiDateTimeFormat({ hour: '2-digit', minute: '2-digit' });
  expect(formatter.resolvedOptions().timeZone).toBe('Asia/Bangkok');
  expect(formatter.format(new Date('2026-10-10T00:00:00Z'))).toBe('07:00');
});
