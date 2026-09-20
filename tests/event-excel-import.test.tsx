import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { parseEventExcelRows, readEventExcel } from '../src/features/event-management/eventExcelImport';
import { EventExcelImportDialog } from '../src/features/event-management/EventExcelImportDialog';
import type { EventManagementDetail, EventManagementGateway } from '../src/features/event-management/types';

vi.mock('read-excel-file', () => ({ default: vi.fn() }));
import readXlsxFile from 'read-excel-file';
const dates = { start_date: '2026-09-20', end_date: '2026-09-25' };
const cells = [['เลขที่บูธ', 'ชื่อร้านค้า', 'ถังน้ำแข็ง'], ['001', 'ร้านหนึ่ง', 2], ['002', 'ร้านหนึ่ง', 1]];

describe('event Excel import', () => {
  it('preserves padded booths, distinct booths for the same name, tank counts and event dates', () => {
    const rows = parseEventExcelRows(cells, dates);
    expect(rows).toHaveLength(2);
    expect(rows[0].input).toMatchObject({ booth_number: '001', name: 'ร้านหนึ่ง', landmark: 'ถังน้ำแข็ง 2 ถัง (จาก Excel)', ...dates });
    expect(rows[0].input).not.toHaveProperty('rents_tank_from_us');
  });
  it('rejects invalid headers, missing values, duplicate booths and invalid counts', () => {
    expect(() => parseEventExcelRows([['ไม่ถูกต้อง']], dates)).toThrow('แถวแรก');
    expect(() => parseEventExcelRows([...cells, ['003', '', 1]], dates)).toThrow('แถว 4');
    expect(() => parseEventExcelRows([...cells, ['001', 'อีกชื่อ', 1]], dates)).toThrow('ซ้ำกับแถว 2');
    for (const count of [-1, 1.5, 'สอง']) expect(() => parseEventExcelRows([cells[0], ['003', 'ร้าน', count]], dates)).toThrow('จำนวนเต็ม');
  });
  it('accepts optional columns and skips blank rows', () => {
    expect(parseEventExcelRows([['ชื่อร้าน', 'บูธ'], [], ['ร้าน', 'A1']], dates)[0]).toMatchObject({ tankCount: null, input: { booth_number: 'A1', landmark: '' } });
    expect(() => parseEventExcelRows([cells[0]], dates)).toThrow('ไม่พบรายการ');
    expect(() => parseEventExcelRows([cells[0], ...Array.from({ length: 1001 }, (_, i) => [String(i), 'ร้าน', 0])], dates)).toThrow('1,000');
  });
  it('validates file type, size and corrupt workbooks', async () => {
    await expect(readEventExcel(new File([''], 'shops.csv'), dates)).rejects.toThrow('.xlsx');
    await expect(readEventExcel(new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'shops.xlsx'), dates)).rejects.toThrow('10 MB');
    vi.mocked(readXlsxFile).mockRejectedValueOnce(new Error('bad zip'));
    await expect(readEventExcel(new File(['bad'], 'shops.xlsx'), dates)).rejects.toThrow('อ่านไฟล์ Excel ไม่สำเร็จ');
  });
  it('previews before saving, marks existing booths and retries the same request after failure', async () => {
    vi.mocked(readXlsxFile).mockResolvedValue(cells);
    const createEventShops = vi.fn().mockRejectedValueOnce(new Error('เครือข่ายขัดข้อง')).mockResolvedValue({ created_count: 1, skipped_count: 1 });
    const detail = { event: { id: 'event-1', name: 'งานทดสอบ', ...dates }, participations: [{ booth_number: '002', event_zone: '' }] } as EventManagementDetail;
    const gateway = { createEventShops } as unknown as EventManagementGateway;
    const onImported = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<EventExcelImportDialog detail={detail} gateway={gateway} onClose={vi.fn()} onImported={onImported} />);
    await user.upload(screen.getByLabelText('เลือกไฟล์ Excel (.xlsx)'), new File(['test'], 'shops.xlsx'));
    expect(await screen.findByText('001')).toBeTruthy();
    expect(screen.getByText('ข้าม (มีบูธแล้ว)')).toBeTruthy();
    expect(createEventShops).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'ยืนยันนำเข้า 1 ร้าน' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'เครือข่ายขัดข้อง');
    await user.click(screen.getByRole('button', { name: 'ยืนยันนำเข้า 1 ร้าน' }));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith({ created_count: 1, skipped_count: 1 }));
    expect(createEventShops.mock.calls[0]).toEqual(createEventShops.mock.calls[1]);
    expect(createEventShops.mock.calls[0][0]).toBe('event-1');
    expect(createEventShops.mock.calls[0][2][0].booth_number).toBe('001');
  });
  it('clears an earlier valid preview when a replacement file is invalid', async () => {
    vi.mocked(readXlsxFile).mockResolvedValueOnce(cells).mockResolvedValueOnce([['wrong']]);
    const user = userEvent.setup();
    render(<EventExcelImportDialog detail={{ event: { id: 'event-1', ...dates }, participations: [] } as unknown as EventManagementDetail} gateway={{ createEventShops: vi.fn() } as unknown as EventManagementGateway} onClose={vi.fn()} onImported={vi.fn()} />);
    const input = screen.getByLabelText('เลือกไฟล์ Excel (.xlsx)');
    await user.upload(input, new File(['test'], 'first.xlsx'));
    expect(await screen.findByText('001')).toBeTruthy();
    fireEvent.change(input, { target: { files: [new File(['test'], 'bad.xlsx')] } });
    await screen.findByRole('alert');
    expect(screen.queryByText('001')).toBeNull();
    expect(screen.getByRole('button', { name: 'ยืนยันนำเข้า 0 ร้าน' }).hasAttribute('disabled')).toBe(true);
  });
});
