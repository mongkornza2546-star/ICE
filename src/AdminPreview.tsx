import { useMemo, useState } from 'react';
import {
  ArrowRight,
  Buildings,
  Check,
  Clock,
  Cube,
  MapPin,
  Package,
  Plus,
  Storefront,
  Truck,
  UsersThree,
  Warning,
} from '@phosphor-icons/react';
import { AdminLayout, type AdminView } from './AdminLayout';

const rounds = [
  { name: 'รอบที่ 1', time: '06:00 – 07:30', status: 'closed', delivered: 41, total: 43 },
  { name: 'รอบที่ 2', time: '08:30 – 10:00', status: 'active', delivered: 30, total: 36 },
  { name: 'รอบที่ 3', time: '11:00 – 12:30', status: 'waiting', delivered: 0, total: 36 },
  { name: 'รอบที่ 4', time: '13:30 – 15:00', status: 'waiting', delivered: 0, total: 36 },
  { name: 'รอบที่ 5', time: '16:00 – 17:30', status: 'waiting', delivered: 0, total: 36 },
] as const;

const buildings = [
  { name: 'Skywalk', delivered: 18, pending: 3, issue: 1, color: 'blue' },
  { name: 'ตึก A', delivered: 8, pending: 2, issue: 2, color: 'green' },
  { name: 'ตึก B', delivered: 6, pending: 1, issue: 1, color: 'orange' },
  { name: 'ตึก C', delivered: 4, pending: 0, issue: 3, color: 'purple' },
] as const;

const shops = [
  { name: 'ร้านกาแฟ Skywalk', area: 'Skywalk · ฝั่งเหนือ', amount: 250, status: 'ส่งแล้ว', tone: 'success' },
  { name: 'ร้านสวัสดิการ A', area: 'ตึก A · ชั้น 1', amount: 180, status: 'ส่งแล้ว', tone: 'success' },
  { name: 'ร้านเครื่องดื่ม B', area: 'ตึก B · โดม 2', amount: 60, status: 'รอส่ง', tone: 'warning' },
  { name: 'ร้านอาหาร C-2', area: 'ตึก C · ชั้น 1', amount: 90, status: 'ยังไม่ได้ส่ง', tone: 'danger' },
  { name: 'ร้านเบเกอรี่ B', area: 'ตึก B · โดม 3', amount: 70, status: 'ส่งไม่ได้', tone: 'danger' },
] as const;

