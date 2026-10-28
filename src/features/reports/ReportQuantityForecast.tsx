import { useEffect, useState } from 'react';
import { translateUi, useLanguage } from '../../i18n';
import { supabase } from '../../lib/supabase';
import { demoComparisonReport } from './demoComparisonReport';
import { formatReportDate } from './reportDates';
import { DataTable, Panel } from './ReportPrimitives';
import { forecastQuantities, forecastWindow, type ForecastHorizon, type ForecastProduct } from './quantityForecast';
import type { ExecutiveReport } from './types';

const number = (value: number | null) => value === null ? '—' : new Intl.NumberFormat('th-TH', { maximumFractionDigits: 2 }).format(value);

export function ReportQuantityForecast({ report, to, loading, error, demo = false }: {
  report: ExecutiveReport | null; to: string; loading: boolean; error: string | null; demo?: boolean;
}) {
  useLanguage();
  const [horizon, setHorizon] = useState<ForecastHorizon>(7);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ base: ExecutiveReport; data: ExecutiveReport | null; products: ForecastProduct[]; error: string | null } | null>(null);
  const { historyFrom, historyTo } = forecastWindow(to);
  const reuse = report && report.from <= historyFrom && report.to >= historyTo;

  useEffect(() => {
    setResult(null);
    if (!report || loading || error) return;
    if (demo) {
      setResult({ base: report, data: reuse ? report : demoComparisonReport(report, { from: historyFrom, to: historyTo }),
        products: report.products.map(product => ({ ...product, created_at: `${historyFrom}T00:00:00+07:00` })), error: null });
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        if (!supabase) throw new Error('ยังไม่ได้ตั้งค่าการเชื่อมต่อ Supabase');
        const [history, catalog] = await Promise.all([
          reuse ? Promise.resolve({ data: report, error: null })
            : supabase.rpc('get_executive_report', { p_from: historyFrom, p_to: historyTo }),
          supabase.from('ice_types').select('id, name, unit, created_at').eq('is_active', true).order('name').order('id'),
        ]);
        if (history.error) throw new Error(history.error.message);
        if (catalog.error) throw new Error(catalog.error.message);
        if (!history.data) throw new Error('ไม่พบข้อมูลย้อนหลัง');
        if (!catalog.data) throw new Error('ไม่พบข้อมูลชนิดน้ำแข็ง');
        if (!cancelled) setResult({ base: report, data: history.data as ExecutiveReport,
          products: catalog.data as ForecastProduct[], error: null });
      } catch (cause) {
        if (!cancelled) setResult({ base: report, data: null, products: [], error: cause instanceof Error ? cause.message : 'โหลดข้อมูลย้อนหลังไม่สำเร็จ' });
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [report, loading, error, reuse, historyFrom, historyTo, demo, retry]);

  const current = result?.base === report ? result : null;
  const source = !loading && !error ? current?.data : null;
  const forecast = source?.dailyTrend ? forecastQuantities(source, current?.products ?? [], to, horizon) : null;

  return <Panel title={translateUi('คาดการณ์ปริมาณน้ำแข็ง')} className="quantity-forecast"
    description={`${translateUi('คาดการณ์หลังวันที่')} ${formatReportDate(to)} · ${translateUi('แยกตามชนิดและหน่วย')}`}
    action={<label className="quantity-forecast__horizon">{translateUi('คาดการณ์ล่วงหน้า')}
      <select value={horizon} onChange={event => setHorizon(Number(event.target.value) as ForecastHorizon)}>
        <option value={1}>{translateUi('1 วัน')}</option><option value={7}>{translateUi('7 วัน')}</option><option value={30}>{translateUi('30 วัน')}</option>
      </select></label>}>
    <p className="executive-panel-note">{translateUi('ใช้ข้อมูลย้อนหลัง 28 วัน')} · {formatReportDate(historyFrom)} – {formatReportDate(historyTo)}
      {' · '}{translateUi('ไม่รวมวันนี้ที่ยังไม่จบวัน')}</p>
    {demo ? <p className="executive-panel-note">{translateUi('คาดการณ์จากข้อมูลจำลอง')}</p> : null}
    {error ? <p role="status">{translateUi('รอโหลดรายงานสำเร็จก่อนแสดงคาดการณ์')}</p>
      : current?.error ? <p className="executive-error" role="alert">{translateUi('โหลดข้อมูลคาดการณ์ไม่สำเร็จ: ')}{current.error}{' '}
        <button type="button" onClick={() => setRetry(value => value + 1)}>{translateUi('ลองโหลดคาดการณ์ใหม่')}</button></p>
        : !source ? <p role="status">{translateUi('กำลังโหลดข้อมูลคาดการณ์…')}</p>
          : !forecast ? <p role="status">{translateUi('ยังไม่มีข้อมูลรายวันสำหรับคาดการณ์')}</p>
            : !forecast.rows.length ? <p className="executive-empty">{translateUi('ยังไม่มีชนิดน้ำแข็งสำหรับคาดการณ์')}</p>
              : <>
                <p className="quantity-forecast__period">{translateUi('ช่วงคาดการณ์')} <strong>{formatReportDate(forecast.days[0])} – {formatReportDate(forecast.days[forecast.days.length - 1])}</strong></p>
                <DataTable label={translateUi('สรุปคาดการณ์แยกชนิดน้ำแข็ง')}
                  headings={['ชนิดน้ำแข็ง', 'หน่วย', 'วันแรก', `รวม ${horizon} วัน`, 'ข้อมูลย้อนหลัง', 'วิธีคำนวณ']} numericColumns={[2, 3]}>
                  {forecast.rows.map(row => <tr key={`${row.id}:${row.unit}`}>
                    <th scope="row">{row.name}</th><td>{row.unit}</td>
                    <td className="executive-numeric">{number(row.values[0].quantity)}</td><td className="executive-numeric"><strong>{number(row.total)}</strong></td>
                    <td>{row.observedDays} / 28 {translateUi('วัน')}</td>
                    <td>{translateUi(row.method === 'insufficient' ? 'ข้อมูลไม่พอ (ต้องมีอย่างน้อย 7 วัน)' : row.method === 'weekday' ? 'เฉลี่ยวันเดียวกันของสัปดาห์' : 'ใช้ค่าเฉลี่ยรายวันเมื่อวันเทียบไม่พอ')}</td>
                  </tr>)}
                </DataTable>
                <details className="quantity-forecast__details"><summary>{translateUi('ดูคาดการณ์รายวัน')}</summary>
                  <DataTable label={translateUi('คาดการณ์น้ำแข็งรายวัน')}
                    headings={['วันที่', ...forecast.rows.map(row => `${row.name} (${row.unit})`)]}
                    numericColumns={forecast.rows.map((_, index) => index + 1)}>
                    {forecast.days.map((date, index) => <tr key={date}><th scope="row">{formatReportDate(date)}</th>
                      {forecast.rows.map(row => <td className="executive-numeric" key={`${row.id}:${row.unit}`}>{number(row.values[index].quantity)}</td>)}
                    </tr>)}
                  </DataTable>
                </details>
                <p className="executive-panel-note quantity-forecast__method">{translateUi('เฉลี่ยวันเดียวกันของสัปดาห์เมื่อมีอย่างน้อย 2 วันเทียบ หากไม่พอใช้ค่าเฉลี่ยรายวันที่มีข้อมูลอย่างน้อย 7 วัน · นับเฉพาะวันที่สินค้ามีอยู่แล้ว วันที่ข้อมูลหายไม่นับเป็นศูนย์')}
                  <br />{translateUi('เป็นค่าประมาณจากยอดขายย้อนหลัง ยังไม่รวมแผนอีเวนต์ วันหยุด หรือการเปลี่ยนแปลงคำสั่งซื้อในอนาคต')}</p>
              </>}
  </Panel>;
}
