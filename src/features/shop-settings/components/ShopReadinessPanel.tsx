import { useEffect, useState } from 'react';
import { CheckCircle, ArrowClockwise } from '@phosphor-icons/react';
import type { POSReadinessReport } from '../../../types/app';
import { loadPOSReadinessReport, getErrorMessage } from '../../admin-reference-settings/adminReferenceSettingsService';

export function ShopReadinessPanel() {
  const [report, setReport] = useState<POSReadinessReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterMode, setFilterMode] = useState<'all' | 'issues'>('issues');

  useEffect(() => {
    void refreshReport();
  }, []);

  async function refreshReport() {
    setLoading(true);
    setError(null);
    try {
      const data = await loadPOSReadinessReport();
      setReport(data);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <p className="empty-text">กำลังตรวจสอบความพร้อมของระบบการเงินและราคา...</p>;
  if (error) return <p className="error-text">{error}</p>;
  if (!report) return null;

  const filteredItems = report.items.filter((item) => {
    if (filterMode === 'issues') return item.has_issues;
    return true;
  });

  const isSystemReady = report.shops_ready_count === report.total_active_shops && report.ice_types_missing_standard_price === 0;

  return (
    <section className="panel readiness-panel" style={{ marginTop: '1.5rem' }}>
      <div className="panel-header">
        <div>
          <p className="eyebrow">ตรวจสอบความพร้อม (POS Readiness Report)</p>
          <h2>สถานะความพร้อมก่อนเปิดใช้ POS การเงิน</h2>
        </div>
        <button className="ghost-button" onClick={() => void refreshReport()} type="button">
          <ArrowClockwise size={18} /> รีเฟรชข้อมูล
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
        <div style={{ padding: '1rem', background: 'var(--panel-bg, #f5f5f5)', borderRadius: '8px' }}>
          <p style={{ margin: 0, color: 'var(--muted-text, #666)' }}>ร้านค้าพร้อมใช้งาน</p>
          <strong style={{ fontSize: '1.5rem', color: isSystemReady ? 'green' : 'inherit' }}>
            {report.shops_ready_count} / {report.total_active_shops}
          </strong>
        </div>

        <div style={{ padding: '1rem', background: 'var(--panel-bg, #f5f5f5)', borderRadius: '8px' }}>
          <p style={{ margin: 0, color: 'var(--muted-text, #666)' }}>ร้านที่ยังไม่มี Payment Profile</p>
          <strong style={{ fontSize: '1.5rem', color: report.shops_missing_payment_profile > 0 ? 'red' : 'inherit' }}>
            {report.shops_missing_payment_profile}
          </strong>
        </div>

        <div style={{ padding: '1rem', background: 'var(--panel-bg, #f5f5f5)', borderRadius: '8px' }}>
          <p style={{ margin: 0, color: 'var(--muted-text, #666)' }}>ชนิดน้ำแข็งที่ขาดราคากลางวันนี้</p>
          <strong style={{ fontSize: '1.5rem', color: report.ice_types_missing_standard_price > 0 ? 'red' : 'inherit' }}>
            {report.ice_types_missing_standard_price}
          </strong>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            className={`shop-filter-button ${filterMode === 'issues' ? 'shop-filter-button--active' : ''}`}
            onClick={() => setFilterMode('issues')}
            type="button"
          >
            แสดงเฉพาะร้านที่มีปัญหา ({report.items.filter((i) => i.has_issues).length})
          </button>
          <button
            className={`shop-filter-button ${filterMode === 'all' ? 'shop-filter-button--active' : ''}`}
            onClick={() => setFilterMode('all')}
            type="button"
          >
            แสดงทั้งหมด ({report.total_active_shops})
          </button>
        </div>
      </div>

      {filteredItems.length === 0 ? (
        <div className="success-text" style={{ padding: '1.5rem', background: '#e8f5e9', borderRadius: '8px', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <CheckCircle size={24} weight="fill" />
          <span>ทุกร้านค้าและสินค้าพร้อมสำหรับการเปิดใช้งาน POS การเงินเรียบร้อยแล้ว!</span>
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>รหัสร้าน</th>
              <th>ชื่อร้าน</th>
              <th>ตึก/โซน</th>
              <th>Payment Profile</th>
              <th>รายการที่ต้องตั้งค่าเพิ่มเติม</th>
            </tr>
          </thead>
          <tbody>
            {filteredItems.map((item) => (
              <tr key={item.shop_id}>
                <td><strong>{item.shop_code}</strong></td>
                <td>{item.shop_name}</td>
                <td>{item.building_name} · {item.zone_name}</td>
                <td>
                  {item.has_payment_profile ? (
                    <span className="reference-pill reference-pill--green">มีแล้ว</span>
                  ) : (
                    <span className="reference-pill reference-pill--gray">ยังไม่มี</span>
                  )}
                </td>
                <td>
                  {item.issue_details.map((issue, idx) => (
                    <span key={idx} className="error-text" style={{ display: 'block', fontSize: '0.875rem' }}>
                      • {issue}
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
