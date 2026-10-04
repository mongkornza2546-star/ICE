// Local visual fixture: all actions use in-memory sample data, never production writes.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CalendarBlank, Coins, Package, Storefront } from '@phosphor-icons/react';
import { EmployeeEventPage } from '../../src/EmployeeEventPage';
import { EmployeeLayout } from '../../src/EmployeeLayout';
import { shiftServiceDate, toBangkokDateString } from '../../src/lib/serviceDate';
import type { EmployeeEventBooth, EmployeeEventGateway, EmployeeEventSummary } from '../../src/features/employee-events/types';
import '../../src/index.css';

const today = toBangkokDateString();
const events: EmployeeEventSummary[] = [
  { id: 'market', name: 'ตลาดนัดประจำเดือน', location: 'ลานกิจกรรม อาคาร A', start_date: today, end_date: shiftServiceDate(today, 3), active_participation_count: 83 },
  { id: 'preparing', name: 'เทศกาลอาหารและเครื่องดื่ม', location: 'ศูนย์ประชุม ฮอลล์ 2', preparation_start_date: today, start_date: shiftServiceDate(today, 1), end_date: shiftServiceDate(today, 4), active_participation_count: 12 },
  { id: 'upcoming', name: 'ตลาดนัดปลายเดือน', location: 'ลานกิจกรรม อาคาร B', start_date: shiftServiceDate(today, 10), end_date: shiftServiceDate(today, 12), active_participation_count: 0 },
  { id: 'ended', name: 'งานอาหารประจำสัปดาห์', location: 'อาคาร C', start_date: shiftServiceDate(today, -5), end_date: shiftServiceDate(today, -1), active_participation_count: 8 },
];
const names = ['ร้านเจ้กุ้งผลไม้', '863coffee', 'น้ำสมุนไพรบ้านสวน', 'ข้าวมันไก่ป้าพร', 'ลูกชิ้นปิ้งนายเอ', 'ชาไทยหอมกรุ่น'];
const booths = new Map(events.map((event) => [event.id, Array.from({ length: event.active_participation_count }, (_, index): EmployeeEventBooth => ({
  id: `${event.id}-${index}`, event_job_id: event.id, shop_id: `shop-${event.id}-${index}`, booth_number: String(index + 1).padStart(3, '0'),
  shop_name: names[index % names.length], event_zone: index < 30 ? 'โซน A' : index < 60 ? 'โซน B' : 'โซน C',
  contact_name: null, contact_phone: null, start_date: event.start_date, end_date: event.end_date, preparation_start_date: event.preparation_start_date,
  tank_handoff_count: index % 5, tank_return_count: index % 2 && index % 5 ? 1 : 0,
  tank_balance: index % 5 - (index % 2 && index % 5 ? 1 : 0), tank_rental_unit_price: 100,
}))]));
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const gateway: EmployeeEventGateway = {
  async loadEvents() { return clone(events); },
  async loadEvent(id) { return clone({ event: events.find((event) => event.id === id)!, booths: booths.get(id)! }); },
  async createBooth(input) {
    const event = events.find((event) => event.id === input.eventJobId)!;
    const existing = booths.get(event.id)!.find((booth) => booth.booth_number === input.boothNumber && (booth.event_zone ?? '') === input.eventZone);
    if (existing) return { created: false, duplicate: true, booth: clone(existing) };
    const booth: EmployeeEventBooth = {
      id: input.requestId, event_job_id: event.id, shop_id: input.requestId, booth_number: input.boothNumber,
      shop_name: input.shopName || `บูธ ${input.boothNumber}`, event_zone: input.eventZone || null,
      contact_name: input.contactName, contact_phone: input.contactPhone, start_date: event.start_date, end_date: event.end_date,
      tank_handoff_count: 0, tank_return_count: 0, tank_balance: 0, tank_rental_unit_price: 100,
    };
    booths.get(event.id)!.push(booth);
    event.active_participation_count += 1;
    return { created: true, duplicate: false, booth: clone(booth) };
  },
  async handoffTanks(input) {
    const booth = [...booths.values()].flat().find((booth) => booth.id === input.participationId)!;
    booth.tank_handoff_count += input.quantity;
    booth.tank_balance += input.quantity;
    return { id: input.requestId, event_participation_id: booth.id, quantity: input.quantity, service_date: today, rental_unit_price: booth.tank_rental_unit_price };
  },
};
function Preview() {
  const [active, setActive] = useState('events');
  const tabs = [{ id: 'withdrawal', label: 'เติม / คืน / ละลาย', icon: Package }, { id: 'pos', label: 'POS', icon: Storefront }, { id: 'collection', label: 'เก็บเงิน', icon: Coins }, { id: 'events', label: 'อีเวนต์', icon: CalendarBlank }];
  return <EmployeeLayout profileLabel="ตัวอย่าง · ข้อมูลจำลอง"><nav aria-label="งานพนักงาน" className="employee-task-tabs">{tabs.map(({ id, label, icon: Icon }) => <button aria-current={active === id ? 'page' : undefined} onClick={() => setActive(id)} key={id} type="button"><Icon size={22} /><span>{label}</span></button>)}</nav><div style={{ display: active === 'events' ? undefined : 'none' }}><EmployeeEventPage gateway={gateway} isActive={active === 'events'} /></div>{active !== 'events' ? <p>ตัวอย่างนี้ใช้ตรวจหน้าอีเวนต์ · กด “อีเวนต์” เพื่อกลับไปทำงานต่อ</p> : null}</EmployeeLayout>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Preview /></React.StrictMode>);
