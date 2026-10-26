# Device catalog image cache

Employee shop cards, shop review photos, stock product images, POS product images,
and their employee preview dialogs use `CachedCatalogImage`. The default image
in `AutoRefreshShopImage` uses the same cache; custom render callbacks remain
responsible for their own image element.

`catalog-device-images-v1` stores image bytes in Cache Storage without requiring
a service worker (the employee APK does not register one). R2 signing credentials
are excluded from the key, while the origin, object path and explicit version
parameters remain. Uploads already create new timestamp/UUID paths, so replacing
a photo selects new bytes immediately after the catalog data refreshes.

- Maximum 50 MiB of image payloads and 300 entries; oldest writes are evicted first.
- Entries expire after 30 days. Individual files over 5 MiB are not retained.
- Only shop and ice-type catalog URLs qualify; payment evidence is excluded.
- Load near the viewport, with at most two concurrent downloads. Disk hits are
  read before joining the network queue and never wait for unrelated HTTP calls.
- Restored workspace data can look up existing bytes by namespace and full
  `image_path`, without a signed URL. A small key-only index avoids repeatedly
  parsing every cached URL. Ambiguous paths across origins/versions are refused.
- Concurrent requests for the same key share one load. Blob URLs are released
  when the image unmounts or changes; no permanent in-memory image collection.
- Unmounting releases that consumer. The last consumer leaving removes queued
  work only. Started browser/native downloads finish and store their bytes, keeping
  their concurrency slot until completion. Returning consumers share the ongoing
  download, or read its completed cache entry. Closing the app/browser entirely
  can still interrupt work; this does not provide OS background downloads.
- Android uses Capacitor's existing native HTTP API to download bytes without
  depending on R2 CORS configuration. Web uses CORS fetch. Unsupported storage,
  CORS failure and corrupt images retain the ordinary image/re-signing fallback.
- Storage quota failure does not prevent a successful download from displaying.
  Browser/OS storage eviction can still require a later download.

URL signing and business-data networking still happen independently. This is
an image cache, not a change to transaction/offline sync or upload quality.
The 50 MiB limit applies to this cache, not existing browser HTTP/PWA caches.

Validation on 2026-10-22 after review fixes: 104 focused Vitest cases passed; TypeScript and
`npm run build:employee` passed. A local browser fixture using real Cache Storage
and synthetic image responses displayed the image after reload with a new signed
query and kept its download counter at one. Native HTTP is covered by a mocked
bridge test; no physical Android frame-time measurement or APK installation was
performed. Deploy/rebuild the client to deliver this change; no DB migration is
required.

Review regression ledger (2026-10-22):

| Experiment | Before | After |
| --- | --- | --- |
| Two blocked downloads plus a disk hit | Disk hit waited for HTTP | Disk hit resolves while HTTP remains blocked |
| Unmount three tiles with only two downloads started | Third download started after unmount | Queued download is removed |
| Restore workspace data with `image_url: null` and saved image bytes | Placeholder despite existing bytes | Shop tile, review image, stock product and preview read cached bytes by path |
| Cancel one of two consumers of the same URL | Not supported | Remaining consumer completes with one download |
| Cancel native HTTP before response arrives | Not supported | Slot remains occupied until native response; abandoned bytes are not stored |

The original three reproductions failed before the fix (`tmp/catalog-image-fix-red.log`)
and passed after it (`tmp/catalog-image-fix-review.log`). Permanent coverage is in
`tests/catalog-image-cache-regressions.test.tsx` and the catalog cache tests.
Final validation logs: `tmp/catalog-image-fix-tests.log`, `tmp/catalog-image-fix-build.log`.
Earlier tests checked URL-keyed reads and ignored late UI responses, but did not
exercise restored path-only callers or whether abandoned network work still started.


Update 2026-10-26: preserve started downloads after navigation
-----------------------------------------------------------
The previous cancellation policy above was changed after reproducing three failures:
browser HTTP was aborted on navigation, completed native bytes were discarded,
and returning to an unmounted tile required another download. Started downloads
now remain shared and populate the cache even with no mounted consumers; queued
work still cancels when its last consumer leaves. The browser return, native
storage/concurrency, and component unmount/reopen regressions failed before this
change. The historical 2026-10-22 cancellation expectations are superseded.
