export interface ImagePathItem {
  image_path?: string | null;
  image_url?: string | null;
}

interface SignedUrlEntry {
  path?: string | null;
  signedUrl?: string | null;
}

type SignImagePaths = (paths: string[]) => Promise<{
  data: SignedUrlEntry[] | null;
  error: unknown;
}>;

export async function withSignedImageUrls<T extends ImagePathItem>(
  items: T[],
  signImagePaths: SignImagePaths,
): Promise<T[]> {
  const imagePaths = items
    .map((item) => item.image_path)
    .filter((path): path is string => Boolean(path));
  if (imagePaths.length === 0) return items;

  const { data, error } = await signImagePaths(imagePaths);
  if (error) return items;

  const imageUrls = new Map(
    (data ?? [])
      .filter((entry) => entry.path && entry.signedUrl)
      .map((entry) => [entry.path!, entry.signedUrl!]),
  );
  return items.map((item) => ({
    ...item,
    image_url: item.image_path ? imageUrls.get(item.image_path) ?? null : null,
  }));
}
