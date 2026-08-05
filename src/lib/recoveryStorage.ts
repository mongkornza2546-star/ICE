const RECOVERY_PREFIX = 'ice-delivery.recovery.v1';
const NAVIGATION_PREFIX = 'ice-delivery.navigation.v1';
const MAX_AGE_MS = 48 * 60 * 60 * 1000;

export interface RecoveryEnvelope<T> {
  version: 1;
  ownerId: string;
  serviceDate: string;
  savedAt: string;
  payload: T;
}

export interface PersistedNavigation {
  activeView?: string;
  financialPage?: 'collection' | 'credit' | 'refund';
  courierView?: 'withdrawal' | 'pos' | 'collection';
  billingServiceDate?: string;
}

function readJson<T>(key: string): T | null {
  try {
    const value = window.localStorage.getItem(key);
    return value ? JSON.parse(value) as T : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Recovery is a convenience. The live form remains usable when storage is unavailable.
  }
}

export function recoveryKey(ownerId: string, serviceDate: string, mode: string) {
  return `${RECOVERY_PREFIX}:${ownerId}:${serviceDate}:${mode}`;
}

export function readRecovery<T>(ownerId: string, serviceDate: string, mode: string): RecoveryEnvelope<T> | null {
  const key = recoveryKey(ownerId, serviceDate, mode);
  const value = readJson<RecoveryEnvelope<T>>(key);
  if (!value || value.version !== 1 || value.ownerId !== ownerId || value.serviceDate !== serviceDate) return null;
  if (Date.now() - Date.parse(value.savedAt) > MAX_AGE_MS) {
    clearRecovery(ownerId, serviceDate, mode);
    return null;
  }
  return value;
}

export function writeRecovery<T>(ownerId: string, serviceDate: string, mode: string, payload: T) {
  writeJson(recoveryKey(ownerId, serviceDate, mode), {
    version: 1,
    ownerId,
    serviceDate,
    savedAt: new Date().toISOString(),
    payload,
  } satisfies RecoveryEnvelope<T>);
}

export function clearRecovery(ownerId: string, serviceDate: string, mode: string) {
  try {
    window.localStorage.removeItem(recoveryKey(ownerId, serviceDate, mode));
  } catch {
    // Ignore an unavailable browser storage implementation.
  }
}

export function readNavigation(ownerId: string): PersistedNavigation | null {
  return readJson<PersistedNavigation>(`${NAVIGATION_PREFIX}:${ownerId}`);
}

export function writeNavigation(ownerId: string, navigation: PersistedNavigation) {
  writeJson(`${NAVIGATION_PREFIX}:${ownerId}`, navigation);
}

export function clearNavigation(ownerId: string) {
  try {
    window.localStorage.removeItem(`${NAVIGATION_PREFIX}:${ownerId}`);
  } catch {
    // Ignore an unavailable browser storage implementation.
  }
}

export function clearRecoveryForOwner(ownerId: string) {
  try {
    const ownerPrefix = `${RECOVERY_PREFIX}:${ownerId}:`;
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(ownerPrefix)) window.localStorage.removeItem(key);
    }
  } catch {
    // Ignore an unavailable browser storage implementation.
  }
}
