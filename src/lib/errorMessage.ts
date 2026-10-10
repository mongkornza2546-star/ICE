import { localizeErrorMessage } from '../i18n';

type ErrorDetails = {
  code?: unknown;
  details?: unknown;
  hint?: unknown;
  message?: unknown;
};

function nonEmptyText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function getErrorMessage(error: unknown, fallback = 'เกิดข้อผิดพลาด กรุณาลองใหม่') {
  if (error instanceof Error) return localizeErrorMessage(nonEmptyText(error.message) ?? fallback);
  if (typeof error === 'string') return localizeErrorMessage(nonEmptyText(error) ?? fallback);
  if (!error || typeof error !== 'object') return localizeErrorMessage(fallback);

  const details = error as ErrorDetails;
  const messages = [
    nonEmptyText(details.message),
    nonEmptyText(details.details),
    nonEmptyText(details.hint),
  ].filter((message): message is string => Boolean(message));
  const uniqueMessages = [...new Set(messages)];
  if (uniqueMessages.length > 0) return localizeErrorMessage(uniqueMessages.join(' · '));

  const code = nonEmptyText(details.code);
  return localizeErrorMessage(code ? `รหัสข้อผิดพลาด ${code}` : fallback);
}
