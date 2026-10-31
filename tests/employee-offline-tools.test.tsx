import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { EmployeeLayout } from '../src/EmployeeLayout';
import { OfflineTools } from '../src/offline/runtime/OfflineTools';
import { OfflineEngine, type OfflineTransport } from '../src/offline/runtime/engine';
import { WorkStore } from '../src/offline/runtime/store';
import type { EmployeeRuntime } from '../src/offline/runtime/client';
import type { WorkCommand } from '../src/offline/runtime/types';
import { offlineSnapshot } from './helpers/offlineSnapshot';

afterEach(() => vi.restoreAllMocks());

async function setup(send: OfflineTransport['send']) {
  const snapshot = offlineSnapshot();
  const store = new WorkStore(new IDBFactory(), 'offline-tools');
  await store.install(snapshot);
  const engine = new OfflineEngine(snapshot.ownerId, snapshot.serviceDate, store, { send, resolutions: async () => [] });
  const command: WorkCommand = {
    id: 'delivery', ownerId: snapshot.ownerId, serviceDate: snapshot.serviceDate,
    deviceId: 'device', sequence: 1, type: 'delivery', rpc: 'record_delivery_with_vat_check',
    args: {}, expected: {}, recordedAt: snapshot.preparedAt, status: 'pending',
    label: 'ร้านที่รอตรวจสอบ', attempts: 0, nextAttemptAt: 0,
  };
  const runtime = { engine, prepare: vi.fn(async () => {}) } as unknown as EmployeeRuntime;
  render(<EmployeeLayout profileLabel="พนักงาน" headerActions={<OfflineTools runtime={runtime} />}>
    <h1>บันทึกส่ง</h1>
  </EmployeeLayout>);
  return { engine, store, command };
}

it.each(['conflict', 'blocked', 'auth_required'] as const)(
  'signals a background %s without opening details, then clears after resolution', async status => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    const send: OfflineTransport['send'] = async () => {
      if (status === 'conflict') return { status: 'conflict', error: 'Price changed' };
      throw { status: status === 'auth_required' ? 401 : 400, message: 'Sync needs attention' };
    };
    const { engine, store, command } = await setup(send);
    try {
      await act(async () => { await store.update(command); await engine.reload(); });
      const trigger = screen.getByRole('button', { name: 'ข้อมูลและรายการออฟไลน์' });
      expect(trigger.querySelector('.employee-offline-badge')).toBeNull();

      await act(async () => { await engine.sync(); });
      expect((await store.commands(command.ownerId))[0].status).toBe(status);
      expect(screen.getByRole('button', { name: /รายการต้องตรวจสอบ · 1/ })).toBe(trigger);
      expect(trigger.querySelector('.employee-offline-badge')?.textContent).toBe('1');
      expect(screen.getByRole('status').textContent).toBe('รายการต้องตรวจสอบ · 1');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.queryByText(command.label)).toBeNull();

      // jsdom has no native showModal; only supply that browser primitive.
      const dialog = document.querySelector('dialog')!;
      dialog.showModal = () => dialog.setAttribute('open', '');
      dialog.close = () => { dialog.removeAttribute('open'); dialog.dispatchEvent(new Event('close')); };
      fireEvent.click(trigger);
      expect(screen.getByRole('dialog')).toBe(dialog);
      expect(screen.getByText(command.label)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'ปิด', exact: true }));
      expect(screen.queryByRole('dialog')).toBeNull();

      await act(async () => { await store.update({ ...command, status: 'applied' }); await engine.reload(); });
      expect(screen.getByRole('button', { name: 'ข้อมูลและรายการออฟไลน์' })).toBe(trigger);
      expect(trigger.querySelector('.employee-offline-badge')).toBeNull();
      expect(screen.getByRole('status').textContent).toBe('');
    } finally { engine.dispose(); await store.close(); }
  },
);

it('counts unfinished previous-day work but leaves current normal syncing and completed history quiet', async () => {
  const { engine, store, command } = await setup(async () => ({ status: 'applied', result: {} }));
  try {
    await act(async () => {
      for (const [i, status] of (['pending', 'syncing', 'retry_wait', 'applied', 'discard_approved'] as const).entries()) {
        await store.update({ ...command, id: `today-${i}`, sequence: i + 1, status });
        await store.update({ ...command, id: `yesterday-${i}`, sequence: i + 1, status, serviceDate: '2026-10-28' });
      }
      await engine.reload();
    });
    expect(screen.getByRole('button', { name: /รายการต้องตรวจสอบ · 3/ }).querySelector('.employee-offline-badge')?.textContent).toBe('3');
    expect(screen.queryByRole('dialog')).toBeNull();
  } finally { engine.dispose(); await store.close(); }
});
