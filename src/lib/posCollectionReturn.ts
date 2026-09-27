import type { CollectionFocusRequest } from '../types/app';

const PREFIX = 'ice-delivery.pos-collection-return.v1';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface PosCollectionReturnContext {
  version: 1;
  ownerId: string;
  request: CollectionFocusRequest;
  returnTo: 'pos';
  origin: 'courier-pos' | 'admin-delivery';
  posServiceDate: string;
  collectionServiceDate: string;
  selectedRoundId: string;
  destinationKind: 'regular' | 'event';
  selectedBuildingId: string;
  selectedZone: string;
  selectedEventJobId: string;
  query: string;
  shopId: string;
  roundStopId: string;
  scrollY: number;
  cardViewportOffset: number | null;
  savedAt: string;
}

function key(ownerId: string) {
  return `${PREFIX}:${ownerId}`;
}

export function readPosCollectionReturn(ownerId: string): PosCollectionReturnContext | null {
  try {
    const raw = window.sessionStorage.getItem(key(ownerId));
    if (!raw) return null;
    const value = JSON.parse(raw) as PosCollectionReturnContext;
    if (value.version !== 1 || value.ownerId !== ownerId || value.returnTo !== 'pos'
      || Date.now() - Date.parse(value.savedAt) > MAX_AGE_MS) {
      clearPosCollectionReturn(ownerId);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function writePosCollectionReturn(context: PosCollectionReturnContext) {
  try {
    window.sessionStorage.setItem(key(context.ownerId), JSON.stringify(context));
  } catch {
    // KeepAlive state still preserves the in-memory return path when storage is unavailable.
  }
}

export function clearPosCollectionReturn(ownerId: string) {
  try {
    window.sessionStorage.removeItem(key(ownerId));
  } catch {
    // Ignore unavailable browser storage.
  }
}
