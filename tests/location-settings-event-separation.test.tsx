import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocationSettings } from '../src/LocationSettings';
import { StockLocationSettings } from '../src/StockLocationSettings';
import type { BuildingOption, BuildingZoneOption, StockLocationSetting } from '../src/types/app';

const { fromMock, rpcMock, insertMock, updateMock } = vi.hoisted(() => ({
  fromMock: vi.fn(), rpcMock: vi.fn(), insertMock: vi.fn(), updateMock: vi.fn(),
}));
vi.mock('../src/lib/supabase', () => ({ supabase: { from: fromMock, rpc: rpcMock } }));

let buildings: BuildingOption[];
let zones: BuildingZoneOption[];
let locations: StockLocationSetting[];

function stockLocation(overrides: Partial<StockLocationSetting>): StockLocationSetting {
  return {
    id: 'site-real', code: 'SITE-B', name: 'จุดตึกจริง', kind: 'work_site', building_id: 'real',
    assigned_user_id: null, is_courier_source: false, is_default_for_building: true,
    is_active: true, holds_inventory: false, requires_daily_count: false, ...overrides,
  };
}

beforeEach(() => {
  buildings = [
    { id: 'event', code: ' event-job ', name: 'ตึก B', sort_order: 1, is_active: true },
    { id: 'real', code: 'B', name: 'ตึก B', sort_order: 2, is_active: true },
  ];
  zones = [
    { id: 'zone-real', building_id: 'real', code: 'B1', name: 'ชั้น 1', sort_order: 1, is_active: true },
    { id: 'zone-event', building_id: 'real', code: 'event-job-zone', name: 'งานประจำเดือน', sort_order: 8, is_active: true },
    { id: 'zone-under-event', building_id: 'event', code: 'Z1', name: 'โซนตึกจำลอง', sort_order: 1, is_active: true },
  ];
  locations = [
    stockLocation({}),
    stockLocation({ id: 'site-event', code: ' site-event-job ', name: 'จุดรายงานงาน', building_id: 'event' }),
    stockLocation({ id: 'site-linked', code: 'LEGACY', name: 'จุดรายงานเดิม', building_id: 'event' }),
    stockLocation({ id: 'truck', code: 'SITE-EVENT-TRUCK', name: 'รถถือสต๊อกจริง', kind: 'truck', building_id: 'event', holds_inventory: true, is_default_for_building: false }),
  ];
  insertMock.mockImplementation((payload) => {
    zones.push({ id: 'zone-new', ...payload });
    return Promise.resolve({ data: null, error: null });
  });
  updateMock.mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) });
  fromMock.mockImplementation((table: string) => {
    const query = {
      select: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(),
      insert: insertMock, update: updateMock,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({
        data: { buildings, building_zones: zones, stock_locations: locations }[table]?.map((row) => ({ ...row })), error: null,
      }).then(resolve),
    };
    return query;
  });
  rpcMock.mockImplementation((name: string) => Promise.resolve({
    data: name === 'get_assignable_round_members' ? [] : name === 'save_stock_location' ? 'truck' : 'real', error: null,
  }));
});

