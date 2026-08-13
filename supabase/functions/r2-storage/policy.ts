export const R2_NAMESPACES = [
  'shop-images',
  'ice-type-images',
  'user-avatars',
  'tank-images',
  'payment-evidence',
  'credit-signoff-evidence',
] as const;

export type R2Namespace = typeof R2_NAMESPACES[number];

const adminWriteNamespaces = new Set<R2Namespace>([
  'shop-images', 'ice-type-images', 'user-avatars', 'tank-images',
]);
const evidenceNamespaces = new Set<R2Namespace>([
  'payment-evidence', 'credit-signoff-evidence',
]);
const imageMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function isValidR2Path(path: string) {
  return path.includes('/r2/') && !path.includes('..') && !path.startsWith('/');
}

function ownsEvidencePath(namespace: R2Namespace, path: string, userId: string) {
  return !evidenceNamespaces.has(namespace) || path.startsWith(`${userId}/`);
}

export function canUploadR2Object(
  namespace: R2Namespace,
  path: string,
  userId: string,
  role: string,
) {
  return isValidR2Path(path)
    && ownsEvidencePath(namespace, path, userId)
    && (!adminWriteNamespaces.has(namespace) || role === 'admin');
}

export function canSignR2Object(
  namespace: R2Namespace,
  path: string,
  userId: string,
  role: string,
) {
  if (!isValidR2Path(path)) return false;
  if (namespace === 'credit-signoff-evidence') return true;
  if (namespace === 'payment-evidence') {
    return path.startsWith(`${userId}/`) || role === 'admin' || role === 'round_lead';
  }
  return true;
}

export function canDeleteR2Objects(
  namespace: R2Namespace,
  paths: string[],
  userId: string,
  role: string,
) {
  if (paths.some((path) => !isValidR2Path(path))) return false;
  if (adminWriteNamespaces.has(namespace)) return role === 'admin';
  return role === 'admin' || paths.every((path) => path.startsWith(`${userId}/`));
}

export function isAllowedR2MimeType(namespace: R2Namespace, mimeType: string) {
  return imageMimeTypes.has(mimeType)
    || (namespace === 'payment-evidence' && mimeType === 'application/pdf');
}
