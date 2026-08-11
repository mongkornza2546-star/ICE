import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type {
  DeliveryRound,
  DeliveryFinancialResult,
  DeliveryPosContext,
  EmployeeStockState,
  IceTypeOption,
  PaymentMethod,
  PaymentTerm,
  ShopCard,
  ShopRoundStatus,
} from '../../types/app';
import type { EmployeeDeliveryGateway, EmployeeDeliveryDraftState } from '../../EmployeeDeliveryWorkspace';
import { usePendingRequests, type PendingRequestIdentity } from './usePendingRequests';
import { compareShopCodes, normalizeSearch, stockQuantity, employeeErrorMessage } from './utils';
import { clearRecovery, readRecovery, writeRecovery } from '../../lib/recoveryStorage';
import { printSalesDocument, salesDocumentFromStored, type StoredSalesDocument } from '../../lib/salesDocumentPrint';
import { publishDataChange } from '../../lib/dataChange';

const PAD_VALUES = ['0', '1', '2', '3', '4', '5', '+'] as const;
export type StockTransferMode = 'receive' | 'return' | 'damage';

function buildImmediateSalePayloadSignature(requestScope: string, payload: {
  roundStopId: string;
  items: Array<{ ice_type_id: string; quantity: number }>;
  note: string | null;
  paymentMethod: PaymentMethod;
  receivedAmount: number;
  expectedTotal: number;
  referenceNumber: string | null;
}) {
  return `${requestScope}:immediate-sale:${JSON.stringify(payload)}`;
}

interface EmployeeWorkspaceRecovery {
  selectedRoundId: string;
  selectedBuildingId: string;
  selectedZone: string;
  query: string;
  selectedCardId: string | null;
  selectedIceTypeId: string;
  deliveryQuantities: Record<string, number>;
  transferQuantities: Record<string, number>;
  stockTransferMode: StockTransferMode;
  paymentTerm: PaymentTerm;
  paymentResult: DeliveryFinancialResult | null;
  paymentOpen: boolean;
  paymentMethod: PaymentMethod;
  paymentAmount: string;
  paymentReference: string;
  immediateSaleRetry: ImmediateSaleRetry | null;
  approvalId: string | null;
  approvalReason: string;
  status: Exclude<ShopRoundStatus, 'pending'>;
  problemOpen: boolean;
  note: string;
}

interface ImmediateSaleRetry extends PendingRequestIdentity {
  payloadSignature: string;
  storageSignature: string;
  evidence: { name: string; size: number; lastModified: number } | null;
  evidencePath: string | null;
}

