import { Profiler, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EmployeeShopPicker } from '../../src/features/employee-delivery/EmployeeShopPicker';
import type { ShopCard } from '../../src/types/app';
import '../../src/index.css';

const cards: ShopCard[] = Array.from({ length: 500 }, (_, i) => ({
  round_stop_id: `stop-${i}`, shop_id: `shop-${i}`, shop_code: `S${i}`,
  shop_name: `ร้านทดสอบ ${i}`, building_id: 'b', building_name: 'ตึก A', floor_or_zone: '1',
  sequence_no: i, image_path: null, image_url: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#c5e6ee"/><text x="30" y="90" font-size="28">SHOP</text></svg>'),
  payment_status: 'unpaid', stop_status: 'pending', stop_note: null, today_history: [], today_totals: {},
}));
const noop = () => {};
const props = {
  casualCustomerButtonRef: { current: null }, casualCustomerEntryVisible: false,
  enableAssignedStockFlow: false, selectedRoundId: 'r', setQuery: noop,
  selectedBuildingId: '', setSelectedBuildingId: noop, buildingOptions: [],
  selectedZone: '', setSelectedZone: noop, zoneOptions: [], destinationKind: 'regular' as const,
  setDestinationKind: noop, selectedEventJobId: '', setSelectedEventJobId: noop, eventOptions: [],
  loadingCards: false, collectionOutstanding: {}, eventCardsError: null, filteredCards: cards,
  refreshShopImageUrl: async (card: ShopCard) => card.image_url,
  openCasualCustomer: noop, stockState: null, shopButtonRefs: { current: new Map() },
};
const timings: string[] = [];
function Fixture() {
  const [scrollResult, setScrollResult] = useState('');
  const runScroll = () => {
    setScrollResult('กำลังทดสอบ');
    const frames: number[] = [];
    let previous = 0;
    const step = (now: number) => {
      if (previous) frames.push(now - previous);
      previous = now;
      window.scrollTo(0, frames.length * 100);
      if (frames.length < 120) requestAnimationFrame(step);
      else {
        const sorted = [...frames].sort((a, b) => a - b);
        setScrollResult(`120 frames; p95 ${sorted[113].toFixed(1)} ms; >25 ms: ${frames.filter(ms => ms > 25).length}`);
        window.scrollTo(0, 0);
      }
    };
    requestAnimationFrame(step);
  };
  const [selected, setSelected] = useState<ShopCard | null>(null);
  return <main style={{ maxWidth: 700, margin: 'auto', padding: 16 }}>
    <h1>รายการจำลอง 500 ร้าน</h1>
    <p>Local fixture only — no database. React development render timing, not Android FPS.</p>
    <button onClick={runScroll}>ทดสอบเลื่อน 120 เฟรม</button><p id="scroll-result">{scrollResult}</p>
    <output id="timing" style={{ position: 'fixed', top: 0, right: 0, zIndex: 999, background: 'white' }} />
    {selected ? <button onClick={() => setSelected(null)}>กลับรายการร้าน</button> : <Profiler id="picker" onRender={(_id, phase, actualDuration) => {
      timings.push(`${phase}: ${actualDuration.toFixed(1)} ms`);
      document.getElementById('timing')!.textContent = timings.slice(-8).join(' | ');
    }}><EmployeeShopPicker {...props} query="" openCard={setSelected} /></Profiler>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
