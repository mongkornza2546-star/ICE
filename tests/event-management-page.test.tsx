import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventManagementPage } from '../src/EventManagementPage';
import type {
  EventManagementDetail,
  EventManagementGateway,
  EventOverview,
} from '../src/features/event-management/types';

const event: EventOverview = {
  id: 'event-1',
  name: 'งานอาหารเมืองทอง',
  organizer_name: 'ผู้จัดงาน',
  contact_name: 'คุณแอน',
  contact_phone: '0811111111',
  location: 'ฮอลล์ A',
  start_date: '2026-09-10',
  end_date: '2026-09-12',
  timezone: 'Asia/Bangkok',
  notes: null,
  status: 'draft',
  current_config_version_id: 'config-1',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  published_at: null,
  cancelled_at: null,
  cancellation_reason: null,
  active_participation_count: 2,
  has_configuration: true,
};

function detail(ready = true): EventManagementDetail {
  return {
    event,
    configuration: {
      id: 'config-1',
      event_job_id: event.id,
      version_no: 1,
      tank_rental_unit_price: 100,
      payment_term: 'end_of_day',
      allowed_payment_methods: ['cash'],
      default_payment_method: 'cash',
      cash_reference_required: false,
      cash_evidence_required: false,
      bank_transfer_reference_required: true,
      bank_transfer_evidence_required: false,
      qr_reference_required: true,
      qr_evidence_required: false,
    },
    participations: [
      {
        id: 'participation-1',
        event_job_id: event.id,
        shop_id: 'shop-1',
        booth_number: 'A01',
        event_zone: 'อาหาร',
        landmark: null,
        contact_name: null,
        contact_phone: null,
        start_date: event.start_date,
        end_date: event.end_date,
        rents_tank_from_us: false,
        status: 'active',
        cancellation_reason: null,
        shop_code: 'S01',
        shop_name: 'ร้านหนึ่ง',
        shop_status: 'active',
        shop_contact_name: 'คุณหนึ่ง',
        shop_contact_phone: '0800000001',
      },
      {
        id: 'participation-2',
        event_job_id: event.id,
        shop_id: 'shop-2',
        booth_number: 'A02',
        event_zone: 'อาหาร',
        landmark: null,
        contact_name: null,
        contact_phone: null,
        start_date: event.start_date,
        end_date: event.end_date,
        rents_tank_from_us: false,
        status: 'active',
        cancellation_reason: null,
        shop_code: 'S02',
        shop_name: 'ร้านสอง',
        shop_status: 'active',
        shop_contact_name: 'คุณสอง',
        shop_contact_phone: '0800000002',
      },
    ],
    readiness: {
      is_ready: ready,
      checks: [
        { code: 'draft_status', ok: true, message: 'งานอยู่ในสถานะฉบับร่าง' },
        { code: 'settlement_configuration', ok: true, message: 'ตั้งค่านโยบายการชำระเงินแล้ว' },
        { code: 'participation_count', ok: true, message: 'จำนวนร้านอยู่ในช่วงที่เผยแพร่ได้', actual: 2 },
        { code: 'participation_details', ok: true, message: 'ข้อมูลร้านและผู้ติดต่อครบ', items: [] },
        { code: 'standard_price_coverage', ok: ready, message: ready ? 'ราคากลางครอบคลุมทุกวันของงาน' : 'ราคากลางยังไม่ครอบคลุมทุกวันของงาน', items: ready ? [] : [{ ice_type_id: 'ice-1', ice_type_code: 'ICE', ice_type_name: 'น้ำแข็งหลอด', missing_ranges: [{ start_date: '2026-09-10', end_date: '2026-09-12' }] }] },
      ],
    },
  };
}

function gateway(detailValue = detail()): EventManagementGateway {
  return {
    loadCapability: vi.fn().mockResolvedValue({ schema_version: 5, lifecycle_enabled: true }),
    loadOverview: vi.fn().mockResolvedValue([event]),
    loadDetail: vi.fn().mockResolvedValue(detailValue),
    loadActiveShops: vi.fn().mockResolvedValue([
      { id: 'shop-3', code: 'S03', name: 'ร้านสาม', contact_name: 'คุณสาม', contact_phone: '0800000003', status: 'active' },
    ]),
    createEventShops: vi.fn().mockResolvedValue({ created_count: 1, skipped_count: 0 }),
    saveMetadata: vi.fn().mockResolvedValue(event),
    saveEvent: vi.fn().mockResolvedValue({ event_job: event, configuration: detailValue.configuration! }),
    saveParticipation: vi.fn().mockResolvedValue(detailValue.participations[0]),
    publishEvent: vi.fn().mockResolvedValue({ ...event, status: 'published' }),
    cancelEvent: vi.fn().mockResolvedValue({ ...event, status: 'cancelled' }),
    cancelParticipation: vi.fn().mockResolvedValue({ ...detailValue.participations[0], status: 'cancelled' }),
  };
}

