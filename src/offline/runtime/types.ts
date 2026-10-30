import type { DeliveryPosContext, DeliveryRound, EmployeeStockState, IceTypeOption, ShopCard, UserProfile } from '../../types/app';
import type { CurrentCollectionQueue } from '../../lib/collectionQueue';

export type OfflineOperation = 'stock_transfer' | 'stock_return' | 'stock_damage' | 'delivery' | 'immediate_sale' | 'collection_payment';
export type CommandStatus = 'pending' | 'syncing' | 'retry_wait' | 'blocked' | 'auth_required' | 'conflict' | 'applied' | 'discard_approved';
export interface WorkSnapshot {
  version: 1;
  ownerId: string;
  serviceDate: string;
  preparedAt: string;
  validUntil: string;
  profile: UserProfile;
  rounds: DeliveryRound[];
  iceTypes: IceTypeOption[];
  cards: Record<string, ShopCard[]>;
  aggregate: Record<string, number>;
  stocks: Record<string, EmployeeStockState>;
  contexts: Record<string, DeliveryPosContext>;
  collection: CurrentCollectionQueue;
}
export interface WorkCommand {
  id: string;
  ownerId: string;
  serviceDate: string;
  deviceId: string;
  sequence: number;
  type: OfflineOperation;
  rpc: string;
  args: Record<string, unknown>;
  expected: Record<string, unknown>;
  recordedAt: string;
  status: CommandStatus;
  label: string;
  evidence?: Blob;
  evidenceData?: { bytes: ArrayBuffer; type: string };
  evidencePath?: string;
  resolved?: { args: Record<string, unknown>; expected: Record<string, unknown> };
  attempts: number;
  nextAttemptAt: number;
  error?: string;
  result?: Record<string, unknown>;
}
export interface WorkState {
  key: string;
  snapshot: WorkSnapshot;
  deviceId: string;
  sequence: number;
  lease?: { holder: string; until: number };
}
export const workKey = (owner: string, day: string) => `${owner}:${day}`;
export const pendingCommand = (command: WorkCommand) => !['applied', 'discard_approved'].includes(command.status);
export const money = (amount: number) => Math.round((amount + Number.EPSILON) * 100) / 100;
export function newOfflineId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
