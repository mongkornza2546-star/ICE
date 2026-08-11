import { describe, expect, it } from 'vitest';
import fixtures from '../contracts/employee-offline-v1.fixtures.json';
import {
  OFFLINE_COMMAND_TYPES,
  OFFLINE_SYNC_ERROR_CODES,
  validateOfflineCommand,
  validateOfflineSyncResponse,
} from '../src/offline/contracts';
import {
  canonicalJsonV1,
  collectionAllocationFingerprintValue,
  deliveryPriceFingerprintValue,
  fingerprintCanonicalValueV1,
  paymentProfileFingerprintValue,
} from '../src/offline/fingerprints';
import type { ShopPaymentProfile } from '../src/types/app';

type DeliveryFingerprintInput = {
  items: Array<{ iceTypeId: string; unitPrice: number; priceSourceId: string }>;
  expectedTotal: number;
};

type CollectionFingerprintInput = {
  allocations: Array<{ chargeId: string; amount: number }>;
  outstandingAmount: number;
};

function buildFingerprintValue(fixture: (typeof fixtures.fingerprints)[number]) {
  switch (fixture.name) {
    case 'payment_profile':
      return paymentProfileFingerprintValue(fixture.input as ShopPaymentProfile);
    case 'delivery_prices': {
      const input = fixture.input as DeliveryFingerprintInput;
      return deliveryPriceFingerprintValue(input.items, input.expectedTotal);
    }
    case 'collection_allocations': {
      const input = fixture.input as CollectionFingerprintInput;
      return collectionAllocationFingerprintValue(input.allocations, input.outstandingAmount);
    }
    default:
      throw new Error(`Unknown fingerprint fixture: ${fixture.name}`);
  }
}