describe('EventManagementPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows actionable readiness and blocks publish until every check passes', async () => {
    const blockedGateway = gateway(detail(false));
    render(<EventManagementPage gateway={blockedGateway} profileRole="admin" />);

    expect(await screen.findByText('ราคากลางยังไม่ครอบคลุมทุกวันของงาน')).not.toBeNull();
    expect(screen.getByText(/ICE น้ำแข็งหลอด/)).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Publish' }).hasAttribute('disabled')).toBe(true);
  });

  it('publishes a ready draft after confirmation', async () => {
    const readyGateway = gateway();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    render(<EventManagementPage gateway={readyGateway} profileRole="round_lead" />);

    await user.click(await screen.findByRole('button', { name: 'Publish' }));

    expect(readyGateway.publishEvent).toHaveBeenCalledWith('event-1');
    expect(await screen.findByText('เผยแพร่งานอีเวนต์แล้ว')).not.toBeNull();
  });

  it('uses the admin RPC payload when creating an event with settlement configuration', async () => {
    const adminGateway = gateway();
    const user = userEvent.setup();
    render(<EventManagementPage gateway={adminGateway} profileRole="admin" />);

    await user.click(await screen.findByRole('button', { name: 'สร้างงาน' }));
    await user.type(screen.getByLabelText('ชื่องาน'), 'งานใหม่');
    await user.type(screen.getByLabelText('ผู้จัดงาน'), 'ผู้จัดใหม่');
    await user.type(screen.getByLabelText('สถานที่'), 'ฮอลล์ B');
    await user.type(screen.getByLabelText('ผู้ติดต่อหลัก'), 'คุณบี');
    await user.type(screen.getByLabelText('เบอร์โทร'), '0899999999');
    await user.click(screen.getByText('ตั้งค่าการชำระเงิน (ไม่จำเป็นต้องกรอก)'));
    await user.click(screen.getByLabelText('โอนธนาคาร'));
    await user.click(screen.getByLabelText('QR'));
    await user.selectOptions(screen.getByLabelText('วิธีรับเงินเริ่มต้น'), 'cash');
    await user.click(screen.getByRole('button', { name: 'บันทึกงาน' }));

    await waitFor(() => expect(adminGateway.saveEvent).toHaveBeenCalledWith(expect.objectContaining({
      event_job_id: null,
      name: 'งานใหม่',
      tank_rental_unit_price: 100,
      allowed_payment_methods: ['cash'],
      default_payment_method: 'cash',
    })));
    expect(adminGateway.saveMetadata).not.toHaveBeenCalled();
  });

  it('uses metadata-only RPC for round leads and explains the admin configuration gate', async () => {
    const leadGateway = gateway();
    const user = userEvent.setup();
    render(<EventManagementPage gateway={leadGateway} profileRole="round_lead" />);

    await user.click(await screen.findByRole('button', { name: 'สร้างงาน' }));
    expect(screen.getByText('การตั้งค่าการชำระเงินเป็นสิทธิ์แอดมิน')).not.toBeNull();
    await user.type(screen.getByLabelText('ชื่องาน'), 'งานหัวหน้ารอบ');
    await user.type(screen.getByLabelText('ผู้จัดงาน'), 'ผู้จัด');
    await user.type(screen.getByLabelText('สถานที่'), 'ฮอลล์ C');
    await user.type(screen.getByLabelText('ผู้ติดต่อหลัก'), 'คุณซี');
    await user.type(screen.getByLabelText('เบอร์โทร'), '0888888888');
    await user.click(screen.getByRole('button', { name: 'บันทึกงาน' }));

    await waitFor(() => expect(leadGateway.saveMetadata).toHaveBeenCalledWith(expect.objectContaining({
      event_job_id: null,
      name: 'งานหัวหน้ารอบ',
    })));
    expect(leadGateway.saveEvent).not.toHaveBeenCalled();
  });

  it('adds an existing active shop with event dates and no tank rental', async () => {
    const shopGateway = gateway();
    const user = userEvent.setup();
    render(<EventManagementPage gateway={shopGateway} profileRole="round_lead" />);

    await user.click(await screen.findByRole('button', { name: 'เพิ่มร้าน' }));
    expect(screen.queryByRole('listbox')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'เลือกร้านประจำ' }));
    await user.click(await screen.findByRole('option', { name: /S03.*ร้านสาม/ }));
    await user.type(screen.getByLabelText('เลขบูธ'), 'B03');
    await user.click(screen.getByRole('button', { name: 'บันทึกร้าน' }));

    await waitFor(() => expect(shopGateway.saveParticipation).toHaveBeenCalledWith({
      participation_id: null,
      event_job_id: 'event-1',
      shop_id: 'shop-3',
      booth_number: 'B03',
      event_zone: '',
      landmark: '',
      contact_name: '',
      contact_phone: '',
      start_date: '2026-09-10',
      end_date: '2026-09-12',
      rents_tank_from_us: false,
    }));
  });

  it('preserves the hidden tank-rental flag when editing a participation', async () => {
    const tankDetail = detail();
    tankDetail.participations[0].rents_tank_from_us = true;
    const editGateway = gateway(tankDetail);
    const user = userEvent.setup();
    render(<EventManagementPage gateway={editGateway} profileRole="round_lead" />);

    await user.click(await screen.findByRole('button', { name: 'แก้ไข S01 ร้านหนึ่ง' }));
    await user.click(screen.getByRole('button', { name: 'บันทึกร้าน' }));

    await waitFor(() => expect(editGateway.saveParticipation).toHaveBeenCalledWith(
      expect.objectContaining({
        participation_id: 'participation-1',
        rents_tank_from_us: true,
      }),
    ));
  });

  it('does not offer a cancelled participation shop for re-adding', async () => {
    const cancelledDetail = detail();
    cancelledDetail.participations[0] = {
      ...cancelledDetail.participations[0],
      status: 'cancelled',
      cancellation_reason: 'ถอนตัว',
    };
    const cancelledGateway = gateway(cancelledDetail);
    vi.mocked(cancelledGateway.loadActiveShops).mockResolvedValue([
      { id: 'shop-1', code: 'S01', name: 'ร้านหนึ่ง', contact_name: 'คุณหนึ่ง', contact_phone: '0800000001', status: 'active' },
      { id: 'shop-3', code: 'S03', name: 'ร้านสาม', contact_name: 'คุณสาม', contact_phone: '0800000003', status: 'active' },
    ]);
    const user = userEvent.setup();
    render(<EventManagementPage gateway={cancelledGateway} profileRole="round_lead" />);

    await user.click(await screen.findByRole('button', { name: 'เพิ่มร้าน' }));

    await user.click(screen.getByRole('button', { name: 'เลือกร้านประจำ' }));
    expect(await screen.findByRole('option', { name: /S03.*ร้านสาม/ })).not.toBeNull();
    expect(screen.queryByRole('option', { name: /S01.*ร้านหนึ่ง/ })).toBeNull();
  });

  it('requires a reason before cancelling an event', async () => {
    const cancelGateway = gateway();
    const user = userEvent.setup();
    render(<EventManagementPage gateway={cancelGateway} profileRole="admin" />);

    await user.click(await screen.findByRole('button', { name: 'ยกเลิกงาน' }));
    const submit = screen.getByRole('button', { name: 'ยืนยันยกเลิก' });
    expect(submit.hasAttribute('disabled')).toBe(true);
    await user.type(screen.getByLabelText('เหตุผลในการยกเลิก *'), 'สถานที่ปิด');
    await user.click(submit);

    await waitFor(() => expect(cancelGateway.cancelEvent).toHaveBeenCalledWith('event-1', 'สถานที่ปิด'));
  });
});

