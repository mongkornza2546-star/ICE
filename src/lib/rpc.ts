interface RpcLikeError {
  code?: string;
  message?: string;
}

export function isMissingRpc(error: RpcLikeError | null | undefined) {
  if (!error) return false;
  const message = error.message?.toLowerCase() ?? '';
  return error.code === 'PGRST202'
    || message.includes('could not find the function')
    || message.includes('function public.');
}