describe('employee offline v1 command contract', () => {
  it('accepts one shared fixture for every frozen command type', () => {
    const fixtureTypes = fixtures.commands.map((command) => command.type).sort();
    expect(fixtureTypes).toEqual([...OFFLINE_COMMAND_TYPES].sort());

    for (const command of fixtures.commands) {
      expect(validateOfflineCommand(command), command.type).toEqual({ valid: true, issues: [] });
    }
  });

  it('rejects unsupported versions and payload fields outside the allowlist', () => {
    const command = structuredClone(fixtures.commands[0]);
    const invalidCommand = {
      ...command,
      schemaVersion: 2,
      payload: { ...command.payload, unexpected: true },
    };

    expect(validateOfflineCommand(invalidCommand).issues).toEqual([
      'unsupported schemaVersion',
      'payload does not match stock_transfer v1',
    ]);
  });

  it('rejects payload values that the reused business RPCs cannot represent', () => {
    const transfer = structuredClone(fixtures.commands[0]);
    transfer.payload.items[0].quantity = 0.5;
    expect(validateOfflineCommand(transfer).issues).toContain(
      'payload does not match stock_transfer v1',
    );

    const stockReturn = structuredClone(fixtures.commands[1]);
    stockReturn.payload.items[0].quantity = 0.1;
    expect(validateOfflineCommand(stockReturn).issues).toContain(
      'payload does not match stock_return v1',
    );

    const delivery = structuredClone(fixtures.commands[3]);
    delivery.payload.items[0].quantity = 0.25;
    expect(validateOfflineCommand(delivery).issues).toContain(
      'payload does not match delivery v1',
    );

    const missedStop = structuredClone(fixtures.commands[3]);
    missedStop.payload.status = 'closed_shop';
    missedStop.payload.note = '   ';
    missedStop.payload.items = [];
    missedStop.payload.paymentTerm = null;
    missedStop.payload.approvalId = null;
    missedStop.payload.expectedTotal = null;
    missedStop.payload.expectedPaymentProfileFingerprint = null;
    expect(validateOfflineCommand(missedStop).issues).toContain(
      'payload does not match delivery v1',
    );
  });

  it('rounds half-unit delivery lines to satang like PostgreSQL', () => {
    const delivery = structuredClone(fixtures.commands[3]);
    delivery.payload.items[0].quantity = 0.5;
    delivery.payload.items[0].expectedUnitPrice = 42.51;
    delivery.payload.expectedTotal = 21.26;

    expect(validateOfflineCommand(delivery)).toEqual({ valid: true, issues: [] });

    delivery.payload.expectedTotal = 21.25;
    expect(validateOfflineCommand(delivery).issues).toContain(
      'payload does not match delivery v1',
    );
  });

  it('requires immutable uploaded evidence metadata for payment replay', () => {
    const payment = structuredClone(fixtures.commands[5]);
    payment.payload.evidence = {
      ...payment.payload.evidence,
      remotePath: 'another-user/not-this-command.pdf',
    };
    expect(validateOfflineCommand(payment).issues).toContain(
      'payload does not match collection_payment v1',
    );
  });

  it('validates every frozen applied result and rejects an opaque object', () => {
    for (const command of fixtures.commands) {
      const result = fixtures.results[command.type as keyof typeof fixtures.results];
      expect(
        validateOfflineSyncResponse(command.type, {
          status: 'applied',
          command_id: command.commandId,
          resolution_version: 1,
          result,
        }),
        command.type,
      ).toEqual({ valid: true, issues: [] });

      const appliedCommand = {
        ...command,
        status: 'applied',
        serverResult: result,
        serverResolutionVersion: 1,
      };
      expect(validateOfflineCommand(appliedCommand), command.type).toEqual({
        valid: true,
        issues: [],
      });
    }

    expect(
      validateOfflineSyncResponse('delivery', {
        status: 'applied',
        command_id: fixtures.commands[3].commandId,
        resolution_version: 1,
        result: {},
      }).issues,
    ).toContain('result does not match delivery result v1');
  });

  it('rejects applied result fields outside the frozen v1 DTO', () => {
    const result = { ...fixtures.results.delivery, recorded_by: fixtures.commands[3].ownerId };

    expect(
      validateOfflineSyncResponse('delivery', {
        status: 'applied',
        command_id: fixtures.commands[3].commandId,
        resolution_version: 1,
        result,
      }).issues,
    ).toContain('result does not match delivery result v1');

    const nestedResult = structuredClone(fixtures.results.delivery);
    Object.assign(nestedResult.items[0], { raw_rpc_field: true });
    expect(
      validateOfflineSyncResponse('delivery', {
        status: 'applied',
        command_id: fixtures.commands[3].commandId,
        resolution_version: 1,
        result: nestedResult,
      }).issues,
    ).toContain('result does not match delivery result v1');
  });

  it('rejects an official receipt without its financial snapshot', () => {
    const result = structuredClone(fixtures.results.immediate_sale);
    result.print_document = {
      document_type: 'REC',
      document_number: result.receipt_number,
      document_title: 'Receipt',
      shop_code: 'SHOP-002',
      shop_name: 'Shop Two',
    };

    expect(
      validateOfflineSyncResponse('immediate_sale', {
        status: 'applied',
        command_id: fixtures.commands[4].commandId,
        resolution_version: 1,
        result,
      }).issues,
    ).toContain('result does not match immediate_sale result v1');
  });

  it('rejects an applied payment whose receipt snapshot disagrees with its result', () => {
    const result = structuredClone(fixtures.results.collection_payment);
    result.print_document.document_number = 'REC2608-99999';

    expect(
      validateOfflineSyncResponse('collection_payment', {
        status: 'applied',
        command_id: fixtures.commands[5].commandId,
        resolution_version: 1,
        result,
      }).issues,
    ).toContain('result does not match collection_payment result v1');
  });

  it('rejects a delivery whose invoice snapshot disagrees with its result', () => {
    const result = structuredClone(fixtures.results.delivery);
    result.print_document.document_number = 'INV2608-99999';

    expect(
      validateOfflineSyncResponse('delivery', {
        status: 'applied',
        command_id: fixtures.commands[3].commandId,
        resolution_version: 1,
        result,
      }).issues,
    ).toContain('result does not match delivery result v1');
  });

  it('rejects incorrect financial line arithmetic and printable item details', () => {
    const incorrectLineTotal = structuredClone(fixtures.results.delivery);
    incorrectLineTotal.items[0].line_total = 1;
    expect(
      validateOfflineSyncResponse('delivery', {
        status: 'applied',
        command_id: fixtures.commands[3].commandId,
        resolution_version: 1,
        result: incorrectLineTotal,
      }).issues,
    ).toContain('result does not match delivery result v1');

    const incorrectInvoiceLineTotal = structuredClone(fixtures.results.delivery);
    incorrectInvoiceLineTotal.print_document.items[0].line_total = 1;
    expect(
      validateOfflineSyncResponse('delivery', {
        status: 'applied',
        command_id: fixtures.commands[3].commandId,
        resolution_version: 1,
        result: incorrectInvoiceLineTotal,
      }).issues,
    ).toContain('result does not match delivery result v1');

    const mismatchedInvoiceItem = structuredClone(fixtures.results.delivery);
    mismatchedInvoiceItem.print_document.items[0].ice_type_name = 'Different ice';
    expect(
      validateOfflineSyncResponse('delivery', {
        status: 'applied',
        command_id: fixtures.commands[3].commandId,
        resolution_version: 1,
        result: mismatchedInvoiceItem,
      }).issues,
    ).toContain('result does not match delivery result v1');

    const mismatchedReceiptItem = structuredClone(fixtures.results.immediate_sale);
    mismatchedReceiptItem.print_document.charges[0].items[0].ice_type_name = 'Different ice';
    expect(
      validateOfflineSyncResponse('immediate_sale', {
        status: 'applied',
        command_id: fixtures.commands[4].commandId,
        resolution_version: 1,
        result: mismatchedReceiptItem,
      }).issues,
    ).toContain('result does not match immediate_sale result v1');
  });

  it('rejects an applied command without a server resolution version', () => {
    const command = {
      ...fixtures.commands[0],
      status: 'applied',
      serverResult: fixtures.results.stock_transfer,
    };

    expect(validateOfflineCommand(command).issues).toContain(
      'serverResolutionVersion must be positive for resolved commands',
    );
  });

  it('rejects command metadata outside the JavaScript safe-integer range', () => {
    const command = { ...fixtures.commands[0], sequence: Number.MAX_SAFE_INTEGER + 1 };

    expect(validateOfflineCommand(command).issues).toContain(
      'sequence must be a positive integer',
    );
  });

  it('freezes the stable sync error vocabulary', () => {
    expect(OFFLINE_SYNC_ERROR_CODES).toEqual([
      'ROUND_CLOSED',
      'STOCK_DAY_CLOSED',
      'INSUFFICIENT_STOCK',
      'PRICE_CHANGED',
      'OUTSTANDING_CHANGED',
      'PAYMENT_PROFILE_CHANGED',
      'APPROVAL_REQUIRED',
      'APPROVAL_EXPIRED',
      'ROUND_ASSIGNMENT_CHANGED',
      'USER_INACTIVE',
      'COLLECTION_RUN_CLOSED',
      'IDEMPOTENCY_PAYLOAD_MISMATCH',
      'INVALID_SCHEMA_VERSION',
      'INVALID_PAYLOAD_VERSION',
      'INVALID_PAYLOAD',
      'DEVICE_MISMATCH',
      'OWNER_MISMATCH',
      'SERVICE_DATE_EXPIRED',
      'SERVER_CONTRACT_ERROR',
      'NETWORK_ERROR',
      'SERVER_UNAVAILABLE',
      'AUTH_REQUIRED',
      'EVIDENCE_UPLOAD_FAILED',
    ]);
  });
});

