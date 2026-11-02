import { Blob as NodeBlob } from 'node:buffer';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: { functions: { invoke: mocks.invoke } } }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));
let EmployeePosProductImage: typeof import('../src/features/employee-delivery/EmployeePosProductImage').EmployeePosProductImage;
let getR2ObjectUrl: typeof import('../src/lib/r2Storage').getR2ObjectUrl;
let catalogImageCacheKey: typeof import('../src/lib/catalogImageCache').catalogImageCacheKey;
const path = 'ice-types/probe/r2/photo.webp';
const source = `https://bucket.account.r2.cloudflarestorage.com/ice-type-images/${path}?X-Amz-Signature=valid`;
const urlCacheKey = `ice-r2-catalog-url:v1:ice-type-images:${path}`;
const disk = new Map<string, Response>();
const network = vi.fn();
const cache = {
  keys: async () => [...disk.keys()].map(url => new Request(url)),
  match: async (key: string | Request) => disk.get(typeof key === 'string' ? key : key.url)?.clone(),
  put: async (key: string, response: Response) => { disk.set(key, response.clone()); },
  delete: async (key: string) => disk.delete(key),
};
const pixels = () => new Response(new NodeBlob(['pixels'], {type: 'image/png'}), {
  headers: {'Content-Type':'image/png','x-ice-stored-at':String(Date.now()),'x-ice-byte-size':'6'},
});
beforeEach(async () => {
  vi.resetModules();
  disk.clear();
  ({ EmployeePosProductImage } = await import('../src/features/employee-delivery/EmployeePosProductImage'));
  ({ getR2ObjectUrl } = await import('../src/lib/r2Storage'));
  ({ catalogImageCacheKey } = await import('../src/lib/catalogImageCache'));
  mocks.invoke.mockReset().mockResolvedValue({data:null, error:new Error('signing unavailable')});
  network.mockReset().mockImplementation(async () => pixels());
  vi.stubGlobal('fetch', network);
  vi.stubGlobal('caches', {open: async () => cache});
  vi.stubGlobal('IntersectionObserver', undefined);
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = () => 'blob:real-cache';
    static revokeObjectURL = () => {};
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const imageSrc = () => document.querySelector('img')?.getAttribute('src');
it.each(['memory', 'localStorage'])('reuses a valid URL from %s when the image-byte cache misses', async (layer) => {
  localStorage.setItem(urlCacheKey, JSON.stringify({signedUrl:source, expiresAt:Date.now()+3600000}));
  if (layer === 'memory') expect(await getR2ObjectUrl('ice-type-images', path)).toBe(source);
  expect(mocks.invoke).not.toHaveBeenCalled();
  render(<EmployeePosProductImage imagePath={path} />);
  await waitFor(() => expect(imageSrc()).toBe('blob:real-cache'));
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(network).toHaveBeenCalledTimes(1);
  expect(network).toHaveBeenCalledWith(source, expect.anything());
  expect(localStorage.getItem(urlCacheKey)).not.toBeNull();
});
it('reads real cached bytes without calling the signer', async () => {
  disk.set(catalogImageCacheKey(source)!, pixels());
  render(<EmployeePosProductImage imagePath={path} />);
  await waitFor(() => expect(imageSrc()).toBe('blob:real-cache'));
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
});
it('signs, fetches and persists on a real cache miss', async () => {
  mocks.invoke.mockResolvedValue({data:{signedUrls:[{path,signedUrl:source}]},error:null});
  render(<EmployeePosProductImage imagePath={path} />);
  await waitFor(() => expect(imageSrc()).toBe('blob:real-cache'));
  await waitFor(() => expect(disk.has(catalogImageCacheKey(source)!)).toBe(true));
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(network).toHaveBeenCalledTimes(1);
});

it('refreshes once if a reused signed URL fails, then caches the replacement bytes', async () => {
  const replacement = source.replace('Signature=valid', 'Signature=replacement');
  localStorage.setItem(urlCacheKey, JSON.stringify({ signedUrl: source, expiresAt: Date.now() + 3600000 }));
  network.mockResolvedValueOnce(new Response(null, { status: 403 }));
  mocks.invoke.mockResolvedValue({ data: { signedUrls: [{ path, signedUrl: replacement }] }, error: null });
  render(<EmployeePosProductImage imagePath={path} />);
  await waitFor(() => expect(imageSrc()).toBe(source));
  expect(mocks.invoke).not.toHaveBeenCalled();
  fireEvent.error(document.querySelector('img')!);
  await waitFor(() => expect(imageSrc()).toBe('blob:real-cache'));
  await waitFor(() => expect(disk.has(catalogImageCacheKey(replacement)!)).toBe(true));
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(network).toHaveBeenCalledTimes(2);
  expect(network).toHaveBeenLastCalledWith(replacement, expect.anything());
});