it.each(['admin', 'round_lead'] as const)('saves an event with only dates for %s', async (profileRole) => {
  const api = gateway();
  const user = userEvent.setup();
  render(<EventManagementPage gateway={api} profileRole={profileRole} />);
  await user.click(await screen.findByRole('button', { name: 'สร้างงาน' }));
  await user.click(screen.getByRole('button', { name: 'บันทึกงาน' }));
  const save = profileRole === 'admin' ? api.saveEvent : api.saveMetadata;
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: '', contact_phone: '', location: '' })));
});

it('creates a typed new shop and clears an earlier regular-shop selection when typing', async () => {
  const api = gateway();
  const user = userEvent.setup();
  render(<EventManagementPage gateway={api} profileRole="round_lead" />);
  await user.click(await screen.findByRole('button', { name: 'เพิ่มร้าน' }));
  await user.click(screen.getByRole('button', { name: 'เลือกร้านประจำ' }));
  await user.click(await screen.findByRole('option', { name: /S03.*ร้านสาม/ }));
  await user.clear(screen.getByRole('combobox'));
  await user.type(screen.getByRole('combobox'), 'ร้านใหม่วันนี้');
  await user.click(screen.getByRole('button', { name: 'บันทึกร้าน' }));
  await waitFor(() => expect(api.createEventShops).toHaveBeenCalledWith('event-1', expect.any(String), [expect.objectContaining({ name: 'ร้านใหม่วันนี้' })]));
  expect(api.saveParticipation).not.toHaveBeenCalled();
});

