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
