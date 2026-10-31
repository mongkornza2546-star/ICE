import type { DeliveryPosContext, EmployeeStockState } from '../../types/app';
import { roundedLineTotalMinor } from '../contracts';
import { CREDIT_VAT_RATE } from '../../lib/vat';
import { money, type WorkCommand, type WorkSnapshot } from './types';

function quantities(value: unknown) {
  if (!Array.isArray(value) || !value.length) throw new Error('ใส่จำนวนอย่างน้อยหนึ่งรายการ');
  const seen = new Set<string>();
  return value.map(item => {
    if (!item || typeof item.ice_type_id !== 'string' || seen.has(item.ice_type_id)
      || !Number.isFinite(item.quantity) || item.quantity <= 0 || item.quantity * 2 !== Math.trunc(item.quantity * 2)) {
      throw new Error('จำนวนสินค้าไม่ถูกต้อง');
    }
    seen.add(item.ice_type_id);
    return { ice_type_id: item.ice_type_id as string, quantity: item.quantity as number };
  });
}
function move(snapshot: WorkSnapshot, locationId: string, items: ReturnType<typeof quantities>, sign: 1 | -1) {
  const change = (balances: Array<{ ice_type_id: string; quantity: number }>) => {
    for (const item of items) {
      const found = balances.find(b => b.ice_type_id === item.ice_type_id);
      if (!found) throw new Error('ไม่มีข้อมูลสต๊อกสินค้านี้ในเครื่อง');
      const next = Math.round((found.quantity + sign * item.quantity) * 1000) / 1000;
      if (next < 0) throw new Error('จำนวนเกินสต๊อกที่เหลือในเครื่อง');
      found.quantity = next;
    }
  };
  for (const stock of Object.values(snapshot.stocks)) {
    for (const location of [stock.truck_location, stock.holding_location]) if (location.id === locationId) change(location.balances);
  }
}
function consumeAggregate(snapshot: WorkSnapshot, items: ReturnType<typeof quantities>) {
  for (const item of items) {
    const current = snapshot.aggregate?.[item.ice_type_id];
    if (!Number.isFinite(current)) throw new Error('ยังไม่มีข้อมูลสต๊อกรวมในเครื่อง');
    const next = Math.round((current - item.quantity) * 1000) / 1000;
    if (next < 0) throw new Error('จำนวนเกินสต๊อกรวมที่เหลือในเครื่อง');
    snapshot.aggregate[item.ice_type_id] = next;
  }
}
function refreshAvailability(snapshot: WorkSnapshot) {
  for (const context of Object.values(snapshot.contexts)) {
    const stock = Object.values(snapshot.stocks).flatMap(s => [s.truck_location, s.holding_location])
      .find(location => location.id === context.stock_source.id);
    for (const item of context.items) {
      const holding = stock?.balances.find(b => b.ice_type_id === item.ice_type_id)?.quantity;
      const aggregate = snapshot.aggregate?.[item.ice_type_id];
      if (holding == null || !Number.isFinite(aggregate)) throw new Error('ข้อมูลสต๊อกสำหรับออฟไลน์ไม่ครบ');
      item.stock_quantity = Math.max(0, Math.min(holding, aggregate));
    }
  }
}

