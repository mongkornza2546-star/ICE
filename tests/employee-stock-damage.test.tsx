import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EmployeeStockTransferSection } from '../src/features/employee-delivery/EmployeeStockTransferSection';
import type { StockTransferMode } from '../src/features/employee-delivery/useEmployeeDeliveryData';

const stockState = {
  round_id: 'round-1',
  service_date: '2026-08-09',
  withdrawn_balances: [{ ice_type_id: 'ice-1', ice_type_name: 'หลอดเล็ก', unit: 'ถุง', quantity: 5 }],
  truck_location: {
    id: 'truck-1', code: 'TRUCK', name: 'รถหลัก',
    balances: [{ ice_type_id: 'ice-1', ice_type_name: 'หลอดเล็ก', unit: 'ถุง', quantity: 10 }],
  },
  holding_location: {
    id: 'holding-1', code: 'HOLDING', name: 'จุดของพนักงาน',
    balances: [{ ice_type_id: 'ice-1', ice_type_name: 'หลอดเล็ก', unit: 'ถุง', quantity: 3 }],
  },
};

function StockTransferHarness({ onSubmit }: { onSubmit: (quantity: number) => void }) {
  const [mode, setMode] = useState<StockTransferMode>('receive');
  const [quantity, setQuantity] = useState(0);
  return <EmployeeStockTransferSection
    stockError={null}
    transferSubmitting={false}
    loadStockState={() => undefined}
    selectedRoundId="round-1"
    stockState={stockState}
    iceTypes={[{ id: 'ice-1', code: 'ICE', name: 'หลอดเล็ก', unit: 'ถุง' }]}
    transferQuantities={{ 'ice-1': quantity }}
    changeTransferQuantity={(_, delta) => setQuantity((current) => Math.max(0, Math.min(3, current + delta)))}
    stockTransferMode={mode}
    changeStockTransferMode={setMode}
    selectedRound={{ id: 'round-1', name: 'รอบวันนี้', service_date: '2026-08-09', status: 'open' }}
    handleStockTransfer={() => onSubmit(quantity)}
    resetTransferQuantities={() => setQuantity(0)}
    variant="cards"
    transferItems={quantity > 0 ? [{ ice_type_id: 'ice-1', quantity }] : []}
  />;
}

describe('employee stock damage', () => {
  it('selects damage, limits it to holding stock, and submits it', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<StockTransferHarness onSubmit={onSubmit} />);

    await user.click(screen.getByRole('button', { name: 'ละลาย' }));
    expect(screen.getByRole('heading', { name: 'บันทึกน้ำแข็งละลาย' })).toBeTruthy();

    const add = screen.getByRole('button', { name: 'เพิ่มหลอดเล็กอีกครึ่ง' });
    await user.click(add);
    expect((screen.getByLabelText('จำนวนหลอดเล็ก') as HTMLInputElement).value).toBe('0.5');
    for (let click = 0; click < 5; click += 1) await user.click(add);
    expect((add as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole('button', { name: 'ยืนยันน้ำแข็งละลาย' }));
    expect(onSubmit).toHaveBeenCalledWith(3);
  });
});

describe('employee stock receive', () => {
  it('receives a half bag from truck stock', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<StockTransferHarness onSubmit={onSubmit} />);

    await user.click(screen.getByRole('button', { name: 'เพิ่มหลอดเล็กอีกครึ่ง' }));

    expect((screen.getByLabelText('จำนวนหลอดเล็ก') as HTMLInputElement).value).toBe('0.5');
    await user.click(screen.getByRole('button', { name: 'ยืนยันเติมน้ำแข็ง' }));
    expect(onSubmit).toHaveBeenCalledWith(0.5);
  });
});

describe('employee stock return', () => {
  it('returns a half bag from holding stock', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<StockTransferHarness onSubmit={onSubmit} />);

    await user.click(screen.getByRole('button', { name: 'คืนขึ้นรถ' }));
    await user.click(screen.getByRole('button', { name: 'เพิ่มหลอดเล็กอีกครึ่ง' }));

    expect((screen.getByLabelText('จำนวนหลอดเล็ก') as HTMLInputElement).value).toBe('0.5');
    await user.click(screen.getByRole('button', { name: 'ยืนยันคืนของ' }));
    expect(onSubmit).toHaveBeenCalledWith(0.5);
  });

  it('accepts a half bag from the quantity input', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<StockTransferHarness onSubmit={onSubmit} />);

    await user.click(screen.getByRole('button', { name: 'คืนขึ้นรถ' }));
    const quantityInput = screen.getByLabelText('จำนวนหลอดเล็ก') as HTMLInputElement;
    await user.type(quantityInput, '0.5');

    expect(quantityInput.value).toBe('0.5');
    await user.click(screen.getByRole('button', { name: 'ยืนยันคืนของ' }));
    expect(onSubmit).toHaveBeenCalledWith(0.5);
  });
});
