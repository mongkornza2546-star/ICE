import type { PaymentMethod } from '../types/app';

export function normalizePaymentMethod(method: PaymentMethod): PaymentMethod {
  return method === 'qr' ? 'bank_transfer' : method;
}

export function normalizePaymentMethods(methods: PaymentMethod[]): PaymentMethod[] {
  return [...new Set(methods.map(normalizePaymentMethod))];
}

export function visiblePaymentMethods(methods: PaymentMethod[]): PaymentMethod[] {
  return methods.includes('bank_transfer') ? methods.filter((method) => method !== 'qr') : methods;
}
