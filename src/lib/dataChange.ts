export type DataChangeScope =
  | 'accounting'
  | 'payment'
  | 'receivable'
  | 'refund'
  | 'stock'
  | 'pos';

export type DataChangeRecord = {
  table: string;
  eventType: string;
  id?: string;
  shopId?: string;
  serviceDate?: string;
};

export type DataChangeDetail = {
  scopes: DataChangeScope[];
  changes?: DataChangeRecord[];
};

export const DATA_CHANGE_EVENT = 'ice-data-change';

export function publishDataChange(scopes: DataChangeScope[], changes?: DataChangeRecord[]) {
  window.dispatchEvent(new CustomEvent<DataChangeDetail>(DATA_CHANGE_EVENT, {
    detail: { scopes: [...new Set(scopes)], ...(changes ? { changes } : {}) },
  }));
}

export function subscribeToDataChange(
  scopes: DataChangeScope[],
  listener: (detail: DataChangeDetail) => void,
) {
  const wanted = new Set(scopes);
  const handleChange = (event: Event) => {
    const detail = (event as CustomEvent<DataChangeDetail>).detail;
    if (detail?.scopes?.some((scope) => wanted.has(scope))) listener(detail);
  };
  window.addEventListener(DATA_CHANGE_EVENT, handleChange);
  return () => window.removeEventListener(DATA_CHANGE_EVENT, handleChange);
}
