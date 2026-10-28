import { useEffect, useRef } from 'react';
import { translateUi } from '../../i18n';
import { formatReportDate } from './reportDates';

const number = (value: number) => new Intl.NumberFormat('th-TH', { maximumFractionDigits: 2 }).format(value);

/** A single product/unit series. Missing days break the line instead of becoming zero. */
export function QuantityTrendChart({ points, name, unit, selectedDate, onDateChange }: {
  points: Array<{ date: string; value: number | null }>;
  name: string; unit: string; selectedDate: string; onDateChange: (date: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const selected = points.find((point) => point.date === selectedDate);
  const hasData = points.some((point) => point.value !== null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !hasData) return;
    const draw = () => {
      const width = canvas.clientWidth;
      if (!width) return;
      const context = canvas.getContext('2d');
      if (!context) return;
      const height = 270;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      context.scale(ratio, ratio);
      const left = 54, right = width - 18, top = 16, bottom = height - 36;
      const maximum = Math.max(1, ...points.map((point) => point.value ?? 0));
      const magnitude = 10 ** Math.floor(Math.log10(maximum));
      const ceiling = Math.ceil(maximum / magnitude) * magnitude;
      const x = (index: number) => points.length === 1 ? (left + right) / 2 : left + index / (points.length - 1) * (right - left);
      const y = (value: number) => bottom - value / ceiling * (bottom - top);
      context.font = '12px "Noto Sans Thai", sans-serif';
      context.textAlign = 'right';
      context.textBaseline = 'middle';
      for (let tick = 0; tick <= 4; tick++) {
        const value = ceiling * tick / 4;
        context.strokeStyle = '#e7eef7';
        context.lineWidth = 1;
        context.beginPath(); context.moveTo(left, y(value)); context.lineTo(right, y(value)); context.stroke();
        context.fillStyle = '#61758e';
        context.fillText(number(value), left - 10, y(value));
      }
      // Fill and stroke each contiguous run; never bridge unknown observations.
      let run: Array<{ index: number; value: number }> = [];
      const paintRun = () => {
        if (!run.length) return;
        context.beginPath(); context.moveTo(x(run[0].index), bottom);
        run.forEach((point) => context.lineTo(x(point.index), y(point.value)));
        context.lineTo(x(run[run.length - 1].index), bottom); context.closePath();
        context.fillStyle = '#edf5ff'; context.fill();
        context.beginPath();
        run.forEach((point, index) => index === 0 ? context.moveTo(x(point.index), y(point.value)) : context.lineTo(x(point.index), y(point.value)));
        context.strokeStyle = '#0d6efd'; context.lineWidth = 2.5; context.stroke();
        run = [];
      };
      points.forEach((point, index) => point.value === null ? paintRun() : run.push({ index, value: point.value }));
      paintRun();
      points.forEach((point, index) => {
        if (point.value === null) return;
        const active = point.date === selectedDate;
        if (active) {
          context.setLineDash([3, 4]); context.strokeStyle = '#7baaf0'; context.lineWidth = 1;
          context.beginPath(); context.moveTo(x(index), y(point.value)); context.lineTo(x(index), bottom); context.stroke(); context.setLineDash([]);
        }
        context.beginPath(); context.arc(x(index), y(point.value), active ? 6 : 3, 0, Math.PI * 2);
        context.fillStyle = '#0d6efd'; context.fill(); context.strokeStyle = '#fff'; context.lineWidth = active ? 2 : 0; if (active) context.stroke();
      });
      context.fillStyle = '#61758e'; context.textBaseline = 'top';
      const tickEvery = Math.max(1, Math.ceil(points.length / (width < 400 ? 4 : 6)));
      points.forEach((point, index) => {
        if (index !== 0 && index !== points.length - 1 && (index % tickEvery !== 0 || points.length - 1 - index < tickEvery / 2)) return;
        context.textAlign = index === 0 ? 'left' : index === points.length - 1 ? 'right' : 'center';
        context.fillText(points[0].date.slice(0, 7) === points[points.length - 1].date.slice(0, 7) ? String(Number(point.date.slice(-2))) : `${Number(point.date.slice(-2))}/${Number(point.date.slice(5, 7))}`, x(index), bottom + 14);
      });
    };
    draw();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(draw) : null;
    observer?.observe(canvas);
    let disposed = false;
    void document.fonts?.ready.then(() => { if (!disposed) draw(); });
    return () => { disposed = true; observer?.disconnect(); };
  }, [points, selectedDate, hasData]);

  return <div className="quantity-trend">
    <div className="quantity-trend__readout"><span>{translateUi('จำนวน')} ({unit})</span>
      <span>{formatReportDate(selectedDate)} <strong>{selected?.value == null ? '—' : number(selected.value)} {unit}</strong></span></div>
    {hasData ? <canvas ref={canvasRef} className="quantity-trend__canvas" role="img" tabIndex={0}
      aria-label={`${translateUi('แนวโน้มจำนวนขาย')} · ${name} (${unit}) · ${translateUi('ใช้ปุ่มลูกศรเพื่อเลือกวัน')}`}
      onClick={(event) => {
        const width = event.currentTarget.clientWidth;
        const index = Math.max(0, Math.min(points.length - 1, Math.round((event.clientX - event.currentTarget.getBoundingClientRect().left - 54) / Math.max(1, width - 72) * (points.length - 1))));
        if (points[index]) onDateChange(points[index].date);
      }} onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault();
        const current = Math.max(0, points.findIndex((point) => point.date === selectedDate));
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1
          : Math.max(0, Math.min(points.length - 1, current + (event.key === 'ArrowRight' ? 1 : -1)));
        if (points[index]) onDateChange(points[index].date);
      }} /> : <p className="executive-empty">{translateUi('ยังไม่มีข้อมูลสำหรับกราฟในช่วงนี้')}</p>}
    <p className="quantity-trend__caption">{translateUi('วันที่')} · {translateUi('เลือกวันบนกราฟเพื่อเปรียบเทียบ')}</p>
  </div>;
}
