import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type {
  DeliveryRound,
  EmployeeStockState,
  IceTypeOption,
  ShopCard,
  ShopRoundStatus,
} from '../../types/app';
import type { EmployeeDeliveryGateway, EmployeeDeliveryDraftState } from '../../EmployeeDeliveryWorkspace';
import { usePendingRequests } from './usePendingRequests';
import { normalizeSearch, stockQuantity, employeeErrorMessage } from './utils';

const PAD_VALUES = ['0', '1', '2', '3', '4', '5', '+'] as const;

export function useEmployeeDeliveryData({
  gateway,
  enableAssignedStockFlow = false,
  requestScope = 'default',
  stockSourceLabel = 'รถ',
  onDraftStateChange,
}: {
  gateway: EmployeeDeliveryGateway;
  enableAssignedStockFlow?: boolean;
  requestScope?: string;
  stockSourceLabel?: string;
  onDraftStateChange?: (state: EmployeeDeliveryDraftState) => void;
}) {
  const { getOrCreatePendingRequest, clearPendingRequest } = usePendingRequests();

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
  const [stockState, setStockState] = useState<EmployeeStockState | null>(null);
  const [status, setStatus] = useState<Exclude<ShopRoundStatus, 'pending'>>('delivered');
  const [problemOpen, setProblemOpen] = useState(false);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [transferSubmitting, setTransferSubmitting] = useState(false);
  const [entryError, setEntryError] = useState<string | null>(null);
  const [stockError, setStockError] = useState<string | null>(null);
  const [loadingReference, setLoadingReference] = useState(true);
  const [loadingCards, setLoadingCards] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [referenceReloadId, setReferenceReloadId] = useState(0);

  const referenceRequestId = useRef(0);
  const cardsRequestId = useRef(0);
  const stockRequestId = useRef(0);
  const activeRoundId = useRef('');
  const activeStockRoundId = useRef('');
  const browseScrollY = useRef(0);
  const returnFocusCardId = useRef<string | null>(null);
  const shopButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const submissionRequestId = useRef(0);
  const transferRequestId = useRef(0);

  useEffect(() => {
    const requestId = ++referenceRequestId.current;
    setLoadingReference(true);
    setError(null);
    void gateway.loadReferenceData().then(({ rounds: nextRounds, iceTypes: nextIceTypes }) => {
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
      setLoadingReference(false);
    }).catch((loadError: unknown) => {
      if (requestId !== referenceRequestId.current) return;
      setError(employeeErrorMessage(loadError));
      setLoadingReference(false);
    });
    return () => {
      referenceRequestId.current += 1;
    };
  }, [gateway, referenceReloadId]);

  const loadCards = useCallback(async (roundId: string) => {
    if (!roundId) {
      cardsRequestId.current += 1;
      activeRoundId.current = '';
      setCards([]);
      setLoadingCards(false);
      return false;
    }
    const requestId = ++cardsRequestId.current;
    const roundChanged = activeRoundId.current !== roundId;
    activeRoundId.current = roundId;
    if (roundChanged) setCards([]);
    setLoadingCards(true);
    setError(null);
    try {
      const nextCards = await gateway.loadShopCards(roundId);
      if (requestId !== cardsRequestId.current || activeRoundId.current !== roundId) return false;
      setCards(nextCards);
      setLoadingCards(false);
      return true;
    } catch (loadError) {
      if (requestId !== cardsRequestId.current || activeRoundId.current !== roundId) return false;
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
  const dirty = items.length > 0 || transferItems.length > 0 || status !== 'delivered' || note.trim().length > 0;

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
    });
  }, [cards, query, selectedBuildingId, selectedZone]);

  const returnToBrowse = useCallback(() => {
    setSelectedCardId(null);
    setStatus('delivered');
    setProblemOpen(false);
    setNote('');
    setEntryError(null);
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: browseScrollY.current, behavior: 'auto' });
      const focusId = returnFocusCardId.current;
      if (focusId) shopButtonRefs.current.get(focusId)?.focus();
    });
  }, []);

  const openCard = (card: ShopCard) => {
    if (enableAssignedStockFlow && !stockState) return;
    browseScrollY.current = window.scrollY;
    returnFocusCardId.current = card.round_stop_id;
    setSuccess(null);
    setEntryError(null);
    if (enableAssignedStockFlow) {
      setDeliveryQuantities(Object.fromEntries(iceTypes.map((iceType) => [iceType.id, 0])));
    }
    setSelectedCardId(card.round_stop_id);
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  const handleRecorded = async (wasDelivery: boolean) => {
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
      setSuccess(wasDelivery ? `บันทึกยอดออกจาก${sourceLabel}และร้านปลายทางแล้ว` : 'บันทึกเหตุส่งไม่ได้แล้ว');
      return;
    }
    setSuccess(null);
    setError('บันทึกสำเร็จแล้ว แต่โหลดรายการร้านล่าสุดไม่สำเร็จ กดลองใหม่เพื่อป้องกันการบันทึกซ้ำ');
  };

  const retryLoad = () => {
    setSuccess(null);
    if (selectedRoundId) {
      void Promise.all([loadCards(selectedRoundId), loadStockState(selectedRoundId)]);
      return;
    }
    setReferenceReloadId((current) => current + 1);
  };

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
    if ((status !== 'delivered' || note.trim() || (enableAssignedStockFlow && items.length > 0))
      && !window.confirm('ยังไม่ได้บันทึกเหตุของร้านนี้ ต้องการกลับไปเลือกร้านหรือไม่?')) return;
    submissionRequestId.current += 1;
    if (enableAssignedStockFlow) {
      setDeliveryQuantities(Object.fromEntries(iceTypes.map((iceType) => [iceType.id, 0])));
    }
    returnToBrowse();
  };

  const changeTransferQuantity = (iceTypeId: string, delta: number) => {
    if (transferSubmitting || selectedRound?.status === 'closed') return;
    const available = stockQuantity(stockState?.truck_location.balances, iceTypeId);
    setTransferQuantities((current) => ({
      ...current,
      [iceTypeId]: Math.max(0, Math.min(available, (current[iceTypeId] ?? 0) + delta)),
    }));
    setStockError(null);
    setSuccess(null);
  };

  const changeDeliveryQuantity = (iceTypeId: string, delta: number) => {
    if (submitting || selectedRound?.status === 'closed') return;
    const available = stockQuantity(stockState?.holding_location.balances, iceTypeId);
    setDeliveryQuantities((current) => ({
      ...current,
      [iceTypeId]: Math.max(0, Math.min(available, (current[iceTypeId] ?? 0) + delta)),
    }));
    setEntryError(null);
    setSuccess(null);
  };

  const handleStockTransfer = async () => {
    if (!selectedRound || !stockState || transferSubmitting || transferItems.length === 0) return;
    const signature = `${requestScope}:stock-transfer:${JSON.stringify({
      roundId: selectedRound.id,
      items: transferItems,
    })}`;
    const request = getOrCreatePendingRequest(signature);
    const requestId = ++transferRequestId.current;
    setTransferSubmitting(true);
    setStockError(null);
    setSuccess(null);
    try {
      const nextState = await gateway.recordEmployeeStockTransfer({
        roundId: selectedRound.id,
        items: transferItems,
        idempotencyKey: request.key,
      });
      if (requestId !== transferRequestId.current || activeStockRoundId.current !== selectedRound.id) return;
      clearPendingRequest(signature, request.key);
      setStockState(nextState);
      setTransferQuantities(Object.fromEntries(iceTypes.map((iceType) => [iceType.id, 0])));
      setSuccess(`รับน้ำแข็งเข้า ${nextState.holding_location.name} แล้ว`);
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
    const signature = `${requestScope}:${JSON.stringify({
      roundStopId: selectedCard.round_stop_id,
      items: isDelivery ? items : [],
      status,
      note: trimmedNote || null,
    })}`;
    const request = getOrCreatePendingRequest(signature);
    const requestId = ++submissionRequestId.current;
    setSubmitting(true);
    setEntryError(null);
    try {
      await gateway.recordDelivery({
        roundStopId: selectedCard.round_stop_id,
        items: isDelivery ? items : [],
        status,
        note: trimmedNote || null,
        clientRecordedAt: request.clientRecordedAt,
        idempotencyKey: request.key,
      });
      if (requestId !== submissionRequestId.current) return;
      clearPendingRequest(signature, request.key);
      await handleRecorded(isDelivery);
      if (requestId === submissionRequestId.current) setSubmitting(false);
    } catch (submitError) {
      if (requestId !== submissionRequestId.current) return;
      setEntryError(employeeErrorMessage(submitError));
      setSubmitting(false);
    }
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
    stockState,
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
    retryLoad,
    chooseRound,
    setPadValue,
    chooseProblemStatus,
    returnToDelivery,
    attemptBack,
    changeTransferQuantity,
    changeDeliveryQuantity,
    handleStockTransfer,
    handleSubmit,
    openCard,
    loadStockState,
  };
}
