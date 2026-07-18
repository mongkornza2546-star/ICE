import { useCallback, useEffect, useRef, useState } from 'react';

export interface RpcResponse<T> {
  data: T | null;
  error: { message: string } | null;
}

export interface UseRpcActionOptions<TArgs, TResult> {
  deps?: any[];
  onSuccess?: (data: TResult, args: TArgs) => void | Promise<void>;
  successMessage?: string | ((data: TResult, args: TArgs) => string);
  errorMessage?: string | ((error: any) => string);
}

export function useRpcAction<TArgs, TResult = any>(
  actionFn: (args: TArgs, idempotencyKey?: string) => Promise<RpcResponse<TResult>>,
  options: UseRpcActionOptions<TArgs, TResult> = {}
) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const actionFnRef = useRef(actionFn);
  const optionsRef = useRef(options);

  useEffect(() => {
    actionFnRef.current = actionFn;
    optionsRef.current = options;
  });

  const pendingRequestRef = useRef<{ signature: string; key: string } | null>(null);
  const requestIdRef = useRef(0);

  const execute = useCallback(
    async (args: TArgs, idempotencyConfig?: { signature: string }) => {
      let idempotencyKey: string | undefined;
      if (idempotencyConfig) {
        const { signature } = idempotencyConfig;
        if (pendingRequestRef.current?.signature === signature) {
          idempotencyKey = pendingRequestRef.current.key;
        } else {
          idempotencyKey = crypto.randomUUID();
          pendingRequestRef.current = { signature, key: idempotencyKey };
        }
      }

      const currentDeps = optionsRef.current.deps;
      const startDeps = currentDeps ? [...currentDeps] : [];
      const currentRequestId = ++requestIdRef.current;

      setIsSubmitting(true);
      setError(null);
      setSuccess(null);

      const submittedRequestKey = idempotencyKey;

      try {
        const response = await actionFnRef.current(args, idempotencyKey);

        // Check if another request started after this one
        if (currentRequestId !== requestIdRef.current) {
          return;
        }

        // Check if dependencies changed in the meantime (staleness guard)
        const latestDeps = optionsRef.current.deps;
        if (latestDeps && startDeps.length > 0) {
          const hasChanged = latestDeps.some((dep, i) => dep !== startDeps[i]);
          if (hasChanged) {
            if (submittedRequestKey && pendingRequestRef.current?.key === submittedRequestKey) {
              pendingRequestRef.current = null;
            }
            setIsSubmitting(false);
            return;
          }
        }

        if (response.error) {
          const errorMsg = typeof optionsRef.current.errorMessage === 'function'
            ? optionsRef.current.errorMessage(response.error)
            : response.error.message;
          setError(errorMsg);
        } else {
          pendingRequestRef.current = null;

          if (optionsRef.current.successMessage) {
            const successMsg = typeof optionsRef.current.successMessage === 'function'
              ? optionsRef.current.successMessage(response.data as TResult, args)
              : optionsRef.current.successMessage;
            setSuccess(successMsg);
          }

          if (optionsRef.current.onSuccess) {
            await optionsRef.current.onSuccess(response.data as TResult, args);
          }
        }
      } catch (err: any) {
        if (currentRequestId !== requestIdRef.current) {
          return;
        }
        setError(err?.message || 'เกิดข้อผิดพลาดในการดำเนินการ');
      } finally {
        if (currentRequestId === requestIdRef.current) {
          setIsSubmitting(false);
        }
      }
    },
    []
  );

  const reset = useCallback(() => {
    setError(null);
    setSuccess(null);
    pendingRequestRef.current = null;
    setIsSubmitting(false);
  }, []);

  return {
    execute,
    isSubmitting,
    error,
    setError,
    success,
    setSuccess,
    reset,
  };
}
