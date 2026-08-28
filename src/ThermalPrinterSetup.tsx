import { useCallback, useEffect, useState } from 'react';
import { Bluetooth, CheckCircle, GearSix, Printer, WarningCircle, X } from '@phosphor-icons/react';
import {
  getPairedPrinters,
  getPrinterStatus,
  isAndroidApp,
  openBluetoothSettings,
  printThermalImage,
  readSelectedPrinter,
  saveSelectedPrinter,
  THERMAL_PRINTER_CHANGED_EVENT,
  type PairedPrinter,
} from './lib/thermalPrinter';
import { renderPrinterTestRaster } from './lib/thermalReceiptRaster';

export function ThermalPrinterSetup() {
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<PairedPrinter[]>([]);
  const [selected, setSelected] = useState<PairedPrinter | null>(() => readSelectedPrinter());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const loadDevices = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const status = await getPrinterStatus();
      if (!status.supported) throw new Error('โทรศัพท์เครื่องนี้ไม่รองรับ Bluetooth');
      if (!status.enabled) throw new Error('กรุณาเปิด Bluetooth ก่อน');
      setDevices(await getPairedPrinters());
      setSelected(readSelectedPrinter());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'โหลดรายชื่อเครื่องพิมพ์ไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const syncSelected = () => setSelected(readSelectedPrinter());
    window.addEventListener(THERMAL_PRINTER_CHANGED_EVENT, syncSelected);
    return () => window.removeEventListener(THERMAL_PRINTER_CHANGED_EVENT, syncSelected);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    void loadDevices();
    const refresh = () => { if (document.visibilityState === 'visible') void loadDevices(); };
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
  }, [loadDevices, open]);

  if (!isAndroidApp()) return null;

  const choosePrinter = (printer: PairedPrinter) => {
    saveSelectedPrinter(printer);
    setSelected(printer);
    setSuccess(`เลือก ${printer.name} แล้ว`);
    setError(null);
  };

  const testPrint = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const image = await renderPrinterTestRaster(selected.name);
      await printThermalImage(image);
      setSuccess('ส่งใบทดสอบไปยังเครื่องพิมพ์แล้ว');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'ทดสอบพิมพ์ไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        aria-label="ตั้งค่าเครื่องพิมพ์ Bluetooth"
        className={`thermal-printer-fab ${selected ? 'thermal-printer-fab--ready' : ''}`}
        onClick={() => { setOpen(true); setSuccess(null); }}
        title={selected ? `เครื่องพิมพ์: ${selected.name}` : 'ตั้งค่าเครื่องพิมพ์'}
        type="button"
      >
        <Printer aria-hidden="true" size={24} weight={selected ? 'fill' : 'regular'} />
        <span>{selected ? selected.name : 'เครื่องพิมพ์'}</span>
      </button>

      {open ? (
        <div className="thermal-printer-layer" role="presentation">
          <button aria-label="ปิดตั้งค่าเครื่องพิมพ์" className="thermal-printer-backdrop" onClick={() => setOpen(false)} type="button" />
          <section aria-labelledby="thermal-printer-title" aria-modal="true" className="thermal-printer-dialog" role="dialog">
            <header>
              <span><Bluetooth aria-hidden="true" size={26} weight="bold" /></span>
              <div>
                <h2 id="thermal-printer-title">เครื่องพิมพ์ Bluetooth</h2>
                <p>จับคู่ `583-02` ใน Android ก่อน รหัส PIN `0000`</p>
              </div>
              <button aria-label="ปิด" className="thermal-printer-close" onClick={() => setOpen(false)} type="button"><X size={21} /></button>
            </header>

            {error ? <div className="thermal-printer-message thermal-printer-message--error" role="alert"><WarningCircle size={19} weight="fill" />{error}</div> : null}
            {success ? <div className="thermal-printer-message thermal-printer-message--success" role="status"><CheckCircle size={19} weight="fill" />{success}</div> : null}

            <div className="thermal-printer-actions">
              <button onClick={() => { void openBluetoothSettings(); }} type="button"><GearSix size={18} />เปิดตั้งค่า Bluetooth</button>
              <button disabled={busy} onClick={() => { void loadDevices(); }} type="button">{busy ? 'กำลังโหลด…' : 'โหลดรายชื่อใหม่'}</button>
            </div>

            <div className="thermal-printer-list" aria-label="อุปกรณ์ที่จับคู่แล้ว">
              {devices.length === 0 && !busy ? <p>ยังไม่พบอุปกรณ์ที่จับคู่แล้ว</p> : null}
              {devices.map((device) => {
                const active = selected?.address === device.address;
                return (
                  <button className={active ? 'thermal-printer-device--active' : ''} key={device.address} onClick={() => choosePrinter(device)} type="button">
                    <Printer size={22} weight={active ? 'fill' : 'regular'} />
                    <span><strong>{device.name}</strong><small>{device.address}</small></span>
                    {active ? <CheckCircle size={21} weight="fill" /> : null}
                  </button>
                );
              })}
            </div>

            <footer>
              <button disabled={!selected || busy} onClick={() => { void testPrint(); }} type="button"><Printer size={19} />ทดสอบพิมพ์</button>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}
