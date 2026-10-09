import { useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { CalendarBlank, Coins, Package, Storefront } from '@phosphor-icons/react';
import { EmployeeLayout } from '../../src/EmployeeLayout';
import { EmployeeDeliveryReview } from '../../src/features/employee-delivery/EmployeeDeliveryReview';
import type { DeliveryPosContext, DeliveryRound, PaymentTerm, ShopCard } from '../../src/types/app';
import '../../src/index.css';

// Local visual QA using the production component and synthetic data.
const round: DeliveryRound = { id: 'preview-round', service_date: '2026-10-09', name: 'รอบเช้า', status: 'open', opened_at: '2026-10-09T01:00:00Z' };
const shops: ShopCard[] = Array.from({ length: 169 }, (_, index) => ({
  round_stop_id: `preview-stop-${index}`, shop_id: `preview-shop-${index}`, shop_code: `SW-${String(index + 1).padStart(2, '0')}`, shop_name: `ร้าน ${index + 1}`,
  building_id: 'skywalk', building_name: 'SKY WALK', floor_or_zone: 'ตลาด', sequence_no: index + 1,
  image_path: null, image_url: null, payment_status: 'unpaid', stop_status: 'pending', stop_note: null, today_history: [], today_totals: {},
}));
const products = ['หลอดเล็ก', 'โม่', 'หลอดเล็กโม่', 'เปลือย (หลอดใหญ่)', 'น้ำแข็งก้อน', 'น้ำแข็งบด'].map((name, index) => ({
  ice_type_id: `ice-${index}`, code: `ICE-${index}`, name, unit: index === 4 ? 'แถว' : 'ถุง', image_path: null,
  stock_quantity: 12.5, unit_price: 60, price_source: 'standard' as const, price_source_id: `price-${index}`,
}));
const profile: DeliveryPosContext['payment_profile'] = {
  allowed_payment_terms: ['end_of_day', 'immediate', 'credit'], default_payment_term: 'end_of_day',
  allowed_payment_methods: ['cash', 'bank_transfer'], default_payment_method: 'cash',
  cash_reference_required: false, cash_evidence_required: false, bank_transfer_reference_required: false, bank_transfer_evidence_required: true,
  qr_reference_required: false, qr_evidence_required: true, allow_outstanding: true,
  credit_due_rule: 'net_days', credit_days: 7, credit_collection_weekday: null, credit_limit: 500,
  credit_exposure: 0, credit_remaining: 500, credit_suspended: false,
};

function Preview() {
  const [shop, setShop] = useState(shops[2]);
  const [quantities, setQuantities] = useState<Record<string, number>>({ 'ice-1': 0.5 });
  const [term, setTerm] = useState<PaymentTerm>('end_of_day');
  const [message, setMessage] = useState('');
  const [approvalReason, setApprovalReason] = useState('');
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const context: DeliveryPosContext = {
    round_id: round.id, round_stop_id: shop.round_stop_id, service_date: round.service_date,
    shop: { id: shop.shop_id, code: shop.shop_code, name: shop.shop_name, building_name: shop.building_name, floor_or_zone: shop.floor_or_zone, image_path: null },
    stock_source: { id: 'stock-preview', code: 'PREVIEW', name: 'จุดรับสต๊อก', kind: 'team' }, items: products, payment_profile: profile,
  };
  const noAction = () => undefined;
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setMessage('ยืนยันตัวอย่างแล้ว · ข้อมูลจำลองในเครื่อง'); };
  return <EmployeeLayout profileLabel="ตัวอย่างหน้าคอม · ข้อมูลจำลอง">
    <nav aria-label="งานพนักงาน" className="employee-task-tabs">
      {[[Package, 'เติม / คืน / ละลาย'], [Storefront, 'POS'], [Coins, 'เก็บเงิน'], [CalendarBlank, 'อีเวนต์']].map(([Icon, label]) => {
        const TaskIcon = Icon as typeof Package;
        return <button aria-current={label === 'POS' ? 'page' : undefined} key={String(label)} type="button"><TaskIcon aria-hidden size={22} /><span>{String(label)}</span></button>;
      })}
    </nav>
    <div className="employee-workspace">
      <EmployeeDeliveryReview round={round} shopCard={shop} atomicImmediateSale={false} canCollectImmediatePayment assignedStockState={null}
        deliveryQuantities={quantities} posContext={context} posContextError={null} loadingPosContext={false} paymentTerm={term}
        paymentResult={null} paymentOpen={false} paymentMethod="cash" paymentAmount="" paymentReference="" paymentEvidence={null}
        paymentEvidenceUploaded={false} paymentSubmitting={false} approvalId={approvalId} approvalReason={approvalReason} approvalSubmitting={false}
        enableAssignedStockFlow={false} iceTypes={products.map((p) => ({ id: p.ice_type_id, code: p.code, name: p.name, unit: p.unit }))}
        items={Object.entries(quantities).filter(([, quantity]) => quantity > 0).map(([ice_type_id, quantity]) => ({ ice_type_id, quantity }))}
        status="delivered" stockSourceLabel="จุดรับสต๊อก" shopCards={shops} note="" problemOpen={false} submitting={false} entryError={null}
        onBack={() => setMessage('ตัวอย่างหน้าบันทึกส่ง')} onChangeShop={(card) => { setShop(card); setQuantities({}); setMessage(''); }} onSubmit={submit}
        onChooseProblemStatus={noAction} onSetQuantity={(id, value) => setQuantities((current) => ({ ...current, [id]: Math.max(0, Math.min(12.5, Math.round(value * 2) / 2)) }))}
        onClearCart={() => setQuantities({})} onPaymentTermChange={setTerm} onPaymentMethodChange={noAction} onPaymentAmountChange={noAction}
        onPaymentReferenceChange={noAction} onPaymentEvidenceChange={noAction} onPaymentCancel={noAction} onPaymentSubmit={submit}
        onApprovalReasonChange={setApprovalReason} onRequestApproval={() => setApprovalId('preview-approval')}
        onNoteChange={noAction} onReturnToDelivery={noAction} onCorrectionSuccess={noAction} />
      {message ? <p role="status" className="employee-success">{message}</p> : null}
    </div>
  </EmployeeLayout>;
}

createRoot(document.getElementById('root')!).render(<Preview />);
