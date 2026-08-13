export interface PublicImagePathItem {
  image_path?: string | null;
  image_url?: string | null;
}

type GetPublicImageUrl = (path: string) => string | null;

function resolvePublicImageUrl(getPublicImageUrl: GetPublicImageUrl, path: string) {
  try {
    return getPublicImageUrl(path);
  } catch {
    return null;
  }
}

export function withPublicImageUrls<T extends PublicImagePathItem>(
  items: T[],
  getPublicImageUrl: GetPublicImageUrl,
): T[] {
  return items.map((item) => ({
    ...item,
    image_url: item.image_path
      ? resolvePublicImageUrl(getPublicImageUrl, item.image_path) ?? item.image_url ?? null
      : null,
  }));
}

export async function withAsyncPublicImageUrls<T extends PublicImagePathItem>(
  items: T[],
  getPublicImageUrls: (paths: string[]) => Promise<Array<{
    path?: string | null;
    signedUrl?: string | null;
  }>>,
): Promise<T[]> {
  const paths = [...new Set(items
    .map((item) => item.image_path)
    .filter((path): path is string => Boolean(path)))];
  const entries = paths.length > 0 ? await getPublicImageUrls(paths).catch(() => []) : [];
  const urls = new Map(entries
    .filter((entry): entry is { path: string; signedUrl: string } => Boolean(entry.path && entry.signedUrl))
    .map((entry) => [entry.path, entry.signedUrl]));
  return items.map((item) => ({
    ...item,
    image_url: item.image_path
      ? urls.get(item.image_path) ?? item.image_url ?? null
      : null,
  }));
}
