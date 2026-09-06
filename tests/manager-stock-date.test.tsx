import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const refs = vi.hoisted(() => ({ loadReferenceData: vi.fn(), setSelectedRoundId: vi.fn() }));
vi.mock('../src/hooks/useReferenceData', () => ({ useReferenceData: () => ({
  ...refs, rounds: [], selectedRoundId: '', loadingRounds: false, workspaceError: null,
}) }));
vi.mock('../src/ManagerStockControl', () => ({ ManagerStockControl: ({ serviceDate }: { serviceDate: string }) => <span data-testid="stock-date">{serviceDate}</span> }));
vi.mock('../src/ManagerRoundControl', () => ({ ManagerRoundControl: () => null }));
import { RoundWorkspace } from '../src/RoundWorkspace';
afterEach(() => vi.useRealTimers());

it('uses Bangkok business dates and rolls an already-mounted workspace forward on focus', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date('2026-09-06T16:59:00Z'));
  render(<RoundWorkspace isActive />);
  expect(screen.getByTestId('stock-date').textContent).toBe('2026-09-06');
  vi.setSystemTime(new Date('2026-09-06T17:01:00Z'));
  await act(async () => { fireEvent(window, new Event('focus')); });
  expect(screen.getByTestId('stock-date').textContent).toBe('2026-09-07');
});
