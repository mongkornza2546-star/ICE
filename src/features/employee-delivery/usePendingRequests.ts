import { useCallback } from 'react';

const PENDING_REQUESTS_STORAGE_KEY = 'ice-delivery.pending-requests.v1';
const pendingRequestFallback = new Map<string, PendingRequestIdentity>();
const PENDING_REQUEST_MAX_AGE_MS = 48 * 60 * 60 * 1000;

export interface PendingRequestIdentity {
  key: string;
  clientRecordedAt: string;
}

function readPendingRequests(): Record<string, PendingRequestIdentity> {
  try {
    const value = window.localStorage.getItem(PENDING_REQUESTS_STORAGE_KEY);
    const requests = value ? JSON.parse(value) as Record<string, PendingRequestIdentity> : {};
    return Object.fromEntries(Object.entries(requests).filter(([, request]) => (
      Date.now() - Date.parse(request.clientRecordedAt) <= PENDING_REQUEST_MAX_AGE_MS
    )));
  } catch {
    return {};
  }
}

function writePendingRequests(requests: Record<string, PendingRequestIdentity>) {
  try {
    window.localStorage.setItem(PENDING_REQUESTS_STORAGE_KEY, JSON.stringify(requests));
  } catch {
    // The in-memory fallback still protects retries while this page remains open.
  }
}

export function usePendingRequests() {
  const getOrCreatePendingRequest = useCallback((signature: string) => {
    const stored = readPendingRequests()[signature] ?? pendingRequestFallback.get(signature);
    if (stored) return stored;

    const request = {
      key: crypto.randomUUID(),
      clientRecordedAt: new Date().toISOString(),
    };
    pendingRequestFallback.set(signature, request);
    writePendingRequests({ ...readPendingRequests(), [signature]: request });
    return request;
  }, []);

  const clearPendingRequest = useCallback((signature: string, key: string) => {
    pendingRequestFallback.delete(signature);
    const requests = readPendingRequests();
    if (requests[signature]?.key !== key) return;
    delete requests[signature];
    writePendingRequests(requests);
  }, []);

  return { getOrCreatePendingRequest, clearPendingRequest };
}
