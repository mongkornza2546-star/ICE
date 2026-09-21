import { isEventCode } from '../financial-operations/utils';

export { isEventCode };

/**
 * Strips internal UUID suffix or standalone UUID from a name
 * e.g. "ตึก c · 1c495ba3-fd94-4dc1-8833-50e4c6517a88" -> "ตึก c"
 */
export function cleanAreaName(name?: string | null): string {
  if (!name) return '';
  return name
    .replace(/\s*[·/]\s*[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\s*$/i, '')
    .replace(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\s*$/i, '')
    .trim();
}

/**
 * Formats accounting shop display title.
 * If shop_code is an event code (EV-uuid or EVENT-uuid), displays ONLY the shop name (e.g. "บูธ 18", "บูธ ศาลปกครองพิเศษ").
 * For regular shops, displays `${shop_code} · ${shop_name}` (or `${shop_name}` if name already starts with code).
 */
export function formatAccountingShopTitle(shop: { shop_code?: string | null; shop_name?: string | null }): string {
  const code = shop.shop_code?.trim();
  const name = shop.shop_name?.trim() || '';

  if (!code || isEventCode(code)) {
    return name || code || '';
  }

  if (name.startsWith(code)) {
    return name;
  }

  return name ? `${code} · ${name}` : code;
}

/**
 * Formats shop facet label in dropdowns.
 * E.g. "EV-48fe246c... บูธ 18" -> "บูธ 18"
 * E.g. "S001 ร้านสมใจ" -> "S001 ร้านสมใจ"
 */
export function formatAccountingShopFacetLabel(label: string): string {
  const trimmed = label.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length > 1 && isEventCode(parts[0])) {
    return parts.slice(1).join(' ');
  }
  return trimmed;
}

/**
 * Formats building and zone for accounting groups/headers.
 * Deduplicates if building and zone are identical (e.g. "ตึก c" and "ตึก c · 1c495ba3..." -> "ตึก c").
 * Strips internal UUIDs.
 */
export function formatAccountingGroupTitle(
  buildingName?: string | null,
  zoneName?: string | null,
  separator = ' · '
): string {
  const cleanBuilding = cleanAreaName(buildingName) || 'ไม่มีอาคาร';
  const cleanZone = cleanAreaName(zoneName);

  if (!cleanZone || cleanZone === 'ไม่มีโซน') {
    return `${cleanBuilding}${separator}ไม่มีโซน`;
  }

  // If zone name is identical to building name (case-insensitive), show only building
  if (cleanBuilding.trim().toLowerCase() === cleanZone.trim().toLowerCase()) {
    return cleanBuilding;
  }

  // If zone already includes building prefix (e.g. "ตึก c / โซนอาหาร" or "ตึก c · โซนอาหาร")
  const prefixRegex = new RegExp(`^${cleanBuilding.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\s*[·/]\\s*`, 'i');
  if (prefixRegex.test(cleanZone)) {
    const subZone = cleanZone.replace(prefixRegex, '').trim();
    return subZone ? `${cleanBuilding}${separator}${subZone}` : cleanBuilding;
  }

  return `${cleanBuilding}${separator}${cleanZone}`;
}

/**
 * Formats zone tab label or dropdown label.
 * E.g. "ตึก c / ตึก c · 1c495ba3-fd94-4dc1-8833-50e4c6517a88" -> "ตึก c"
 * E.g. "ตึก c · 1c495ba3-fd94-4dc1-8833-50e4c6517a88" -> "ตึก c"
 * E.g. "อาคาร B / โซน 2" -> "อาคาร B โซน 2" (if separator is space)
 */
export function formatAccountingZoneFacetLabel(label: string, separator = ' '): string {
  if (!label) return '';
  const cleaned = cleanAreaName(label);
  const parts = cleaned.split(/\s*[/·]\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 2 && parts[0].toLowerCase() === parts[1].toLowerCase()) {
    return parts[0];
  }
  return parts.join(separator);
}
