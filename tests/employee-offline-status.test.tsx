import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { OfflineStatus } from '../src/offline/runtime/OfflineStatus';
import { OfflineEngine } from '../src/offline/runtime/engine';
import { WorkStore } from '../src/offline/runtime/store';
import type { EmployeeRuntime } from '../src/offline/runtime/client';
import type { WorkCommand } from '../src/offline/runtime/types';
import { offlineSnapshot } from './helpers/offlineSnapshot';

afterEach(() => vi.restoreAllMocks());

it('shows the blocking command before confirmed history and explains why syncing cannot unblock it', async () => {
  const user = userEvent.setup();
  const snapshot = offlineSnapshot();
  snapshot.validUntil = new Date(Date.now() + 60_000).toISOString();
  const store = new WorkStore(new IDBFactory(), 'status-conflict');
  const send = vi.fn();
  const resolutions = vi.fn(async () => []);
  const engine = new OfflineEngine(snapshot.ownerId, snapshot.serviceDate, store, { send, resolutions });
  const command: WorkCommand = {
    id: 'blocked-command', ownerId: snapshot.ownerId, serviceDate: snapshot.serviceDate,
    deviceId: 'device', sequence: 1, type: 'delivery', rpc: 'record_delivery_with_vat_check',
    args: {}, expected: {}, recordedAt: snapshot.preparedAt, status: 'conflict',
    label: 'ร้านที่รอตรวจสอบ', error: 'Price changed', attempts: 1, nextAttemptAt: 0,
  };
  try {
    await store.install(snapshot);
    await store.update(command);
    // More than the history display limit must never hide unresolved work.
    for (let i = 0; i < 101; i++) await store.update({ ...command, id: `confirmed-${i}`,
      sequence: i + 2, status: 'applied', label: `ยืนยันแล้ว ${i}`, error: undefined });
    await engine.reload();
    const prepare = vi.fn(async () => {});
    render(<OfflineStatus runtime={{ engine, prepare } as unknown as EmployeeRuntime} />);
    expect(screen.getByRole('status').textContent).toContain('มีรายการรอตรวจสอบ');
    expect(screen.queryByText('พร้อมทำงาน แม้ไม่มีเน็ต')).toBeNull();
    expect(within(screen.getAllByRole('listitem')[0]).getByText(command.label)).toBeTruthy();
    expect(screen.getByText('Price changed')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'ส่งรายการค้างเข้าระบบ' }));
    await waitFor(() => expect(prepare).toHaveBeenCalledWith(true));
    expect(resolutions).toHaveBeenCalledWith([command.id]);
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByText(/กดซิงก์ซ้ำจะยังทำรายการเพิ่มไม่ได้/)).toBeTruthy();
    expect((await store.commands(snapshot.ownerId))[0]).toMatchObject(command);

    await act(async () => {
      await store.update({ ...command, status: 'applied', error: undefined });
      await engine.reload();
    });
    expect(screen.getByRole('status').textContent).toContain('พร้อมทำงาน แม้ไม่มีเน็ต');
    expect(screen.queryByText(/กดซิงก์ซ้ำจะยังทำรายการเพิ่มไม่ได้/)).toBeNull();
  } finally { engine.dispose(); await store.close(); }
});