export function useEmployeeDeliveryData({
  gateway,
  enableAssignedStockFlow = false,
  requestScope = 'default',
  serviceDate,
  stockSourceLabel = 'สต๊อกรวมประจำวัน',
  onDraftStateChange,
}: {
  gateway: EmployeeDeliveryGateway;
  enableAssignedStockFlow?: boolean;
  requestScope?: string;
  serviceDate: string;
  stockSourceLabel?: string;
  onDraftStateChange?: (state: EmployeeDeliveryDraftState) => void;
}) {
  const { getOrCreatePendingRequest, clearPendingRequest } = usePendingRequests();
  const recoveryMode = enableAssignedStockFlow ? 'withdrawal' : 'pos';
  const recoveryScope = `${requestScope}:${serviceDate}:${recoveryMode}`;

  const [rounds, setRounds] = useState<DeliveryRound[]>([]);
  const [iceTypes, setIceTypes] = useState<IceTypeOption[]>([]);
  const [cards, setCards] = useState<ShopCard[]>([]);
  const [selectedRoundId, setSelectedRoundId] = useState('');
  const [selectedBuildingId, setSelectedBuildingId] = useState('');
  const [selectedZone, setSelectedZone] = useState('');
  const [query, setQuery] = useState('');
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [selectedIceTypeId, setSelectedIceTypeId] = useState('');
  const [deliveryQuantities, setDeliveryQuantities] = useState<Record<string, number>>({});
  const [transferQuantities, setTransferQuantities] = useState<Record<string, number>>({});
  const [stockTransferMode, setStockTransferMode] = useState<StockTransferMode>('receive');
  const [stockState, setStockState] = useState<EmployeeStockState | null>(null);
  const [posContext, setPosContext] = useState<DeliveryPosContext | null>(null);
  const [loadingPosContext, setLoadingPosContext] = useState(false);
  const [posContextError, setPosContextError] = useState<string | null>(null);
  const [paymentTerm, setPaymentTerm] = useState<PaymentTerm>('immediate');
  const [paymentResult, setPaymentResult] = useState<DeliveryFinancialResult | null>(null);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentReference, setPaymentReference] = useState('');
  const [paymentEvidence, setPaymentEvidence] = useState<File | null>(null);
  const [immediateSaleRetry, setImmediateSaleRetry] = useState<ImmediateSaleRetry | null>(null);
  const [paymentSubmitting, setPaymentSubmitting] = useState(false);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [approvalReason, setApprovalReason] = useState('');
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  const [status, setStatus] = useState<Exclude<ShopRoundStatus, 'pending'>>('delivered');
  const [problemOpen, setProblemOpen] = useState(false);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [transferSubmitting, setTransferSubmitting] = useState(false);
  const [entryError, setEntryError] = useState<string | null>(null);
  const [stockError, setStockError] = useState<string | null>(null);
  const [loadingReference, setLoadingReference] = useState(true);
  const [loadedReferenceServiceDate, setLoadedReferenceServiceDate] = useState<string | null>(null);
  const [loadingCards, setLoadingCards] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccessMessage] = useState<string | null>(null);
  const [latestReceipt, setLatestReceipt] = useState<StoredSalesDocument | null>(null);
  const [referenceReloadId, setReferenceReloadId] = useState(0);

  const setSuccess = useCallback((message: string | null, receipt: StoredSalesDocument | null = null) => {
    setSuccessMessage(message);
    setLatestReceipt(receipt);
  }, []);

  const referenceRequestId = useRef(0);
  const cardsRequestId = useRef(0);
  const loadedCardsRoundId = useRef('');
  const stockRequestId = useRef(0);
  const posContextRequestId = useRef(0);
  const activeRoundId = useRef('');
  const activeStockRoundId = useRef('');
  const browseScrollY = useRef(0);
  const returnFocusCardId = useRef<string | null>(null);
  const shopButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const submissionRequestId = useRef(0);
  const transferRequestId = useRef(0);
  const recoveryHydratedScope = useRef<string | null>(null);
  const pendingCardRecovery = useRef<EmployeeWorkspaceRecovery | null>(null);
  const [recoveryHydrated, setRecoveryHydrated] = useState(false);
  const [recoveryReadyToPersist, setRecoveryReadyToPersist] = useState(false);
  const recoverySnapshotRef = useRef<EmployeeWorkspaceRecovery>({
    selectedRoundId,
    selectedBuildingId,
    selectedZone,
    query,
    selectedCardId,
    selectedIceTypeId,
    deliveryQuantities,
    transferQuantities,
    stockTransferMode,
    paymentTerm,
    paymentResult,
    paymentOpen,
    paymentMethod,
    paymentAmount,
    paymentReference,
    immediateSaleRetry,
    approvalId,
    approvalReason,
    status,
    problemOpen,
    note,
  });
  recoverySnapshotRef.current = {
    selectedRoundId,
    selectedBuildingId,
    selectedZone,
    query,
    selectedCardId,
    selectedIceTypeId,
    deliveryQuantities,
    transferQuantities,
    stockTransferMode,
    paymentTerm,
    paymentResult,
    paymentOpen,
    paymentMethod,
    paymentAmount,
    paymentReference,
    immediateSaleRetry,
    approvalId,
    approvalReason,
    status,
    problemOpen,
    note,
  };

  const persistRecoveryNow = (overrides: Partial<EmployeeWorkspaceRecovery>) => {
    writeRecovery(requestScope, serviceDate, recoveryMode, {
      ...recoverySnapshotRef.current,
      ...overrides,
    });
  };

  const releaseImmediateSaleRetry = (retry: ImmediateSaleRetry | null) => {
    if (!retry) return;
    clearPendingRequest(retry.storageSignature, retry.key);
    if (retry.evidencePath && gateway.deletePaymentEvidence) {
      void gateway.deletePaymentEvidence(retry.evidencePath, retry.key).catch(() => undefined);
    }
  };

  useEffect(() => {
    const requestId = ++referenceRequestId.current;
    setLoadingReference(true);
    setLoadedReferenceServiceDate(null);
    setError(null);
    void gateway.loadReferenceData(serviceDate).then(({ rounds: nextRounds, iceTypes: nextIceTypes }) => {
      if (requestId !== referenceRequestId.current) return;
      setRounds(nextRounds);
      setIceTypes(nextIceTypes);
      setSelectedIceTypeId((current) => nextIceTypes.some((iceType) => iceType.id === current)
        ? current
        : nextIceTypes[0]?.id ?? '');
      setDeliveryQuantities((current) => Object.fromEntries(
        nextIceTypes.map((iceType) => [iceType.id, current[iceType.id] ?? 0]),
      ));
      setTransferQuantities((current) => Object.fromEntries(
        nextIceTypes.map((iceType) => [iceType.id, current[iceType.id] ?? 0]),
      ));
      const openRounds = nextRounds.filter((round) => round.status === 'open');
      const automaticRound = openRounds.length === 1
        ? openRounds[0]
        : nextRounds.length === 1
          ? nextRounds[0]
          : null;
      setSelectedRoundId((current) => nextRounds.some((round) => round.id === current) ? current : automaticRound?.id ?? '');
      setLoadedReferenceServiceDate(serviceDate);
      setLoadingReference(false);
    }).catch((loadError: unknown) => {
      if (requestId !== referenceRequestId.current) return;
      setError(employeeErrorMessage(loadError));
      setLoadingReference(false);
    });
    return () => {
      referenceRequestId.current += 1;
    };
  }, [gateway, referenceReloadId, serviceDate]);

  useEffect(() => {
    recoveryHydratedScope.current = null;
    pendingCardRecovery.current = null;
    setRecoveryHydrated(false);
    setRecoveryReadyToPersist(false);
  }, [recoveryScope]);

  useEffect(() => {
    if (loadingReference
      || loadedReferenceServiceDate !== serviceDate
      || recoveryHydratedScope.current === recoveryScope) return;
    recoveryHydratedScope.current = recoveryScope;
    const saved = readRecovery<EmployeeWorkspaceRecovery>(requestScope, serviceDate, recoveryMode)?.payload;
    setRecoveryHydrated(true);
    if (!saved) {
      setRecoveryReadyToPersist(true);
      return;
    }

    const selectedRoundStillExists = rounds.some((round) => round.id === saved.selectedRoundId);
    const selectedIceTypeStillExists = iceTypes.some((iceType) => iceType.id === saved.selectedIceTypeId);
    if (!selectedRoundStillExists) {
      setRecoveryReadyToPersist(true);
      return;
    }
    pendingCardRecovery.current = {
      ...saved,
      stockTransferMode: saved.stockTransferMode === 'return' || saved.stockTransferMode === 'damage'
        ? saved.stockTransferMode
        : 'receive',
      selectedRoundId: selectedRoundStillExists ? saved.selectedRoundId : '',
      selectedIceTypeId: selectedIceTypeStillExists ? saved.selectedIceTypeId : iceTypes[0]?.id ?? '',
    };
    setSelectedBuildingId(saved.selectedBuildingId);
    setSelectedZone(saved.selectedZone);
    setQuery(saved.query);
    setStockTransferMode(saved.stockTransferMode === 'return' || saved.stockTransferMode === 'damage'
      ? saved.stockTransferMode
      : 'receive');
    setSelectedIceTypeId(selectedIceTypeStillExists ? saved.selectedIceTypeId : iceTypes[0]?.id ?? '');
    if (selectedRoundStillExists) setSelectedRoundId(saved.selectedRoundId);
  }, [iceTypes, loadedReferenceServiceDate, loadingReference, recoveryMode, recoveryScope, requestScope, rounds, serviceDate]);

  const loadCards = useCallback(async (roundId: string) => {
    if (!roundId) {
      cardsRequestId.current += 1;
      activeRoundId.current = '';
      loadedCardsRoundId.current = '';
      setCards([]);
      setLoadingCards(false);
      return false;
    }
    const requestId = ++cardsRequestId.current;
    const roundChanged = activeRoundId.current !== roundId;
    activeRoundId.current = roundId;
    if (roundChanged) {
      loadedCardsRoundId.current = '';
      setCards([]);
    }
    setLoadingCards(true);
    setError(null);
    try {
      const nextCards = await gateway.loadShopCards(roundId);
      if (requestId !== cardsRequestId.current || activeRoundId.current !== roundId) return false;
      loadedCardsRoundId.current = roundId;
      setCards(nextCards);
      setLoadingCards(false);
      return true;
    } catch (loadError) {
      if (requestId !== cardsRequestId.current || activeRoundId.current !== roundId) return false;
      loadedCardsRoundId.current = '';
      setError(employeeErrorMessage(loadError));
      setLoadingCards(false);
      return false;
    }
  }, [gateway]);

  const loadStockState = useCallback(async (roundId: string) => {
    if (!enableAssignedStockFlow || !roundId) {
      stockRequestId.current += 1;
      activeStockRoundId.current = '';
      setStockState(null);
      setStockError(null);
      return !enableAssignedStockFlow;
    }
    const requestId = ++stockRequestId.current;
    const roundChanged = activeStockRoundId.current !== roundId;
    activeStockRoundId.current = roundId;
    if (roundChanged) setStockState(null);
    setStockError(null);
    try {
      const nextState = await gateway.loadEmployeeStockState(roundId);
      if (requestId !== stockRequestId.current || activeStockRoundId.current !== roundId) return false;
      setStockState(nextState);
      return true;
    } catch (loadError) {
      if (requestId !== stockRequestId.current || activeStockRoundId.current !== roundId) return false;
      setStockState(null);
      setStockError(employeeErrorMessage(loadError));
      return false;
    }
  }, [enableAssignedStockFlow, gateway]);

  useEffect(() => {
    submissionRequestId.current += 1;
    transferRequestId.current += 1;
    setTransferSubmitting(false);
    setSelectedCardId(null);
    setPosContext(null);
    setPosContextError(null);
    setPaymentResult(null);
    setPaymentOpen(false);
    setImmediateSaleRetry(null);
    setPaymentSubmitting(false);
    setApprovalId(null);
    setApprovalReason('');
    setSelectedBuildingId('');
    setSelectedZone('');
    setDeliveryQuantities(Object.fromEntries(iceTypes.map((iceType) => [iceType.id, 0])));
    setTransferQuantities(Object.fromEntries(iceTypes.map((iceType) => [iceType.id, 0])));
    setStatus('delivered');
    setProblemOpen(false);
    setNote('');
    setEntryError(null);
    setSuccess(null);
    setStockError(null);
    void Promise.all([loadCards(selectedRoundId), loadStockState(selectedRoundId)]);
  }, [iceTypes, loadCards, loadStockState, selectedRoundId]);

  const selectedRound = rounds.find((round) => round.id === selectedRoundId) ?? null;
  const selectedCard = cards.find((card) => card.round_stop_id === selectedCardId) ?? null;
  const items = useMemo(() => iceTypes
    .map((iceType) => ({ ice_type_id: iceType.id, quantity: deliveryQuantities[iceType.id] ?? 0 }))
    .filter((item) => item.quantity > 0), [deliveryQuantities, iceTypes]);
  const transferItems = useMemo(() => iceTypes
    .map((iceType) => ({ ice_type_id: iceType.id, quantity: transferQuantities[iceType.id] ?? 0 }))
    .filter((item) => item.quantity > 0), [iceTypes, transferQuantities]);
  
  const anySubmitting = submitting || transferSubmitting;
  const dirty = items.length > 0
    || transferItems.length > 0
    || status !== 'delivered'
    || note.trim().length > 0
    || paymentOpen;

  useEffect(() => {
    onDraftStateChange?.({ dirty, submitting: anySubmitting });
  }, [anySubmitting, dirty, onDraftStateChange]);

  useEffect(() => () => {
    onDraftStateChange?.({ dirty: false, submitting: false });
  }, [onDraftStateChange]);

  const buildingOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const card of cards) options.set(card.building_id, card.building_name);
    return Array.from(options, ([id, name]) => ({ id, name }));
  }, [cards]);
  
  const zoneOptions = useMemo(() => Array.from(new Set(
    cards
      .filter((card) => !selectedBuildingId || card.building_id === selectedBuildingId)
      .map((card) => card.floor_or_zone),
  )), [cards, selectedBuildingId]);
  
  const filteredCards = useMemo(() => {
    const normalizedQuery = normalizeSearch(query);
    return cards.filter((card) => {
      if (selectedBuildingId && card.building_id !== selectedBuildingId) return false;
      if (selectedZone && card.floor_or_zone !== selectedZone) return false;
      if (!normalizedQuery) return true;
      return normalizeSearch([
        card.shop_code,
        card.shop_name,
        card.building_name,
        card.floor_or_zone,
      ].join(' ')).includes(normalizedQuery);
    }).sort((left, right) => compareShopCodes(left.shop_code, right.shop_code));
  }, [cards, query, selectedBuildingId, selectedZone]);

  const returnToBrowse = useCallback(() => {
    setSelectedCardId(null);
    setStatus('delivered');
    setProblemOpen(false);
    setNote('');
    setEntryError(null);
    setPosContext(null);
    setPosContextError(null);
    setPaymentResult(null);
    setPaymentOpen(false);
    setImmediateSaleRetry(null);
    setApprovalId(null);
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: browseScrollY.current, behavior: 'auto' });
      const focusId = returnFocusCardId.current;
      if (focusId) shopButtonRefs.current.get(focusId)?.focus();
    });
  }, []);

  const openCard = (card: ShopCard, recovery?: EmployeeWorkspaceRecovery) => {
    if (enableAssignedStockFlow && !stockState) return;
    browseScrollY.current = window.scrollY;
    returnFocusCardId.current = card.round_stop_id;
    setSuccess(null);
    setEntryError(null);
    setDeliveryQuantities(Object.fromEntries(iceTypes.map((iceType) => [iceType.id, 0])));
    setSelectedCardId(card.round_stop_id);
    setPosContext(null);
    setPosContextError(null);
    setPaymentResult(null);
    setPaymentOpen(false);
    setImmediateSaleRetry(null);
    if (recovery) {
      setDeliveryQuantities(recovery.deliveryQuantities);
      setStatus(recovery.status);
      setProblemOpen(recovery.problemOpen);
      setNote(recovery.note);
      setPaymentTerm(recovery.paymentTerm);
      setPaymentResult(recovery.paymentResult);
      setPaymentOpen(recovery.paymentOpen && Boolean(recovery.paymentResult));
      setPaymentMethod(recovery.paymentMethod);
      setPaymentAmount(recovery.paymentAmount);
      setPaymentReference(recovery.paymentReference);
      setImmediateSaleRetry(recovery.immediateSaleRetry ?? null);
      setApprovalId(recovery.approvalId);
      setApprovalReason(recovery.approvalReason);
    }
    const loadPosContext = gateway.loadDeliveryPosContext;
    if (loadPosContext) {
      const requestId = ++posContextRequestId.current;
      setLoadingPosContext(true);
      void loadPosContext(card.round_stop_id).then((context) => {
        if (requestId !== posContextRequestId.current) return;
        setPosContext(context);
        setDeliveryQuantities((current) => Object.fromEntries(
          iceTypes.map((iceType) => {
            const available = context.items.find((item) => item.ice_type_id === iceType.id)?.stock_quantity ?? 0;
            const intended = recovery?.deliveryQuantities[iceType.id] ?? current[iceType.id] ?? 0;
            return [iceType.id, Math.min(intended, available)];
          }),
        ));
        if (!recovery) {
          setPaymentTerm(context.payment_profile?.default_payment_term ?? 'immediate');
          setPaymentMethod(context.payment_profile?.default_payment_method ?? 'cash');
        }
        setPaymentEvidence(null);
        setLoadingPosContext(false);
      }).catch((loadError: unknown) => {
        if (requestId !== posContextRequestId.current) return;
        setPosContextError(employeeErrorMessage(loadError));
        setLoadingPosContext(false);
      });
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  useEffect(() => {
    const saved = pendingCardRecovery.current;
    if (!saved || loadingCards || loadedCardsRoundId.current !== selectedRoundId || saved.selectedRoundId !== selectedRoundId) return;
    if (enableAssignedStockFlow && !stockState) return;
    pendingCardRecovery.current = null;
    setTransferQuantities(saved.transferQuantities);
    const card = cards.find((candidate) => candidate.round_stop_id === saved.selectedCardId);
    if (card) openCard(card, saved);
    setRecoveryReadyToPersist(true);
  }, [cards, enableAssignedStockFlow, loadingCards, selectedRoundId, stockState]);

  useEffect(() => {
    if (!recoveryHydrated
      || !recoveryReadyToPersist
      || recoveryHydratedScope.current !== recoveryScope
      || pendingCardRecovery.current) return;
    const shouldPersist = Boolean(selectedCardId)
      || transferItems.length > 0
      || items.length > 0
      || status !== 'delivered'
      || note.trim().length > 0
      || paymentOpen;
    if (!shouldPersist) {
      clearRecovery(requestScope, serviceDate, recoveryMode);
      return;
    }
    const timeout = window.setTimeout(() => {
      writeRecovery(requestScope, serviceDate, recoveryMode, recoverySnapshotRef.current);
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [approvalId, approvalReason, deliveryQuantities, immediateSaleRetry, items.length, note, paymentAmount, paymentMethod, paymentOpen, paymentReference, paymentResult, paymentTerm, problemOpen, query, recoveryHydrated, recoveryMode, recoveryReadyToPersist, requestScope, selectedBuildingId, selectedCardId, selectedIceTypeId, selectedRoundId, selectedZone, serviceDate, status, stockTransferMode, transferItems.length, transferQuantities]);

  const changeShop = (card: ShopCard) => {
    if (card.round_stop_id === selectedCardId) return;
    if (items.length > 0 && !window.confirm('เปลี่ยนร้านแล้ว รายการในตะกร้าจะถูกล้าง ต้องการเปลี่ยนร้านหรือไม่?')) return;
    openCard(card);
  };

  const handleRecorded = async (wasDelivery: boolean, result?: DeliveryFinancialResult | void) => {
    const [cardsRefreshed, stockRefreshed] = await Promise.all([
      loadCards(selectedRoundId),
      loadStockState(selectedRoundId),
    ]);
    if (wasDelivery || enableAssignedStockFlow) {
      setDeliveryQuantities(Object.fromEntries(iceTypes.map((iceType) => [iceType.id, 0])));
    }
    returnToBrowse();
    if (cardsRefreshed && stockRefreshed) {
      const sourceLabel = enableAssignedStockFlow ? stockState?.holding_location.name ?? 'จุดถือครอง' : stockSourceLabel;
      const creditDueDate = result?.payment_term === 'credit' && result.due_date
        ? ` ครบกำหนด ${result.due_date}`
        : '';
      setSuccess(wasDelivery ? `บันทึกยอดออกจาก${sourceLabel} และร้านปลายทางแล้ว${creditDueDate}` : 'บันทึกเหตุส่งไม่ได้แล้ว');
      return;
    }
    setSuccess(null);
    setError('บันทึกสำเร็จแล้ว แต่โหลดรายการร้านล่าสุดไม่สำเร็จ กดลองใหม่เพื่อป้องกันการบันทึกซ้ำ');
  };

  const retryLoad = useCallback(() => {
    setSuccess(null);
    if (selectedRoundId) {
      void Promise.all([loadCards(selectedRoundId), loadStockState(selectedRoundId)]);
      return;
    }
    setReferenceReloadId((current) => current + 1);
  }, [loadCards, loadStockState, selectedRoundId]);

  const chooseRound = (roundId: string) => {
    if (anySubmitting) return;
    if (dirty && !window.confirm('เปลี่ยนรอบแล้ว ยอดน้ำแข็งที่กรอกไว้จะถูกล้าง ต้องการเปลี่ยนรอบหรือไม่?')) return;
    setSelectedRoundId(roundId);
  };

  const setPadValue = (value: typeof PAD_VALUES[number]) => {
    if (!selectedIceTypeId || submitting || selectedRound?.status === 'closed') return;
    setDeliveryQuantities((current) => ({
      ...current,
      [selectedIceTypeId]: value === '+' ? (current[selectedIceTypeId] ?? 0) + 1 : Number(value),
    }));
    setApprovalId(null);
    setApprovalReason('');
    setEntryError(null);
    setSuccess(null);
  };

  const setDeliveryQuantity = (iceTypeId: string, quantity: number) => {
    if (submitting || selectedRound?.status === 'closed') return;
    const contextItem = posContext?.items.find((item) => item.ice_type_id === iceTypeId);
    const assignedAvailable = stockQuantity(stockState?.holding_location.balances, iceTypeId);
    const available = contextItem?.stock_quantity
      ?? (enableAssignedStockFlow ? assignedAvailable : Number.MAX_SAFE_INTEGER);
    setDeliveryQuantities((current) => ({
      ...current,
      [iceTypeId]: Math.max(0, Math.min(available, Math.round(quantity * 2) / 2)),
    }));
    setApprovalId(null);
    setApprovalReason('');
    setEntryError(null);
    setSuccess(null);
  };

  const chooseProblemStatus = (nextStatus: Exclude<ShopRoundStatus, 'pending' | 'delivered'>) => {
    setStatus(nextStatus);
    setProblemOpen(true);
    setEntryError(null);
  };

  const returnToDelivery = () => {
    setStatus('delivered');
    setProblemOpen(false);
    setNote('');
    setEntryError(null);
  };

  const attemptBack = () => {
    if (submitting) return;
    if ((status !== 'delivered' || note.trim() || items.length > 0)
      && !window.confirm('ยังไม่ได้บันทึกเหตุของร้านนี้ ต้องการกลับไปเลือกร้านหรือไม่?')) return;
    submissionRequestId.current += 1;
    setDeliveryQuantities(Object.fromEntries(iceTypes.map((iceType) => [iceType.id, 0])));
    returnToBrowse();
  };

  const cancelImmediateSaleDraft = () => {
    if (paymentSubmitting || !paymentOpen) return;
    if (!window.confirm('กลับไปแก้รายการและยกเลิกข้อมูลรับเงินนี้หรือไม่?')) return;
    releaseImmediateSaleRetry(immediateSaleRetry);
    persistRecoveryNow({
      paymentResult: null,
      paymentOpen: false,
      paymentAmount: '',
      paymentReference: '',
      immediateSaleRetry: null,
    });
    setPaymentResult(null);
    setPaymentOpen(false);
    setPaymentAmount('');
    setPaymentReference('');
    setPaymentEvidence(null);
    setImmediateSaleRetry(null);
    setEntryError(null);
  };

  const changeTransferQuantity = (iceTypeId: string, delta: number) => {
    if (transferSubmitting || selectedRound?.status === 'closed') return;
    const available = stockQuantity(
      stockTransferMode === 'return' || stockTransferMode === 'damage'
        ? stockState?.holding_location.balances
        : stockState?.truck_location.balances,
      iceTypeId,
    );
    setTransferQuantities((current) => ({
      ...current,
      [iceTypeId]: Math.max(0, Math.min(available, (current[iceTypeId] ?? 0) + delta)),
    }));
    setStockError(null);
    setSuccess(null);
  };

  const changeStockTransferMode = (nextMode: StockTransferMode) => {
    if (nextMode === stockTransferMode || transferSubmitting) return;
    if (transferItems.length > 0
      && !window.confirm('เปลี่ยนประเภทรายการแล้ว จำนวนที่กรอกไว้จะถูกล้าง ต้องการเปลี่ยนหรือไม่?')) return;
    const clearedTransferQuantities = Object.fromEntries(iceTypes.map((iceType) => [iceType.id, 0]));
    persistRecoveryNow({
      stockTransferMode: nextMode,
      transferQuantities: clearedTransferQuantities,
    });
    setStockTransferMode(nextMode);
    setTransferQuantities(clearedTransferQuantities);
    setStockError(null);
    setSuccess(null);
  };

  const handleStockTransfer = async () => {
    if (!selectedRound || !stockState || transferSubmitting || transferItems.length === 0) return;
    const operation = stockTransferMode === 'return'
      ? 'stock-return'
      : stockTransferMode === 'damage'
        ? 'stock-damage'
        : 'stock-transfer';
    const signature = `${requestScope}:${operation}:${JSON.stringify({
      roundId: selectedRound.id,
      items: transferItems,
    })}`;
    const request = getOrCreatePendingRequest(signature);
    const requestId = ++transferRequestId.current;
    setTransferSubmitting(true);
    setStockError(null);
    setSuccess(null);
    try {
      const recordStockMovement = stockTransferMode === 'return'
        ? gateway.recordEmployeeStockReturn
        : stockTransferMode === 'damage'
          ? gateway.recordEmployeeStockDamage
          : gateway.recordEmployeeStockTransfer;
      const nextState = await recordStockMovement({
        roundId: selectedRound.id,
        items: transferItems,
        idempotencyKey: request.key,
      });
      publishDataChange(['accounting', 'stock']);
      if (requestId !== transferRequestId.current || activeStockRoundId.current !== selectedRound.id) return;
      const clearedTransferQuantities = Object.fromEntries(iceTypes.map((iceType) => [iceType.id, 0]));
      persistRecoveryNow({ transferQuantities: clearedTransferQuantities });
      clearPendingRequest(signature, request.key);
      setStockState(nextState);
      setTransferQuantities(clearedTransferQuantities);
      setSuccess(stockTransferMode === 'return'
        ? `คืนน้ำแข็งขึ้น ${nextState.truck_location.name} แล้ว`
        : stockTransferMode === 'damage'
          ? `บันทึกน้ำแข็งละลายจาก ${nextState.holding_location.name} แล้ว`
          : `เติมน้ำแข็งเข้า ${nextState.holding_location.name} แล้ว`);
    } catch (transferError) {
      if (requestId !== transferRequestId.current || activeStockRoundId.current !== selectedRound.id) return;
      setStockError(employeeErrorMessage(transferError));
    } finally {
      if (requestId === transferRequestId.current) setTransferSubmitting(false);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedCard || !selectedRound || submitting) return;
    const trimmedNote = note.trim();
    const isDelivery = status === 'delivered';
    if (isDelivery && items.length === 0) {
      setEntryError(enableAssignedStockFlow
        ? 'ใส่จำนวนน้ำแข็งที่ส่งอย่างน้อย 1 รายการ'
        : `ใส่จำนวนน้ำแข็งที่หยิบออกจาก${stockSourceLabel}อย่างน้อย 1 รายการ`);
      return;
    }
    if (!isDelivery && !trimmedNote) {
      setEntryError('ใส่หมายเหตุว่าเกิดอะไรขึ้นกับร้าน');
      return;
    }
    if (isDelivery && gateway.loadDeliveryPosContext) {
      if (!posContext?.payment_profile) {
        setEntryError('ร้านนี้ยังไม่มีเงื่อนไขการชำระเงิน จึงยังบันทึกส่งไม่ได้');
        return;
      }
      const missingPrice = items.find((item) => (
        posContext.items.find((contextItem) => contextItem.ice_type_id === item.ice_type_id)?.unit_price == null
      ));
      if (missingPrice) {
        const iceType = iceTypes.find((option) => option.id === missingPrice.ice_type_id);
        setEntryError(`${iceType?.name ?? 'สินค้าที่เลือก'} ยังไม่มีราคาในวันที่ส่ง`);
        return;
      }
      if (paymentTerm === 'credit'
        && posContext.payment_profile.credit_remaining != null
        && items.reduce((total, item) => {
          const contextItem = posContext.items.find((candidate) => candidate.ice_type_id === item.ice_type_id);
          return total + item.quantity * (contextItem?.unit_price ?? 0);
        }, 0) > posContext.payment_profile.credit_remaining
        && !approvalId) {
        setEntryError('ยอดนี้เกินวงเงินเครดิต ต้องขออนุมัติและได้รับอนุมัติก่อนบันทึกส่ง');
        return;
      }
    }
    if (isDelivery && paymentTerm === 'immediate' && gateway.recordImmediateSale) {
      const totalAmount = items.reduce((total, item) => {
        const contextItem = posContext?.items.find((candidate) => candidate.ice_type_id === item.ice_type_id);
        return total + item.quantity * (contextItem?.unit_price ?? 0);
      }, 0);
      const draftResult: DeliveryFinancialResult = {
        delivery_event_id: '',
        round_stop_id: selectedCard.round_stop_id,
        charge_id: null,
        service_date: selectedRound.service_date,
        total_amount: totalAmount,
        payment_term: 'immediate',
        payment_status: 'unpaid',
        due_date: null,
        approval_id: null,
        items: items.map((item) => {
          const contextItem = posContext?.items.find((candidate) => candidate.ice_type_id === item.ice_type_id);
          return {
            ...item,
            name: contextItem?.name,
            unit: contextItem?.unit,
            unit_price: contextItem?.unit_price ?? null,
            line_total: item.quantity * (contextItem?.unit_price ?? 0),
            price_source: contextItem?.price_source ?? null,
            price_source_id: contextItem?.price_source_id ?? null,
          };
        }),
      };
      persistRecoveryNow({
        paymentResult: draftResult,
        paymentOpen: true,
        paymentAmount: String(totalAmount),
        immediateSaleRetry: null,
        approvalId: null,
        approvalReason: '',
      });
      setPaymentResult(draftResult);
      setPaymentOpen(true);
      setPaymentAmount(String(totalAmount));
      setImmediateSaleRetry(null);
      setApprovalId(null);
      setApprovalReason('');
      setEntryError(null);
      return;
    }
    const signature = `${requestScope}:${JSON.stringify({
      roundStopId: selectedCard.round_stop_id,
      items: isDelivery ? items : [],
      status,
      note: trimmedNote || null,
      paymentTerm: isDelivery ? paymentTerm : null,
      approvalId,
    })}`;
    const request = getOrCreatePendingRequest(signature);
    const requestId = ++submissionRequestId.current;
    setSubmitting(true);
    setEntryError(null);
    try {
      const result = await gateway.recordDelivery({
        roundStopId: selectedCard.round_stop_id,
        items: isDelivery ? items : [],
        status,
        note: trimmedNote || null,
        clientRecordedAt: request.clientRecordedAt,
        idempotencyKey: request.key,
        paymentTerm: isDelivery ? paymentTerm : null,
        approvalId,
      });
      publishDataChange(['accounting', 'stock', 'pos', 'receivable']);
      if (requestId !== submissionRequestId.current) return;
      if (result && isDelivery && result.payment_term === 'immediate' && result.charge_id) {
        const nextPaymentAmount = String(result.total_amount ?? '');
        persistRecoveryNow({
          paymentResult: result,
          paymentOpen: true,
          paymentAmount: nextPaymentAmount,
          approvalId: null,
          approvalReason: '',
        });
        clearPendingRequest(signature, request.key);
        setPaymentResult(result);
        setPaymentOpen(true);
        setPaymentAmount(nextPaymentAmount);
        setApprovalId(null);
        setApprovalReason('');
        setSubmitting(false);
        return;
      }
      clearRecovery(requestScope, serviceDate, recoveryMode);
      clearPendingRequest(signature, request.key);
      await handleRecorded(isDelivery, result);
      if (requestId === submissionRequestId.current) setSubmitting(false);
    } catch (submitError) {
      if (requestId !== submissionRequestId.current) return;
      setEntryError(employeeErrorMessage(submitError));
      setSubmitting(false);
    }
  };

  const handleRequestApproval = async () => {
    if (!selectedCard || !posContext || !gateway.requestFinancialApproval || approvalSubmitting) return;
    const reason = approvalReason.trim();
    if (!reason) {
      setEntryError('ใส่เหตุผลที่ขออนุมัติ');
      return;
    }
    setApprovalSubmitting(true);
    setEntryError(null);
    try {
      const paymentOutstandingAmount = paymentOpen && paymentResult?.charge_id
        ? Math.max((paymentResult.total_amount ?? 0) - Math.min(
          Number(paymentAmount) || 0,
          paymentResult.total_amount ?? 0,
        ), 0)
        : null;
      const requestedAmount = paymentOutstandingAmount ?? items.reduce((total, item) => {
        const contextItem = posContext.items.find((candidate) => candidate.ice_type_id === item.ice_type_id);
        return total + item.quantity * (contextItem?.unit_price ?? 0);
      }, 0);
      const approval = await gateway.requestFinancialApproval({
        roundStopId: selectedCard.round_stop_id,
        kind: paymentOutstandingAmount == null ? 'credit_limit' : 'outstanding_balance',
        items,
        paymentTerm: paymentOutstandingAmount == null ? paymentTerm : 'immediate',
        requestedAmount,
        reason,
        chargeId: paymentOutstandingAmount == null ? null : paymentResult?.charge_id,
      });
      if (approval.status === 'approved') {
        setApprovalId(approval.id);
        setSuccess('คำขอได้รับอนุมัติแล้ว บันทึกส่งได้');
      } else {
        setSuccess('ส่งคำขออนุมัติแล้ว กดตรวจสถานะอีกครั้งหลังหัวหน้าอนุมัติ');
      }
    } catch (approvalError) {
      setEntryError(employeeErrorMessage(approvalError));
    } finally {
      setApprovalSubmitting(false);
    }
  };

  const handlePaymentSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedCard || !paymentResult?.total_amount
      || (!gateway.recordImmediateSale && !gateway.recordPayment) || paymentSubmitting) return;
    const usesAtomicSale = Boolean(gateway.recordImmediateSale);
    const receivedAmount = Number(paymentAmount);
    if (!Number.isFinite(receivedAmount) || receivedAmount <= 0) {
      setEntryError('ใส่ยอดรับเงินที่ถูกต้อง');
      return;
    }
    if (usesAtomicSale && paymentMethod === 'cash' && receivedAmount < paymentResult.total_amount) {
      setEntryError('ขายสดต้องรับเงินสดครบยอดก่อนบันทึก');
      return;
    }
    if (usesAtomicSale && paymentMethod !== 'cash' && receivedAmount !== paymentResult.total_amount) {
      setEntryError('ยอดโอนหรือ QR ต้องเท่ากับยอดเรียกเก็บ');
      return;
    }
    if (!usesAtomicSale && paymentMethod !== 'cash' && receivedAmount > paymentResult.total_amount) {
      setEntryError('ยอดโอนหรือ QR ต้องไม่เกินยอดเรียกเก็บ');
      return;
    }
    const allocatedAmount = Math.min(receivedAmount, paymentResult.total_amount);
    const atomicPayloadSignature = buildImmediateSalePayloadSignature(requestScope, {
      roundStopId: selectedCard.round_stop_id,
      items,
      note: note.trim() || null,
      paymentMethod,
      receivedAmount,
      expectedTotal: paymentResult.total_amount,
      referenceNumber: paymentReference.trim() || null,
    });
    const evidenceMetadata = paymentEvidence ? {
      name: paymentEvidence.name,
      size: paymentEvidence.size,
      lastModified: paymentEvidence.lastModified,
    } : immediateSaleRetry?.payloadSignature === atomicPayloadSignature
      ? immediateSaleRetry.evidence
      : null;
    const atomicStorageSignature = `${atomicPayloadSignature}:evidence:${JSON.stringify(evidenceMetadata)}`;
    const reusableAtomicRetry = usesAtomicSale
      && immediateSaleRetry?.payloadSignature === atomicPayloadSignature
      && immediateSaleRetry.storageSignature === atomicStorageSignature
      ? immediateSaleRetry
      : null;
    const signature = usesAtomicSale
      ? atomicStorageSignature
      : `${requestScope}:payment:${JSON.stringify({
        chargeId: paymentResult.charge_id,
        paymentMethod,
        receivedAmount,
        allocatedAmount,
        referenceNumber: paymentReference.trim() || null,
      })}`;
    const request = reusableAtomicRetry ?? getOrCreatePendingRequest(signature);
    let atomicRetry = reusableAtomicRetry;
    if (usesAtomicSale && !atomicRetry) {
      releaseImmediateSaleRetry(immediateSaleRetry);
      atomicRetry = {
        ...request,
        payloadSignature: atomicPayloadSignature,
        storageSignature: atomicStorageSignature,
        evidence: evidenceMetadata,
        evidencePath: null,
      };
      setImmediateSaleRetry(atomicRetry);
      persistRecoveryNow({ immediateSaleRetry: atomicRetry });
    }
    setPaymentSubmitting(true);
    setEntryError(null);
    try {
      let evidencePath = atomicRetry?.evidencePath ?? null;
      if (paymentEvidence && gateway.uploadPaymentEvidence) {
        evidencePath = await gateway.uploadPaymentEvidence(paymentEvidence, request.key);
        if (atomicRetry && evidencePath !== atomicRetry.evidencePath) {
          atomicRetry = { ...atomicRetry, evidencePath };
          setImmediateSaleRetry(atomicRetry);
          persistRecoveryNow({ immediateSaleRetry: atomicRetry });
        }
      }
      if (!usesAtomicSale) {
        if (!gateway.recordPayment || !paymentResult.charge_id) return;
        await gateway.recordPayment({
          shopId: selectedCard.shop_id,
          chargeId: paymentResult.charge_id,
          paymentMethod,
          receivedAmount,
          allocatedAmount,
          referenceNumber: paymentReference.trim() || null,
          evidencePath,
          expectedOutstandingAmount: paymentResult.total_amount,
          approvalId,
          idempotencyKey: request.key,
        });
        publishDataChange(['accounting', 'payment', 'receivable']);
        clearRecovery(requestScope, serviceDate, recoveryMode);
        clearPendingRequest(signature, request.key);
        setPaymentOpen(false);
        await handleRecorded(true);
        return;
      }
      const sale = await gateway.recordImmediateSale!({
          roundStopId: selectedCard.round_stop_id,
          items,
          note: note.trim() || null,
          clientRecordedAt: request.clientRecordedAt,
          paymentMethod,
          receivedAmount,
          referenceNumber: paymentReference.trim() || null,
          evidencePath,
          expectedTotal: paymentResult.total_amount,
          idempotencyKey: request.key,
      });
      publishDataChange(['accounting', 'payment', 'receivable', 'stock', 'pos']);
      clearRecovery(requestScope, serviceDate, recoveryMode);
      clearPendingRequest(signature, request.key);
      setImmediateSaleRetry(null);
      setPaymentOpen(false);
      await handleRecorded(true, sale.delivery);
      setSuccess(`บันทึกขายสดและออก ${sale.receipt_number} แล้ว`, sale.print_document);
    } catch (paymentError) {
      const rawMessage = paymentError instanceof Error
        ? paymentError.message
        : typeof paymentError === 'object' && paymentError && 'message' in paymentError
          ? String(paymentError.message)
          : String(paymentError);
      if (usesAtomicSale
        && rawMessage.toLowerCase().includes('immediate sale total changed')
        && gateway.loadDeliveryPosContext) {
        releaseImmediateSaleRetry(atomicRetry);
        setImmediateSaleRetry(null);
        try {
          const refreshedContext = await gateway.loadDeliveryPosContext(selectedCard.round_stop_id);
          const refreshedTotal = items.reduce((total, item) => {
            const refreshedItem = refreshedContext.items.find((candidate) => candidate.ice_type_id === item.ice_type_id);
            return total + item.quantity * (refreshedItem?.unit_price ?? 0);
          }, 0);
          const refreshedResult: DeliveryFinancialResult = {
            ...paymentResult,
            total_amount: refreshedTotal,
            items: items.map((item) => {
              const refreshedItem = refreshedContext.items.find((candidate) => candidate.ice_type_id === item.ice_type_id);
              return {
                ...item,
                name: refreshedItem?.name,
                unit: refreshedItem?.unit,
                unit_price: refreshedItem?.unit_price ?? null,
                line_total: item.quantity * (refreshedItem?.unit_price ?? 0),
                price_source: refreshedItem?.price_source ?? null,
                price_source_id: refreshedItem?.price_source_id ?? null,
              };
            }),
          };
          setPosContext(refreshedContext);
          setPaymentResult(refreshedResult);
          setPaymentAmount(String(refreshedTotal));
          persistRecoveryNow({
            paymentResult: refreshedResult,
            paymentAmount: String(refreshedTotal),
            immediateSaleRetry: null,
          });
          setEntryError('ราคาเปลี่ยนแล้ว ระบบโหลดราคาล่าสุดให้แล้ว กรุณาตรวจสอบและยืนยันรับเงินอีกครั้ง');
        } catch (refreshError) {
          setEntryError(`ราคาเปลี่ยน แต่โหลดราคาล่าสุดไม่สำเร็จ: ${employeeErrorMessage(refreshError)}`);
        }
      } else {
        setEntryError(employeeErrorMessage(paymentError));
      }
    } finally {
      setPaymentSubmitting(false);
      setSubmitting(false);
    }
  };

  const changePaymentAmount = (amount: string) => {
    setPaymentAmount(amount);
    setApprovalId(null);
    setApprovalReason('');
    setEntryError(null);
  };

  const changePaymentTerm = (term: PaymentTerm) => {
    setPaymentTerm(term);
    setApprovalId(null);
    setApprovalReason('');
    setEntryError(null);
  };

  const clearDeliveryQuantities = () => {
    if (submitting || selectedRound?.status === 'closed') return;
    setDeliveryQuantities(Object.fromEntries(iceTypes.map((iceType) => [iceType.id, 0])));
    setApprovalId(null);
    setApprovalReason('');
    setEntryError(null);
  };

  const currentImmediateSalePayloadSignature = selectedCard && paymentResult?.total_amount
    ? buildImmediateSalePayloadSignature(requestScope, {
      roundStopId: selectedCard.round_stop_id,
      items,
      note: note.trim() || null,
      paymentMethod,
      receivedAmount: Number(paymentAmount),
      expectedTotal: paymentResult.total_amount,
      referenceNumber: paymentReference.trim() || null,
    })
    : null;
  const paymentEvidenceUploaded = Boolean(
    immediateSaleRetry?.evidencePath
      && immediateSaleRetry.payloadSignature === currentImmediateSalePayloadSignature,
  );
  const latestReceiptAvailable = Boolean(latestReceipt);
  const printLatestReceipt = () => {
    if (!latestReceipt) return;
    const printed = printSalesDocument(salesDocumentFromStored(latestReceipt));
    if (!printed) setError('เบราว์เซอร์บล็อกหน้าต่างพิมพ์ กรุณาอนุญาตป๊อปอัปแล้วลองใหม่');
  };

  return {
    rounds,
    iceTypes,
    cards,
    selectedRoundId,
    selectedBuildingId,
    selectedZone,
    query,
    selectedCardId,
    selectedIceTypeId,
    deliveryQuantities,
    transferQuantities,
    stockTransferMode,
    stockState,
    posContext,
    loadingPosContext,
    posContextError,
    paymentTerm,
    paymentResult,
    paymentOpen,
    paymentMethod,
    paymentAmount,
    paymentReference,
    paymentEvidence,
    paymentEvidenceUploaded,
    paymentSubmitting,
    approvalId,
    approvalReason,
    approvalSubmitting,
    status,
    problemOpen,
    note,
    submitting,
    transferSubmitting,
    entryError,
    stockError,
    loadingReference,
    loadingCards,
    error,
    success,
    latestReceiptAvailable,
    selectedRound,
    selectedCard,
    items,
    transferItems,
    anySubmitting,
    buildingOptions,
    zoneOptions,
    filteredCards,
    shopButtonRefs,
    PAD_VALUES,
    
    // Actions
    setSelectedBuildingId,
    setSelectedZone,
    setQuery,
    setSelectedIceTypeId,
    setNote,
    setPaymentTerm: changePaymentTerm,
    setPaymentMethod,
    setPaymentAmount: changePaymentAmount,
    setPaymentReference,
    setPaymentEvidence,
    setApprovalReason,
    retryLoad,
    printLatestReceipt,
    chooseRound,
    setPadValue,
    chooseProblemStatus,
    returnToDelivery,
    attemptBack,
    changeTransferQuantity,
    changeStockTransferMode,
    setDeliveryQuantity,
    clearDeliveryQuantities,
    handleStockTransfer,
    handleSubmit,
    handlePaymentSubmit,
    cancelImmediateSaleDraft,
    handleRequestApproval,
    openCard,
    changeShop,
    loadStockState,
  };
}
