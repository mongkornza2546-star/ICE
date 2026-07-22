import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RoundWorkspace } from '../src/RoundWorkspace';

const mocks = vi.hoisted(() => ({
  loadReferenceData: vi.fn(async () => undefined),
}));

vi.mock('../src/hooks/useReferenceData', () => ({
  useReferenceData: () => ({
    rounds: [],
    selectedRoundId: '',
    setSelectedRoundId: vi.fn(),
    loadingRounds: false,
    workspaceError: null,
    loadReferenceData: mocks.loadReferenceData,
  }),
}));

vi.mock('../src/ManagerRoundControl', () => ({
  ManagerRoundControl: () => null,
}));

vi.mock('../src/ManagerStockControl', () => ({
  ManagerStockControl: () => null,
}));

describe('RoundWorkspace keep-alive refresh', () => {
  it('reloads round data whenever the stock view becomes active', async () => {
    const { rerender } = render(<RoundWorkspace isActive />);
    await waitFor(() => expect(mocks.loadReferenceData).toHaveBeenCalledTimes(1));

    rerender(<RoundWorkspace isActive={false} />);
    expect(mocks.loadReferenceData).toHaveBeenCalledTimes(1);

    rerender(<RoundWorkspace isActive />);
    await waitFor(() => expect(mocks.loadReferenceData).toHaveBeenCalledTimes(2));
  });
});