describe('permanent building and zone settings', () => {
  it('hides event buildings and zones, including event zones inside a real building', async () => {
    render(<LocationSettings />);
    const building = await screen.findByRole('button', { name: '2. B · ตึก B ใช้งาน · 1 โซนย่อย' });
    expect(building).not.toBeNull();
    expect(screen.queryByRole('button', { name: /event-job/i })).toBeNull();
    expect(screen.queryByText(/งานประจำเดือน|โซนตึกจำลอง/)).toBeNull();
    expect(screen.getByRole('button', { name: '1. B1 · ชั้น 1 ใช้งาน' })).not.toBeNull();
  });

  it('adds a permanent zone after hidden zone sort orders and can edit it', async () => {
    const user = userEvent.setup();
    render(<LocationSettings />);
    await user.click(await screen.findByRole('button', { name: /B · ตึก B/ }));
    await user.type(screen.getByLabelText('รหัสโซน'), 'B2');
    await user.type(screen.getByLabelText('ชื่อโซนย่อย'), 'ชั้น 2');
    await user.click(screen.getByRole('button', { name: 'บันทึกโซนย่อย' }));
    await waitFor(() => expect(insertMock).toHaveBeenCalledWith({
      building_id: 'real', code: 'B2', name: 'ชั้น 2', sort_order: 9, is_active: true,
    }));
    await user.click(await screen.findByRole('button', { name: '9. B2 · ชั้น 2 ใช้งาน' }));
    await user.clear(screen.getByLabelText('ชื่อโซนย่อย'));
    await user.type(screen.getByLabelText('ชื่อโซนย่อย'), 'ชั้นสอง');
    await user.click(screen.getByRole('button', { name: 'บันทึกโซนย่อย' }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'ชั้นสอง', sort_order: 9 })));
  });

  it('shows an empty state when only event locations exist', async () => {
    buildings = buildings.filter((building) => building.id === 'event');
    render(<LocationSettings />);
    expect(await screen.findByText('ยังไม่มีตึกถาวร กรุณาเพิ่มตึก')).not.toBeNull();
    expect(screen.getByRole('button', { name: '+ โซนใหม่' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: /event-job/i })).toBeNull();
  });

  it('clears drafts and selection if a reload reveals they belong to an event', async () => {
    const user = userEvent.setup();
    render(<LocationSettings />);
    await user.click(await screen.findByRole('button', { name: /B · ตึก B/ }));
    await user.click(screen.getByRole('button', { name: '1. B1 · ชั้น 1 ใช้งาน' }));
    rpcMock.mockImplementation(async () => {
      buildings = buildings.map((building) => ({ ...building, code: 'EVENT-' + building.id }));
      return { data: 'real', error: null };
    });
    await user.click(screen.getByRole('button', { name: 'บันทึกตึก' }));
    expect(await screen.findByText('ยังไม่มีตึกถาวร กรุณาเพิ่มตึก')).not.toBeNull();
    expect((screen.getByLabelText('รหัสตึก') as HTMLInputElement).value).toBe('');
    expect(screen.queryByLabelText('รหัสโซน')).toBeNull();
  });
});

describe('permanent stock location settings', () => {
  it('hides event report sites but retains actual inventory holders', async () => {
    render(<StockLocationSettings />);
    expect(await screen.findByRole('button', { name: /SITE-B · จุดตึกจริง/ })).not.toBeNull();
    expect(screen.queryByRole('button', { name: /จุดรายงานงาน|จุดรายงานเดิม/ })).toBeNull();
    expect(screen.getByRole('button', { name: /รถถือสต๊อกจริง/ })).not.toBeNull();
    expect(screen.queryByRole('option', { name: /event-job/i })).toBeNull();
    expect(screen.getByRole('option', { name: 'B · ตึก B' })).not.toBeNull();
  });

  it('preserves an existing event building link when saving a real inventory holder', async () => {
    const user = userEvent.setup();
    render(<StockLocationSettings />);
    await user.click(await screen.findByRole('button', { name: /รถถือสต๊อกจริง/ }));
    const select = screen.getByLabelText('ตึกที่เกี่ยวข้อง (ถ้ามี)');
    const legacy = within(select).getByRole('option', { name: 'ตึก B · อีเวนต์ (ความสัมพันธ์เดิม)' });
    expect(legacy.hasAttribute('disabled')).toBe(true);
    expect((select as HTMLSelectElement).value).toBe('event');
    await user.click(screen.getByRole('button', { name: 'บันทึกจุดถือครอง' }));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('save_stock_location', expect.objectContaining({
      p_location_id: 'truck', p_building_id: 'event', p_holds_inventory: true,
    })));
  });

  it('clears a saved draft if it becomes a hidden event report site', async () => {
    const user = userEvent.setup();
    render(<StockLocationSettings />);
    await user.click(await screen.findByRole('button', { name: /รถถือสต๊อกจริง/ }));
    rpcMock.mockImplementation(async (name: string) => {
      if (name === 'save_stock_location') locations = locations.map((location) => location.id === 'truck'
        ? { ...location, kind: 'work_site', holds_inventory: false } : location);
      return { data: name === 'get_assignable_round_members' ? [] : 'truck', error: null };
    });
    await user.click(screen.getByRole('button', { name: 'บันทึกจุดถือครอง' }));
    await waitFor(() => expect((screen.getByLabelText('รหัส') as HTMLInputElement).value).toBe(''));
    expect(screen.queryByRole('button', { name: /รถถือสต๊อกจริง/ })).toBeNull();
  });
});