describe('employee offline v1 canonical fingerprints', () => {
  it.each(fixtures.fingerprints)('matches the shared $name fixture', async (fixture) => {
    const normalized = buildFingerprintValue(fixture);
    expect(normalized).toEqual(fixture.normalized);
    expect(canonicalJsonV1(normalized)).toBe(fixture.canonical);
    await expect(fingerprintCanonicalValueV1(normalized)).resolves.toBe(fixture.sha256);
  });

  it('rejects monetary inputs with more than two decimal places', () => {
    expect(() => deliveryPriceFingerprintValue([], 10.001)).toThrow(/two decimal places/);
  });

  it('changes the payment-profile fingerprint value when credit is suspended', () => {
    const fixture = fixtures.fingerprints.find(({ name }) => name === 'payment_profile');
    if (!fixture) throw new Error('Missing payment-profile fixture');
    const active = { ...fixture.input, credit_suspended: false } as ShopPaymentProfile;
    const suspended = { ...active, credit_suspended: true };

    expect(paymentProfileFingerprintValue(suspended)).not.toEqual(
      paymentProfileFingerprintValue(active),
    );
  });

  it('rejects values whose number or key ordering differs across runtimes', () => {
    expect(() => canonicalJsonV1({ n: 1e-7 })).toThrow(/safe integers/);
    expect(() => canonicalJsonV1({ 'ราคา': 1 })).toThrow(/ASCII/);
  });
});
