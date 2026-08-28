import { Capacitor, registerPlugin } from '@capacitor/core';

export type PairedPrinter = {
  name: string;
  address: string;
};

interface ThermalPrinterPlugin {
  ensurePermission(): Promise<{ granted: boolean }>;
  getStatus(): Promise<{ supported: boolean; enabled: boolean }>;
  getPairedDevices(): Promise<{ devices: PairedPrinter[] }>;
  openBluetoothSettings(): Promise<void>;
  printImage(options: { address: string; imageBase64: string }): Promise<{ printed: boolean }>;
}

const ThermalPrinter = registerPlugin<ThermalPrinterPlugin>('ThermalPrinter');
const selectedPrinterKey = 'ice-delivery:selected-thermal-printer:v1';
export const THERMAL_PRINTER_CHANGED_EVENT = 'ice-delivery:thermal-printer-changed';

export function isAndroidApp() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export function readSelectedPrinter(): PairedPrinter | null {
  try {
    const value = window.localStorage.getItem(selectedPrinterKey);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<PairedPrinter>;
    return typeof parsed.name === 'string' && typeof parsed.address === 'string'
      ? { name: parsed.name, address: parsed.address }
      : null;
  } catch {
    return null;
  }
}

export function saveSelectedPrinter(printer: PairedPrinter | null) {
  if (printer) window.localStorage.setItem(selectedPrinterKey, JSON.stringify(printer));
  else window.localStorage.removeItem(selectedPrinterKey);
  window.dispatchEvent(new CustomEvent(THERMAL_PRINTER_CHANGED_EVENT));
}

async function ensureBluetoothPermission() {
  const permission = await ThermalPrinter.ensurePermission();
  if (!permission.granted) {
    throw new Error('ต้องอนุญาตสิทธิ์อุปกรณ์ใกล้เคียงก่อนใช้เครื่องพิมพ์');
  }
}

export async function getPrinterStatus() {
  if (!isAndroidApp()) return { supported: false, enabled: false };
  await ensureBluetoothPermission();
  return ThermalPrinter.getStatus();
}

export async function getPairedPrinters() {
  await ensureBluetoothPermission();
  const { devices } = await ThermalPrinter.getPairedDevices();
  const selected = readSelectedPrinter();
  if (!selected) {
    const knownPrinter = devices.find((device) => device.name.trim().toLowerCase() === '583-02');
    if (knownPrinter) saveSelectedPrinter(knownPrinter);
  }
  return devices;
}

export async function openBluetoothSettings() {
  await ThermalPrinter.openBluetoothSettings();
}

export async function printThermalImage(imageBase64: string) {
  await ensureBluetoothPermission();
  let printer = readSelectedPrinter();
  if (!printer) {
    const devices = await getPairedPrinters();
    printer = devices.find((device) => device.name.trim().toLowerCase() === '583-02') ?? null;
  }
  if (!printer) {
    throw new Error('ยังไม่ได้เลือกเครื่องพิมพ์ กรุณาเปิดตั้งค่าเครื่องพิมพ์ก่อน');
  }
  return ThermalPrinter.printImage({ address: printer.address, imageBase64 });
}
