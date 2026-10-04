// Generated compatibility locations belong to event management, even after an event ends.
export function isEventLocationCode(code: string): boolean {
  return /^(?:SITE-)?EVENT-/i.test(code.trim());
}