export function AdminPreview() {
  const [activeView, setActiveView] = useState<AdminView>('manager');
  const [selectedRound, setSelectedRound] = useState(1);
  const [showRoundForm, setShowRoundForm] = useState(false);
  const [toast, setToast] = useState('');
  const selected = rounds[selectedRound];
  const progress = useMemo(() => Math.round((selected.delivered / selected.total) * 100), [selected]);

  return (
    <AdminLayout
      activeView={activeView}
      allowedViews={['manager', 'delivery', 'locations', 'shops']}
      onNavigate={setActiveView}
      profileLabel="Admin"
    >
      {activeView !== 'manager' ? (
        <PreviewPlaceholder activeView={activeView} onBack={() => setActiveView('manager')} />
      ) : (
        <>
          <div className="page-actions">
            <div>
              <p className="section-kicker">การส่งวันนี้</p>
              <h2>สถานะรอบส่ง</h2>
            </div>
            <div className="page-actions__buttons">
              <button className="secondary-button" onClick={() => setToast('รีเฟรชข้อมูลล่าสุดแล้ว')} type="button">
                รีเฟรชข้อมูล
              </button>
              <button className="primary-button" onClick={() => setShowRoundForm(true)} type="button">
                <Plus size={18} weight="bold" /> เปิดรอบใหม่
              </button>
            </div>
          </div>

          <section className="round-overview-grid" aria-label="รอบส่งประจำวัน">
            {rounds.map((round, index) => {
              const percent = Math.round((round.delivered / round.total) * 100);
              return (
                <button
                  className={`round-overview-card ${selectedRound === index ? 'round-overview-card--active' : ''}`}
                  key={round.name}
                  onClick={() => setSelectedRound(index)}
                  type="button"
                >
                  <div className="round-overview-card__top">
                    <strong>{round.name}</strong>
                    <span className={`status-badge status-badge--${round.status === 'closed' ? 'success' : round.status === 'active' ? 'info' : 'neutral'}`}>
                      {round.status === 'closed' ? 'เสร็จสิ้น' : round.status === 'active' ? 'กำลังส่ง' : 'รอเริ่ม'}
                    </span>
                  </div>
                  <small>{round.time}</small>
                  <p>ส่งแล้ว <strong>{round.delivered}</strong> ร้าน <span>· ยังไม่ได้ส่ง {round.total - round.delivered} ร้าน</span></p>
                  <span className="progress-track"><i style={{ width: `${percent}%` }} /></span>
                  <b>{percent}%</b>
                </button>
              );
            })}
          </section>

          <div className="manager-grid">
            <section className="panel manager-summary">
              <div className="panel-header">
                <div>
                  <p className="section-kicker">{selected.name} · {selected.time}</p>
                  <h2>สรุปตามอาคารและโซน</h2>
                </div>
                <span className="status-badge status-badge--info"><Clock size={15} /> กำลังส่ง {progress}%</span>
              </div>
              <div className="metric-grid">
                <Metric icon={<Storefront />} label="ร้านทั้งหมด" value={selected.total} />
                <Metric icon={<Check />} label="ส่งแล้ว" value={selected.delivered} tone="success" />
                <Metric icon={<Clock />} label="รอดำเนินการ" value={selected.total - selected.delivered} tone="warning" />
                <Metric icon={<Warning />} label="มีปัญหา" value={7} tone="danger" />
              </div>
              <div className="building-grid">
                {buildings.map((building) => (
                  <article className={`building-card building-card--${building.color}`} key={building.name}>
                    <div className="building-card__title"><Buildings size={21} weight="fill" /><strong>{building.name}</strong><span>{building.delivered + building.pending + building.issue} ร้าน</span></div>
                    <dl>
                      <div><dt>ส่งแล้ว</dt><dd>{building.delivered}</dd></div>
                      <div><dt>รอส่ง</dt><dd>{building.pending}</dd></div>
                      <div><dt>มีปัญหา</dt><dd>{building.issue}</dd></div>
                    </dl>
                  </article>
                ))}
              </div>
            </section>

            <aside className="panel operations-panel">
              <div className="panel-header"><div><p className="section-kicker">ทีมปฏิบัติงาน</p><h2>สต๊อกระหว่างส่ง</h2></div></div>
              <OperationTeam icon={<Truck weight="fill" />} name="Truck Team" stock="2,850 ถุง" update="อัปเดต 09:18" />
              <OperationTeam icon={<UsersThree weight="fill" />} name="ทีมตึก B" stock="1,120 ถุง" update="อัปเดต 09:16" tone="purple" />
              <OperationTeam icon={<Package weight="fill" />} name="รถเล็กไปตึก C" stock="480 ถุง" update="อัปเดต 09:20" tone="pink" />
            </aside>
          </div>

          <section className="panel delivery-table-panel">
            <div className="panel-header">
              <div><p className="section-kicker">ภาพรวมร้านในรอบนี้</p><h2>รายการส่งล่าสุด</h2></div>
              <button className="text-button" onClick={() => setActiveView('delivery')} type="button">ดูบัตรร้านทั้งหมด <ArrowRight /></button>
            </div>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead><tr><th>ร้านค้า</th><th>อาคาร / โซน</th><th>จุดสต๊อกต้นทาง</th><th>จำนวนคิดเงิน</th><th>สถานะ</th><th>บันทึกล่าสุด</th></tr></thead>
                <tbody>
                  {shops.map((shop) => (
                    <tr key={shop.name}><td><strong>{shop.name}</strong></td><td>{shop.area}</td><td>{shop.area.split(' · ')[0]}</td><td>{shop.amount} ถุง</td><td><span className={`status-badge status-badge--${shop.tone}`}>{shop.status}</span></td><td>09:{10 + shop.amount % 19} โดย Truck Team</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {showRoundForm ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowRoundForm(false)}>
          <section className="modal-card" aria-modal="true" role="dialog" onMouseDown={(event) => event.stopPropagation()}>
            <div className="panel-header"><div><p className="section-kicker">รอบส่งประจำวัน</p><h2>เปิดรอบใหม่</h2></div><button className="icon-button" onClick={() => setShowRoundForm(false)} type="button">×</button></div>
            <label>ชื่อรอบ<input defaultValue="รอบเพิ่ม" /></label>
            <div className="field-grid"><label>เวลาเริ่ม<input type="time" defaultValue="18:00" /></label><label>วันที่ให้บริการ<input type="date" defaultValue="2026-07-14" /></label></div>
            <p className="info-note">ร้านที่เปิดใช้งานทั้งหมดจะถูกเพิ่มในรอบ พนักงานเลือกร้านที่จะไปส่งเองตามหน้างาน</p>
            <div className="modal-actions"><button className="secondary-button" onClick={() => setShowRoundForm(false)} type="button">ยกเลิก</button><button className="primary-button" onClick={() => { setShowRoundForm(false); setToast('สร้างรอบเพิ่มในพรีวิวแล้ว'); }} type="button">ยืนยันเปิดรอบ</button></div>
          </section>
        </div>
      ) : null}
      {toast ? <button className="toast" onClick={() => setToast('')} type="button"><Check weight="bold" />{toast}</button> : null}
    </AdminLayout>
  );
}

function Metric({ icon, label, value, tone = 'blue' }: { icon: React.ReactNode; label: string; value: number; tone?: string }) {
  return <div className={`metric-card metric-card--${tone}`}><span className="metric-icon">{icon}</span><div><small>{label}</small><strong>{value}</strong><span>ร้าน</span></div></div>;
}

function OperationTeam({ icon, name, stock, update, tone = 'blue' }: { icon: React.ReactNode; name: string; stock: string; update: string; tone?: string }) {
  return <article className={`operation-team operation-team--${tone}`}><span className="operation-team__icon">{icon}</span><div><strong>{name}</strong><small>{update}</small></div><b>{stock}</b></article>;
}

function PreviewPlaceholder({ activeView, onBack }: { activeView: AdminView; onBack: () => void }) {
  const copy: Record<Exclude<AdminView, 'manager'>, { title: string; description: string; icon: React.ReactNode }> = {
    delivery: { title: 'บัตรร้านและบันทึกส่ง', description: 'หน้าจริงใช้บัตรร้านจาก get_round_shop_cards และบันทึกผ่าน record_delivery', icon: <Cube /> },
    locations: { title: 'ตึกและโซนย่อย', description: 'หน้าจริงจัดการข้อมูลหลักตามลำดับ ตึก → โซนย่อย → ร้าน', icon: <MapPin /> },
    shops: { title: 'ร้านค้า', description: 'หน้าจริงค้นหา เพิ่ม และแก้ไขร้านผ่าน RPC save_shop แบบ transaction เดียว', icon: <Storefront /> },
  };
  const current = copy[activeView as Exclude<AdminView, 'manager'>];
  return <section className="panel preview-placeholder"><span>{current.icon}</span><p className="section-kicker">พรีวิวเมนู</p><h2>{current.title}</h2><p>{current.description}</p><button className="primary-button" onClick={onBack} type="button">กลับไปควบคุมรอบส่ง</button></section>;
}

