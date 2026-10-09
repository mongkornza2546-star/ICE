import { useCallback } from 'react';

const PENDING_REQUESTS_STORAGE_KEY = 'ice-delivery.pending-requests.v1';
const pendingRequestFallback = new Map<string, PendingRequestIdentity>();
const PENDING_REQUEST_MAX_AGE_MS = 48 * 60 * 60 * 1000;

export interface PendingRequestIdentity {
  key: string;
  clientRecordedAt: string;
  payloadSignature?: string;
  evidencePath?: string | null;
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
  const getPendingRequest = useCallback((storageSignature: string) => (
    readPendingRequests()[storageSignature] ?? pendingRequestFallback.get(storageSignature)
  ), []);

  const getOrCreatePendingRequest = useCallback((
    signature: string,
    storageSignature = signature,
    originalRequest?: PendingRequestIdentity,
  ) => {
    const stored = getPendingRequest(storageSignature);
    if (stored) return originalRequest ?? stored;

    const request: PendingRequestIdentity = originalRequest ?? {
      key: crypto.randomUUID(),
      clientRecordedAt: new Date().toISOString(),
      payloadSignature: signature,
    };
    pendingRequestFallback.set(storageSignature, request);
    writePendingRequests({ ...readPendingRequests(), [storageSignature]: request });
    return request;
  }, [getPendingRequest]);

  const clearPendingRequest = useCallback((signature: string, key: string) => {
    if (pendingRequestFallback.get(signature)?.key === key) {
      pendingRequestFallback.delete(signature);
    }
    const requests = readPendingRequests();
    if (requests[signature]?.key !== key) return;
    delete requests[signature];
    writePendingRequests(requests);
  }, []);

  const setPendingRequestEvidencePath = useCallback((signature: string, key: string, evidencePath: string) => {
    const requests = readPendingRequests();
    const request = requests[signature] ?? pendingRequestFallback.get(signature);
    if (!request || request.key !== key) return;
    const next = { ...request, evidencePath };
    pendingRequestFallback.set(signature, next);
    writePendingRequests({ ...requests, [signature]: next });
  }, []);

  return { getPendingRequest, getOrCreatePendingRequest, clearPendingRequest, setPendingRequestEvidencePath };
}
