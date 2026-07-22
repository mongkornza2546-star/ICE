const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

export function toBangkokDateString(date = new Date()): string {
  return new Date(date.getTime() + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
}
