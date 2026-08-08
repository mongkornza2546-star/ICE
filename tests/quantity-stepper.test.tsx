import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QuantityStepper } from '../src/features/employee-delivery/QuantityStepper';

describe('QuantityStepper', () => {
  it('keeps only digits when a quantity is typed or pasted', () => {
    const onChange = vi.fn();
    render(
      <QuantityStepper
        disabled={false}
        iceTypeName="หลอดเล็ก"
        onChange={onChange}
        purpose="รับเพิ่ม"
        quantity={10}
      />,
    );

    fireEvent.change(screen.getByRole('textbox', { name: 'จำนวนหลอดเล็ก' }), {
      target: { value: '12abc3' },
    });

    expect(onChange).toHaveBeenLastCalledWith(113);
  });
});
