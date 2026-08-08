export type DataChangeScope =
  | 'accounting'
  | 'payment'
  | 'receivable'
  | 'refund'
  | 'stock'
  | 'pos';

export type DataChangeDetail = {
  scopes: DataChangeScope[];
};

export const DATA_CHANGE_EVENT = 'ice-data-change';

export function publishDataChange(scopes: DataChangeScope[]) {
  window.dispatchEvent(new CustomEvent<DataChangeDetail>(DATA_CHANGE_EVENT, {
    detail: { scopes: [...new Set(scopes)] },
  }));
}

export function subscribeToDataChange(
  scopes: DataChangeScope[],
  listener: () => void,
) {
  const wanted = new Set(scopes);
  const handleChange = (event: Event) => {
    const detail = (event as CustomEvent<DataChangeDetail>).detail;
    if (detail?.scopes?.some((scope) => wanted.has(scope))) listener();
  };
  window.addEventListener(DATA_CHANGE_EVENT, handleChange);
  return () => window.removeEventListener(DATA_CHANGE_EVENT, handleChange);
}
