export function isTransportFailure(error: unknown) {
  const e = error as { code?: string; name?: string; status?: number; message?: string } | null;
  return error instanceof TypeError || e?.name === 'TimeoutError' || /^(08|40P01|40001|57014)/.test(e?.code ?? '')
    || [0, 502, 503, 504].includes(e?.status ?? -1)
    || /failed to fetch|load failed|network|timeout|timed out|abort/i.test(e?.message ?? '');
}
export async function withDeadline<T>(start: (signal: AbortSignal) => PromiseLike<T>, ms = 15_000): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([Promise.resolve(start(controller.signal)), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new DOMException('เชื่อมต่อนานเกินไป กรุณาตรวจสถานะรายการก่อนลองใหม่', 'TimeoutError')); controller.abort(); }, ms);
    })]);
  } finally { clearTimeout(timer!); }
}
