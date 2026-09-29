import { beforeEach, expect, it, vi } from 'vitest';

const supabaseMock = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: supabaseMock }));

import { employeeEventGateway } from '../src/features/employee-events/employeeEventGateway';

beforeEach(() => supabaseMock.rpc.mockReset());

it('loads published events and an event without requiring a round id', async () => {
  supabaseMock.rpc
    .mockResolvedValueOnce({ data: { events: [{ id: 'event-1' }] }, error: null })
    .mockResolvedValueOnce({ data: { event: { id: 'event-1' }, booths: [] }, error: null });

  await expect(employeeEventGateway.loadEvents()).resolves.toEqual([{ id: 'event-1' }]);
  await expect(employeeEventGateway.loadEvent('event-1')).resolves.toMatchObject({ booths: [] });
  expect(supabaseMock.rpc).toHaveBeenNthCalledWith(1, 'get_employee_event_overview', undefined);
  expect(supabaseMock.rpc).toHaveBeenNthCalledWith(2, 'get_employee_event_detail', { p_event_job_id: 'event-1' });
});

it('keeps stable request ids for booth creation and tank handoff', async () => {
  supabaseMock.rpc
    .mockResolvedValueOnce({ data: { created: true, duplicate: false, booth: { id: 'booth-1' } }, error: null })
    .mockResolvedValueOnce({ data: { id: 'movement-1' }, error: null });

  await employeeEventGateway.createBooth({
    eventJobId: 'event-1', requestId: 'request-booth', boothNumber: 'A1', shopName: '',
    eventZone: 'Hall A', contactName: '', contactPhone: '',
  });
  await employeeEventGateway.handoffTanks({
    participationId: 'booth-1', quantity: 3, note: '', requestId: 'request-tanks',
  });

  expect(supabaseMock.rpc).toHaveBeenNthCalledWith(1, 'create_employee_event_booth', {
    p_event_job_id: 'event-1', p_request_id: 'request-booth', p_booth_number: 'A1',
    p_shop_name: null, p_event_zone: 'Hall A', p_contact_name: null, p_contact_phone: null,
  });
  expect(supabaseMock.rpc).toHaveBeenNthCalledWith(2, 'record_employee_event_tank_handoff', {
    p_participation_id: 'booth-1', p_quantity: 3, p_note: '', p_request_id: 'request-tanks',
  });
});
