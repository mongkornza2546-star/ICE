import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocationManagementSettings } from '../src/LocationManagementSettings';

const mounts = vi.hoisted(() => ({
  buildings: vi.fn(),
  stockLocations: vi.fn(),
}));

vi.mock('../src/LocationSettings', async () => {
  const { useEffect, useState } = await import('react');

  return {
    LocationSettings: () => {
      const [name, setName] = useState('');
      useEffect(() => mounts.buildings(), []);
      return <label>Building draft<input value={name} onChange={(event) => setName(event.target.value)} /></label>;
    },
  };
});

vi.mock('../src/StockLocationSettings', async () => {
  const { useEffect } = await import('react');

  return {
    StockLocationSettings: () => {
      useEffect(() => mounts.stockLocations(), []);
      return <p>Stock location settings</p>;
    },
  };
});

describe('LocationManagementSettings', () => {
  beforeEach(() => {
    mounts.buildings.mockClear();
    mounts.stockLocations.mockClear();
  });

  it('shows both tabs to admins and mounts each panel only after its first visit', async () => {
    const user = userEvent.setup();
    render(<LocationManagementSettings canManageBuildings />);

    const buildingsTab = screen.getByRole('tab', { name: 'ตึก / โซน' });
    const stockLocationsTab = screen.getByRole('tab', { name: 'จุดถือครองสต๊อก' });

    expect(buildingsTab.getAttribute('aria-selected')).toBe('true');
    expect(buildingsTab.tabIndex).toBe(0);
    expect(stockLocationsTab.getAttribute('aria-selected')).toBe('false');
    expect(stockLocationsTab.tabIndex).toBe(-1);
    expect(mounts.buildings).toHaveBeenCalledTimes(1);
    expect(mounts.stockLocations).not.toHaveBeenCalled();
    expect(document.getElementById('stock-locations-panel')?.hidden).toBe(true);
    expect(screen.queryByText('Stock location settings')).toBeNull();

    const buildingDraft = screen.getByRole('textbox', { name: 'Building draft' });
    await user.type(buildingDraft, 'Tower A');
    await user.click(stockLocationsTab);

    expect(stockLocationsTab.getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById('buildings-and-zones-panel')?.hidden).toBe(true);
    expect(screen.getByRole('tabpanel', { name: 'จุดถือครองสต๊อก' }).hidden).toBe(false);
    expect(mounts.stockLocations).toHaveBeenCalledTimes(1);

    await user.click(buildingsTab);
    expect((screen.getByRole('textbox', { name: 'Building draft' }) as HTMLInputElement).value).toBe('Tower A');
    expect(mounts.buildings).toHaveBeenCalledTimes(1);
    expect(mounts.stockLocations).toHaveBeenCalledTimes(1);
  });

  it('supports arrow, Home, and End keys with roving focus', async () => {
    const user = userEvent.setup();
    render(<LocationManagementSettings canManageBuildings />);

    const buildingsTab = screen.getByRole('tab', { name: 'ตึก / โซน' });
    const stockLocationsTab = screen.getByRole('tab', { name: 'จุดถือครองสต๊อก' });

    buildingsTab.focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(stockLocationsTab);
    expect(stockLocationsTab.getAttribute('aria-selected')).toBe('true');
    expect(buildingsTab.tabIndex).toBe(-1);

    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(buildingsTab);
    expect(buildingsTab.getAttribute('aria-selected')).toBe('true');

    await user.keyboard('{End}');
    expect(document.activeElement).toBe(stockLocationsTab);
    expect(stockLocationsTab.getAttribute('aria-selected')).toBe('true');

    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(buildingsTab);
    expect(buildingsTab.getAttribute('aria-selected')).toBe('true');
  });

  it('shows round leads only the active stock-location tab and panel', () => {
    render(<LocationManagementSettings canManageBuildings={false} />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(1);
    expect(tabs[0].textContent).toContain('จุดถือครองสต๊อก');
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs[0].tabIndex).toBe(0);
    expect(screen.queryByRole('tab', { name: 'ตึก / โซน' })).toBeNull();
    expect(screen.getByRole('tabpanel', { name: 'จุดถือครองสต๊อก' }).hidden).toBe(false);
    expect(mounts.buildings).not.toHaveBeenCalled();
    expect(mounts.stockLocations).toHaveBeenCalledTimes(1);
  });
});