export function contextPolicy(context: DeliveryPosContext) {
  const { credit_exposure: _exposure, credit_remaining: _remaining, ...profile } = context.payment_profile ?? {};
  return { stock_source_id: context.stock_source.id, payment_profile: profile,
    prices: context.items.map(i => ({ ice_type_id: i.ice_type_id, unit_price: i.unit_price, price_source_id: i.price_source_id })) };
}
export function stockPolicy(stock: EmployeeStockState) {
  return { truck_location_id: stock.truck_location.id, holding_location_id: stock.holding_location.id };
}
function validatePayment(profile: DeliveryPosContext['payment_profile'] | WorkSnapshot['collection']['queue'][number]['payment_profile'], command: WorkCommand) {
  const method = command.args.p_payment_method;
  if (!profile || !['cash', 'bank_transfer', 'qr'].includes(String(method))
    || !profile.allowed_payment_methods.includes(method as 'cash' | 'bank_transfer' | 'qr')) throw new Error('วิธีรับเงินไม่ตรงกับเงื่อนไขร้าน');
  const key = method as 'cash' | 'bank_transfer' | 'qr';
  if (profile[`${key}_reference_required`] && !String(command.args.p_reference_number ?? '').trim()) throw new Error('กรุณากรอกเลขอ้างอิง');
  const evidenceSize = command.evidenceData?.bytes.byteLength ?? command.evidence?.size ?? 0;
  if (profile[`${key}_evidence_required`] && !evidenceSize && !command.args.p_evidence_path) throw new Error('กรุณาแนบหลักฐานรับเงิน');
  if (evidenceSize > 5 * 1024 * 1024) throw new Error('หลักฐานต้องมีขนาดไม่เกิน 5 MB');
}
export function projectCommand(snapshot: WorkSnapshot, command: WorkCommand): WorkSnapshot {
  const args = command.args;
  if (command.type.startsWith('stock_')) {
    const stock = snapshot.stocks[String(args.p_round_id)];
    if (!stock) throw new Error('ยังไม่มีข้อมูลสต๊อกของรอบนี้ในเครื่อง');
    const items = quantities(args.p_items);
    const receiving = command.type === 'stock_transfer';
    move(snapshot, receiving ? stock.truck_location.id : stock.holding_location.id, items, -1);
    if (receiving) for (const state of Object.values(snapshot.stocks)) {
      if (state.holding_location.id !== stock.holding_location.id) continue;
      for (const item of items) { const balance = state.withdrawn_balances?.find(b => b.ice_type_id === item.ice_type_id); if (balance) balance.quantity = Math.round((balance.quantity + item.quantity) * 1000) / 1000; }
    }
    if (command.type === 'stock_damage') consumeAggregate(snapshot, items);
    if (command.type !== 'stock_damage') move(snapshot, receiving ? stock.holding_location.id : stock.truck_location.id, items, 1);
  } else if (command.type === 'delivery' || command.type === 'immediate_sale') {
    const context = snapshot.contexts[String(args.p_round_stop_id)];
    if (!context) throw new Error('ยังไม่ได้เตรียมข้อมูลร้านนี้');
    const delivered = command.type === 'immediate_sale' || args.p_stop_status === 'delivered';
    const items = delivered ? quantities(args.p_items) : [];
    if (delivered) {
      const term = command.type === 'immediate_sale' ? 'immediate' : args.p_payment_term ?? context.payment_profile?.default_payment_term ?? 'end_of_day';
      if (context.payment_profile && !context.payment_profile.allowed_payment_terms.includes(term as 'immediate' | 'end_of_day' | 'credit')) throw new Error('เงื่อนไขชำระเงินไม่ตรงกับข้อมูลร้าน');
      let subtotal = 0;
      for (const item of items) {
        const product = context.items.find(p => p.ice_type_id === item.ice_type_id);
        if (product?.unit_price == null || product.unit_price < 0 || !Number.isFinite(product.unit_price)) throw new Error('ยังไม่มีราคาสินค้าที่เลือก');
        const lineMinor = roundedLineTotalMinor(item.quantity, product.unit_price);
        if (lineMinor == null) throw new Error('จำนวนหรือราคาสินค้าไม่ถูกต้อง');
        subtotal = money(subtotal + lineMinor / 100);
      }
      const vatRate = term === 'credit' && context.payment_profile?.vat_enabled ? CREDIT_VAT_RATE : 0;
      if (args.p_expected_vat_rate != null && args.p_expected_vat_rate !== vatRate) throw new Error('อัตราภาษีไม่ตรงกับข้อมูลร้าน');
      const total = money(subtotal + money(subtotal * vatRate / 100));
      if (term === 'credit' && context.payment_profile && (context.payment_profile.credit_suspended
        || (context.payment_profile.credit_remaining != null && context.payment_profile.credit_remaining < total))) throw new Error('วงเงินเครดิตไม่พอหรือถูกระงับ กรุณาเชื่อมต่อเพื่อขออนุมัติ');
      if (total !== (args.p_expected_total ?? command.expected.expected_total)) throw new Error('ยอดเงินไม่ตรงกับราคาที่เตรียมไว้');
      if (command.type === 'immediate_sale') {
        if (!snapshot.profile.can_collect_shop_payments) throw new Error('บัญชีนี้ไม่มีสิทธิ์รับเงิน');
        validatePayment(context.payment_profile, command);
        const received = Number(args.p_received_amount);
        if (!Number.isFinite(received) || money(received) !== received || received < total
          || (args.p_payment_method !== 'cash' && received !== total)) throw new Error('ยอดรับชำระไม่ถูกต้อง');
      }
      consumeAggregate(snapshot, items);
      move(snapshot, context.stock_source.id, items, -1);
      if (command.type === 'delivery' && term !== 'credit' && context.offline_collection_template) {
        const template = context.offline_collection_template;
        let shop = snapshot.collection.queue.find(s => s.queue_key === template.queue_key);
        if (!shop) { shop = structuredClone(template); snapshot.collection.queue.push(shop); }
        shop.charges.push({ charge_id: `local:${command.id}`, delivery_event_id: `local:${command.id}`,
          charge_number: `TMP-${command.id}`, service_date: snapshot.serviceDate,
          payment_term: term === 'immediate' ? 'immediate' : 'end_of_day',
          original_amount: total, outstanding_amount: total, items: items.map(item => {
            const product = context.items.find(p => p.ice_type_id === item.ice_type_id)!;
            return { ...item, name: product.name, unit: product.unit, line_total: roundedLineTotalMinor(item.quantity, product.unit_price!)! / 100 };
          }) });
        shop.outstanding_amount = money(shop.outstanding_amount + total);
        shop.charge_count = shop.charges.length; shop.has_new_charges = true;
      }

      if (term === 'credit') {
        for (const c of Object.values(snapshot.contexts)) if (c.shop.id === context.shop.id && c.payment_profile) {
          c.payment_profile.credit_exposure = money(c.payment_profile.credit_exposure + total);
          if (c.payment_profile.credit_remaining != null) c.payment_profile.credit_remaining = money(c.payment_profile.credit_remaining - total);
        }
      }
    }
    for (const cards of Object.values(snapshot.cards)) {
      const card = cards.find(c => c.round_stop_id === context.round_stop_id);
      if (card) {
        card.stop_status = delivered ? 'delivered' : args.p_stop_status as typeof card.stop_status;
        for (const item of items) card.today_totals[item.ice_type_id] = (card.today_totals[item.ice_type_id] ?? 0) + item.quantity;
      }
    }
  } else if (command.type === 'collection_payment') {
    if (!snapshot.profile.can_collect_shop_payments || snapshot.collection.isClosed || snapshot.collection.canRecordPayment === false) throw new Error('บัญชีนี้หรือรอบนี้ยังไม่เปิดรับเงิน');
    const shop = snapshot.collection.queue.find(s => (s.queue_key ?? `regular:${s.shop_id}`) === command.expected.queueKey);
    if (!shop || shop.outstanding_amount !== args.p_expected_outstanding_amount) throw new Error('ยอดค้างในเครื่องเปลี่ยน กรุณาตรวจรายการ');
    validatePayment(shop.payment_profile, command);
    const allocations = args.p_allocations as Array<{ charge_id: string; amount: number }>;
    if (!Array.isArray(allocations) || !allocations.length || new Set(allocations.map(a => a.charge_id)).size !== allocations.length) throw new Error('รายการรับเงินไม่ถูกต้อง');
    let total = 0;
    for (const allocation of allocations) {
      const chargeId = snapshot.chargeAliases?.[allocation.charge_id] ?? allocation.charge_id;
      const charge = shop.charges.find(c => c.charge_id === chargeId);
      if (!charge || !Number.isFinite(allocation.amount) || allocation.amount <= 0 || money(allocation.amount) !== allocation.amount
        || allocation.amount > charge.outstanding_amount) throw new Error('ยอดรับเกินยอดค้าง');
      charge.outstanding_amount = money(charge.outstanding_amount - allocation.amount);
      total = money(total + allocation.amount);
    }
    const received = Number(args.p_received_amount);
    if (!Number.isFinite(received) || money(received) !== received || received < total
      || (args.p_payment_method !== 'cash' && received !== total)) throw new Error('ยอดรับชำระไม่ถูกต้อง');
    shop.outstanding_amount = money(shop.outstanding_amount - total);
    shop.charges = shop.charges.filter(c => c.outstanding_amount > 0);
    shop.charge_count = shop.charges.length;
    snapshot.collection.queue = snapshot.collection.queue.filter(s => s.outstanding_amount > 0);
  }
  refreshAvailability(snapshot);
  return snapshot;
}
