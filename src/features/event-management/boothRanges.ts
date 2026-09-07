// Expand compact booth ranges without allocating unbounded input.
export function parseBoothRanges(input: string): { booths: string[]; error: string | null } {
  if (!input.trim()) return { booths: [], error: null };
  const normalized = input.toUpperCase().replace(/ถึง|[–—]/g, '-').replace(/\s*-\s*/g, '-');
  const booths = new Set<string>();
  for (const part of normalized.split(/[\s,;]+/).filter(Boolean)) {
    const match = /^([A-Z]*)(\d+)(?:-([A-Z]*)(\d+))?$/.exec(part);
    if (!match || (match[3] && match[3] !== match[1])) {
      return { booths: [], error: `ช่วงรหัส “${part}” ไม่ถูกต้อง เช่น A1-250 หรือ A1-A250` };
    }
    const start = Number(match[2]);
    const end = Number(match[4] ?? match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start >= 1000) {
      return { booths: [], error: 'ใช้เลขบูธตั้งแต่ 1 และสร้างได้ครั้งละไม่เกิน 1,000 ร้าน' };
    }
    const width = match[2].startsWith('0') ? match[2].length : 0;
    for (let number = start; number <= end; number += 1) {
      booths.add(`${match[1]}${String(number).padStart(width, '0')}`);
      if (booths.size > 1000) return { booths: [], error: 'สร้างได้ครั้งละไม่เกิน 1,000 ร้าน' };
    }
  }
  return { booths: [...booths], error: null };
}
