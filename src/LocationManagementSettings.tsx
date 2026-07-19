import { useRef, useState, type KeyboardEvent } from 'react';
import { LocationSettings } from './LocationSettings';
import { StockLocationSettings } from './StockLocationSettings';

type LocationTab = 'buildings' | 'stock_locations';

export function LocationManagementSettings({ canManageBuildings }: { canManageBuildings: boolean }) {
  const initialTab: LocationTab = canManageBuildings ? 'buildings' : 'stock_locations';
  const [activeTab, setActiveTab] = useState<LocationTab>(initialTab);
  const [visitedTabs, setVisitedTabs] = useState<ReadonlySet<LocationTab>>(() => new Set([initialTab]));
  const buildingsTabRef = useRef<HTMLButtonElement>(null);
  const stockLocationsTabRef = useRef<HTMLButtonElement>(null);
  const availableTabs: LocationTab[] = canManageBuildings ? ['buildings', 'stock_locations'] : ['stock_locations'];

  const activateTab = (tab: LocationTab, moveFocus = false) => {
    setActiveTab(tab);
    setVisitedTabs((current) => current.has(tab) ? current : new Set([...current, tab]));
    if (moveFocus) {
      (tab === 'buildings' ? buildingsTabRef : stockLocationsTabRef).current?.focus();
    }
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = availableTabs.indexOf(activeTab);
    let nextIndex: number | null = null;

    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % availableTabs.length;
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + availableTabs.length) % availableTabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = availableTabs.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    activateTab(availableTabs[nextIndex], true);
  };

  return (
    <div className="location-management-settings">
      <div className="settings-page-heading">
        <div>
          <p className="eyebrow">ตั้งค่าสถานที่</p>
          <h1>สถานที่และจุดถือครอง</h1>
          <p className="muted">จัดการตึก โซนย่อย และจุดถือครองสต๊อกที่เกี่ยวข้องจากหน้าเดียวกัน</p>
        </div>
      </div>

      <div aria-label="หมวดการตั้งค่าสถานที่" className="settings-tabs" role="tablist">
        {canManageBuildings ? (
          <button
            aria-controls="buildings-and-zones-panel"
            aria-selected={activeTab === 'buildings'}
            className={`settings-tab ${activeTab === 'buildings' ? 'settings-tab--active' : ''}`}
            id="buildings-and-zones-tab"
            onClick={() => activateTab('buildings')}
            onKeyDown={handleTabKeyDown}
            ref={buildingsTabRef}
            role="tab"
            tabIndex={activeTab === 'buildings' ? 0 : -1}
            type="button"
          >
            ตึก / โซน
          </button>
        ) : null}
        <button
          aria-controls="stock-locations-panel"
          aria-selected={activeTab === 'stock_locations'}
          className={`settings-tab ${activeTab === 'stock_locations' ? 'settings-tab--active' : ''}`}
          id="stock-locations-tab"
          onClick={() => activateTab('stock_locations')}
          onKeyDown={handleTabKeyDown}
          ref={stockLocationsTabRef}
          role="tab"
          tabIndex={activeTab === 'stock_locations' ? 0 : -1}
          type="button"
        >
          จุดถือครองสต๊อก
        </button>
      </div>

      {canManageBuildings ? (
        <div aria-labelledby="buildings-and-zones-tab" hidden={activeTab !== 'buildings'} id="buildings-and-zones-panel" role="tabpanel">
          {visitedTabs.has('buildings') ? <LocationSettings /> : null}
        </div>
      ) : null}
      <div aria-labelledby="stock-locations-tab" hidden={activeTab !== 'stock_locations'} id="stock-locations-panel" role="tabpanel">
        {visitedTabs.has('stock_locations') ? <StockLocationSettings /> : null}
      </div>
    </div>
  );
}