it('allows a nameless shop using the event dates', async () => {
  const api = gateway();
  const user = userEvent.setup();
  render(<EventManagementPage gateway={api} profileRole="admin" />);
  await user.click(await screen.findByRole('button', { name: 'เพิ่มร้าน' }));
  await user.click(screen.getByRole('button', { name: 'บันทึกร้าน' }));
  await waitFor(() => expect(api.createEventShops).toHaveBeenCalledWith('event-1', expect.any(String), [expect.objectContaining({ name: '', start_date: event.start_date, end_date: event.end_date })]));
});

it('creates 300 booths across three ranges in building B with one request', async () => {
  const api = gateway();
  vi.mocked(api.createEventShops).mockResolvedValue({ created_count: 300, skipped_count: 0 });
  const user = userEvent.setup();
  render(<EventManagementPage gateway={api} profileRole="admin" />);
  await user.click(await screen.findByRole('button', { name: 'เพิ่มร้าน' }));
  await user.click(screen.getByRole('button', { name: 'เพิ่มหลายร้าน' }));
  await user.type(screen.getByLabelText('ช่วงรหัสบูธ'), 'A1-250\nF1-40\nT1-10');
  await user.type(screen.getByLabelText('ตึก / โซน'), 'ตึก B');
  await user.click(screen.getByRole('button', { name: 'สร้าง 300 ร้าน' }));
  await waitFor(() => expect(api.createEventShops).toHaveBeenCalledTimes(1));
  const rows = vi.mocked(api.createEventShops).mock.calls[0][2];
  expect(rows).toHaveLength(300);
  expect(rows[0]).toMatchObject({ booth_number: 'A1', event_zone: 'ตึก B' });
  expect(rows[249].booth_number).toBe('A250');
  expect(rows[289].booth_number).toBe('F40');
  expect(rows[299].booth_number).toBe('T10');
  expect(await screen.findByText('เพิ่ม 300 ร้านแล้ว')).not.toBeNull();
});

it('still offers adding shops after 50 participations', async () => {
  const value = detail();
  value.participations = Array.from({ length: 300 }, (_, i) => ({ ...value.participations[0], id: `p-${i}` }));
  render(<EventManagementPage gateway={gateway(value)} profileRole="admin" />);
  expect(await screen.findByRole('button', { name: 'เพิ่มร้าน' })).not.toBeNull();
});

it('opens and selects regular-shop suggestions with the keyboard', async () => {
  const api = gateway();
  const user = userEvent.setup();
  render(<EventManagementPage gateway={api} profileRole="admin" />);
  await user.click(await screen.findByRole('button', { name: 'เพิ่มร้าน' }));
  await user.click(screen.getByRole('combobox', { name: 'ชื่อร้าน' }));
  await user.keyboard('{ArrowDown}');
  const option = await screen.findByRole('option', { name: /S03.*ร้านสาม/ });
  await waitFor(() => expect(document.activeElement).toBe(option));
  await user.keyboard('{Enter}');
  expect(screen.queryByRole('listbox')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'บันทึกร้าน' }));
  await waitFor(() => expect(api.saveParticipation).toHaveBeenCalledWith(expect.objectContaining({ shop_id: 'shop-3' })));
});


it.each(['draft', 'published'] as const)('renames an event-only shop in a %s event while saving its details', async (status) => {
  const value = detail();
  value.event = { ...value.event, status };
  value.participations[0] = { ...value.participations[0], shop_code: 'EV-placeholder', shop_name: 'บูธ A1', shop_event_job_id: event.id };
  const api = gateway(value);
  const user = userEvent.setup();
  render(<EventManagementPage gateway={api} profileRole="round_lead" />);
  await user.click(await screen.findByRole('button', { name: 'แก้ไข EV-placeholder บูธ A1' }));
  const name = screen.getByRole('textbox', { name: 'ชื่อร้าน' });
  await user.clear(name);
  await user.type(name, 'ร้านอาหารจากเชียงใหม่');
  await user.click(screen.getByRole('button', { name: 'บันทึกร้าน' }));
  await waitFor(() => expect(api.saveParticipation).toHaveBeenCalledWith(expect.objectContaining({
    participation_id: 'participation-1', shop_id: 'shop-1', shop_name: 'ร้านอาหารจากเชียงใหม่',
  })));
  expect(api.createEventShops).not.toHaveBeenCalled();
});

it('keeps regular-shop names read-only in the event editor', async () => {
  const api = gateway();
  const user = userEvent.setup();
  render(<EventManagementPage gateway={api} profileRole="round_lead" />);
  await user.click(await screen.findByRole('button', { name: 'แก้ไข S01 ร้านหนึ่ง' }));
  expect(screen.queryByRole('textbox', { name: 'ชื่อร้าน' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'บันทึกร้าน' }));
  await waitFor(() => expect(api.saveParticipation).toHaveBeenCalled());
  expect(vi.mocked(api.saveParticipation).mock.calls[0][0]).not.toHaveProperty('shop_name');
});
