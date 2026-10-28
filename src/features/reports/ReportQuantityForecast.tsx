import { useEffect, useState } from 'react';
import { CalendarBlank, Cube, Info, Confetti } from '@phosphor-icons/react';
import { translateUi, useLanguage } from '../../i18n';
import { supabase } from '../../lib/supabase';
import { shiftServiceDate } from '../../lib/serviceDate';
import { demoComparisonReport } from './demoComparisonReport';
import { formatReportDate } from './reportDates';
import { DataTable, Panel } from './ReportPrimitives';
import { forecastQuantities, forecastWindow, type ForecastHorizon, type ForecastContext } from './quantityForecast';
import type { ExecutiveReport } from './types';

const number = (value: number | null) => value === null ? '—' : new Intl.NumberFormat('th-TH', { maximumFractionDigits: 2 }).format(value);
const shortDay = (date: string) => new Intl.DateTimeFormat('th-TH', { weekday: 'short', timeZone: 'Asia/Bangkok' }).format(new Date(`${date}T12:00:00+07:00`));
const shortDate = (date: string) => new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', timeZone: 'Asia/Bangkok' }).format(new Date(`${date}T12:00:00+07:00`));

export function ReportQuantityForecast({ report, to, loading, error, demo = false }: {
  report: ExecutiveReport | null; to: string; loading: boolean; error: string | null; demo?: boolean;
}) {
  useLanguage();
  const [horizon, setHorizon] = useState<ForecastHorizon>(7);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ base: ExecutiveReport; anchor: string; data: ForecastContext | null; error: string | null } | null>(null);
  const { historyFrom, historyTo } = forecastWindow(to);

  useEffect(() => {
    setResult(null);
    setSelectedDate(null);
    if (!report || loading || error) return;
    if (demo) {
      const history = demoComparisonReport(report, { from: historyFrom, to: historyTo });
      setResult({ base: report, anchor: to, data: {
        basis: 'regular_only', dailyTrend: history.dailyTrend ?? [],
        products: report.products.map(product => ({ ...product, created_at: `${historyFrom}T00:00:00+07:00` })),
        events: [{ id: 'demo-event', name: 'งานแสดงสินค้า (ตัวอย่าง)', start: shiftServiceDate(to, 2), end: shiftServiceDate(to, 4) }],
      }, error: null });
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        if (!supabase) throw new Error('ยังไม่ได้ตั้งค่าการเชื่อมต่อ Supabase');
        const response = await supabase.rpc('get_quantity_forecast_context', { p_anchor: to });
        if (response.error) throw new Error(response.error.message);
        const data = response.data as ForecastContext | null;
        // Do not fall back to mixed event/regular history on older servers.
        if (data?.basis !== 'regular_only' || !Array.isArray(data.dailyTrend)
          || !Array.isArray(data.products) || !Array.isArray(data.events)) {
          throw new Error('ยังไม่มีข้อมูลแยกยอดปกติออกจากอีเวนต์สำหรับคาดการณ์');
        }
        if (!cancelled) setResult({ base: report, anchor: to, data, error: null });
      } catch (cause) {
        if (!cancelled) setResult({ base: report, anchor: to, data: null, error: cause instanceof Error ? cause.message : 'โหลดข้อมูลย้อนหลังไม่สำเร็จ' });
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [report, loading, error, to, historyFrom, historyTo, demo, retry]);

  const current = result?.base === report && result.anchor === to ? result : null;
  const source = !loading && !error ? current?.data : null;
  const forecast = source ? forecastQuantities(source, source.products, to, horizon) : null;
  const dayIndex = selectedDate ? forecast?.days.indexOf(selectedDate) ?? -1 : -1;
  const activeDate = dayIndex >= 0 ? selectedDate : null;
  const periodStart = activeDate ?? forecast?.days[0] ?? shiftServiceDate(to, 1);
  const periodEnd = activeDate ?? forecast?.days[forecast.days.length - 1] ?? shiftServiceDate(to, horizon);
  const events = source?.events.filter(event => event.start <= periodEnd && event.end >= periodStart) ?? [];
  const periodLabel = activeDate ? formatReportDate(activeDate) : `รวม ${horizon} วัน`;

  return <Panel title={translateUi('เตรียมน้ำแข็งล่วงหน้า')} label="คาดการณ์ปริมาณน้ำแข็ง" className="quantity-forecast"
    description={translateUi('ดูยอดปกติที่คาดว่าจะขาย แยกจากความต้องการของอีเวนต์')}
    action={<label className="quantity-forecast__horizon">{translateUi('คาดการณ์ล่วงหน้า')}
      <select value={horizon} onChange={event => { setHorizon(Number(event.target.value) as ForecastHorizon); setSelectedDate(null); }}>
        <option value={1}>{translateUi('1 วัน')}</option><option value={7}>{translateUi('7 วัน')}</option><option value={30}>{translateUi('30 วัน')}</option>
      </select></label>}>
    {demo ? <p className="executive-panel-note">{translateUi('คาดการณ์จากข้อมูลจำลอง รวมถึงอีเวนต์ตัวอย่าง')}</p> : null}
    {error ? <p role="status">{translateUi('รอโหลดรายงานสำเร็จก่อนแสดงคาดการณ์')}</p>
      : current?.error ? <p className="executive-error" role="alert">{translateUi('โหลดข้อมูลคาดการณ์ไม่สำเร็จ: ')}{current.error}{' '}
        <button type="button" onClick={() => setRetry(value => value + 1)}>{translateUi('ลองโหลดคาดการณ์ใหม่')}</button></p>
        : !source || !forecast ? <p role="status">{translateUi('กำลังโหลดข้อมูลคาดการณ์…')}</p>
          : !forecast.rows.length ? <p className="executive-empty">{translateUi('ยังไม่มีชนิดน้ำแข็งสำหรับคาดการณ์')}</p>
            : <>
              <div className="quantity-forecast__period"><CalendarBlank size={19} aria-hidden="true" />
                <span>{translateUi('ช่วงคาดการณ์')} <strong>{formatReportDate(forecast.days[0])} – {formatReportDate(forecast.days[forecast.days.length - 1])}</strong></span>
                <span className="quantity-forecast__basis">{translateUi('ตัดยอดอีเวนต์ย้อนหลังแล้ว')}</span>
              </div>
              <div className="quantity-forecast__days" role="group" aria-label={translateUi('เลือกวันคาดการณ์')}>
                <button type="button" aria-pressed={!activeDate} onClick={() => setSelectedDate(null)}>
                  <span>{translateUi('ภาพรวม')}</span><strong>{translateUi(`รวม ${horizon} วัน`)}</strong>
                </button>
                {forecast.days.map(date => <button type="button" key={date} aria-pressed={activeDate === date} onClick={() => setSelectedDate(date)}>
                  <span>{shortDay(date)}</span><strong>{shortDate(date)}</strong>
                </button>)}
              </div>
              <div className="quantity-forecast__card-heading"><h3>{translateUi('ยอดปกติที่คาดการณ์')}</h3><span>{periodLabel}</span></div>
              <div className="quantity-forecast__cards" role="list" aria-label={translateUi('สรุปคาดการณ์แยกชนิดน้ำแข็ง')}>
                {forecast.rows.map(row => <article role="listitem" className="quantity-forecast__card" key={`${row.id}:${row.unit}`} aria-label={row.name}>
                  <div className="quantity-forecast__product"><span className="quantity-forecast__icon"><Cube size={22} aria-hidden="true" /></span><h4>{row.name}</h4></div>
                  <div className="quantity-forecast__amount"><strong>{number(activeDate ? row.values[dayIndex].quantity : row.total)}</strong><span>{row.unit}</span></div>
                  <p>{row.total === null ? translateUi('ข้อมูลไม่พอ · ต้องมีอย่างน้อย 7 วัน') : activeDate ? translateUi('ประมาณการสำหรับวันนี้ที่เลือก') : translateUi(`ยอดปกติรวม ${horizon} วัน`)}</p>
                </article>)}
              </div>
              <div className={`quantity-forecast__events ${events.length ? 'quantity-forecast__events--pending' : ''}`}>
                <Confetti size={24} aria-hidden="true" />
                <div><h3>{events.length ? `${translateUi('มีอีเวนต์ในช่วงที่เลือก')} ${events.length} ${translateUi('งาน')}` : translateUi('ไม่พบอีเวนต์ที่ประกาศในช่วงที่เลือก')}</h3>
                  <p>{events.length ? translateUi('ยอดด้านบนยังไม่รวมอีเวนต์ · ต้องเพิ่มจำนวนสั่งของแต่ละงานก่อนใช้เป็นยอดเตรียมรวม')
                    : translateUi('ยอดด้านบนเป็นยอดปกติ หากมีงานเพิ่มควรเผื่อความต้องการของงานแยกต่างหาก')}</p>
                  {events.length ? <ul>{events.map(event => <li key={event.id}><strong>{event.name}</strong><span>{shortDate(event.start)} – {shortDate(event.end)}</span><span className="quantity-forecast__pending">{translateUi('ยังไม่มีจำนวนสั่ง')}</span></li>)}</ul> : null}
                </div>
              </div>
              <details className="quantity-forecast__details"><summary>{translateUi('ดูคาดการณ์รายวันแบบตาราง')}</summary>
                <DataTable label={translateUi('คาดการณ์น้ำแข็งรายวัน')}
                  headings={['วันที่', ...forecast.rows.map(row => `${row.name} (${row.unit})`)]}
                  numericColumns={forecast.rows.map((_, index) => index + 1)}>
                  {forecast.days.map((date, index) => <tr key={date}><th scope="row">{formatReportDate(date)}</th>
                    {forecast.rows.map(row => <td className="executive-numeric" key={`${row.id}:${row.unit}`}>{number(row.values[index].quantity)}</td>)}
                  </tr>)}
                </DataTable>
              </details>
              <details className="quantity-forecast__details quantity-forecast__method"><summary><Info size={17} aria-hidden="true" />{translateUi('คำนวณจากอะไร?')}</summary>
                <p>{translateUi('ใช้ยอดปกติย้อนหลัง 28 วัน ไม่รวมยอดส่งอีเวนต์')} · {formatReportDate(historyFrom)} – {formatReportDate(historyTo)}
                  {' · '}{translateUi('ไม่รวมวันนี้ที่ยังไม่จบวัน')}</p>
                <p>{translateUi('เฉลี่ยวันเดียวกันของสัปดาห์เมื่อมีอย่างน้อย 2 วันเทียบ หากไม่พอใช้ค่าเฉลี่ยรายวันที่มีข้อมูลอย่างน้อย 7 วัน · นับเฉพาะวันที่สินค้ามีอยู่แล้ว วันที่ข้อมูลหายไม่นับเป็นศูนย์')}</p>
                <DataTable label={translateUi('ข้อมูลที่ใช้คาดการณ์')} headings={['ชนิดน้ำแข็ง', 'ข้อมูลย้อนหลัง', 'วิธีคำนวณ']}>
                  {forecast.rows.map(row => <tr key={`${row.id}:${row.unit}`}><th scope="row">{row.name}</th><td>{row.observedDays} / 28 {translateUi('วัน')}</td>
                    <td>{translateUi(row.method === 'insufficient' ? 'ข้อมูลไม่พอ' : row.method === 'weekday' ? 'เฉลี่ยวันเดียวกันของสัปดาห์' : 'ค่าเฉลี่ยรายวัน')}</td></tr>)}
                </DataTable>
                <p>{translateUi('เป็นค่าประมาณ ยังไม่รวมอากาศ วันหยุด และคำสั่งซื้อในอนาคต ยังไม่ได้วัดความแม่นยำย้อนหลัง')}</p>
              </details>
            </>}
  </Panel>;
}
