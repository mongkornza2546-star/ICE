export type ActiveFilter = 'all' | 'active' | 'inactive';

export function nextFilter(current: ActiveFilter): ActiveFilter {
  if (current === 'all') return 'active';
  if (current === 'active') return 'inactive';
  return 'all';
}

export function filterLabel(filter: ActiveFilter) {
  if (filter === 'active') return 'เฉพาะที่ใช้งาน';
  if (filter === 'inactive') return 'เฉพาะที่พักใช้งาน';
  return 'ทั้งหมด';
}

export function matchesQuery(query: string, fields: Array<string | null | undefined>) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return fields.some((field) => field?.toLowerCase().includes(normalizedQuery));
}

export function matchesActiveFilter(isActive: boolean, filter: ActiveFilter) {
  if (filter === 'all') return true;
  return filter === 'active' ? isActive : !isActive;
}
