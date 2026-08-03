const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

export function toBangkokDateString(date = new Date()): string {
  return new Date(date.getTime() + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
}

export function bangkokDayUtcRange(serviceDate: string): { start: string; end: string } {
  const start = new Date(`${serviceDate}T00:00:00+07:00`);
  return {
    start: start.toISOString(),
    end: new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

export function shiftServiceDate(serviceDate: string, days: number): string {
  const date = new Date(`${serviceDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
