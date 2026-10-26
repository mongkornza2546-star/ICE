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


Update 2026-10-26: prevent idle blank images (employee APK 1.0.10)
----------------------------------------------------------------
The display path previously awaited persistence before returning downloaded bytes
and releasing either of its two network slots. A pending cache write therefore
left completed images blank and stopped later downloads. Also, disconnecting the
intersection observer on first visibility meant mounted shops scrolled offscreen
kept their place in the queue. A path-only cache miss returned a placeholder
without invoking the shop's URL refresh.

Downloaded bytes now return immediately, with persistence separate from network
slot ownership. The shared result remains available until its write completes,
preventing duplicate downloads during persistence. Each storage operation has a
1.5-second deadline; a timeout disables further cache operations for this session
and drains queued writes without retaining an unbounded backlog. A late platform
operation may finish, but its result does not resume the timed-out write chain.

Unresolved lazy images stay observed. Leaving the 200px viewport margin releases
the consumer and cancels queued work only; reentry resumes, sharing any already
started download. After eight seconds waiting in the image pipeline, a visible
image falls back to its original URL, independently of native HTTP completion.
Late results cannot replace the fallback. Path-only shop cache misses request a
fresh URL once, including when Cache Storage is unsupported. Concurrent retry
signals share the shop's pending refresh.

Validation: four regression expectations failed against the original code.
The final 77-case focused suite passed, including seven cases in
`tests/catalog-image-idle-recovery.test.tsx`; seven runtime/layout checks,
TypeScript, employee build and APK packaging passed. Storage tests now await
persistence when asserting disk contents instead of assuming display completion
means the write finished. A Chromium fixture with an intentionally pending
Cache.put decoded and displayed the image (naturalWidth 160) while the write was
still pending. Native HTTP is simulated in tests; no device was connected.
The exact triggering condition on the reported phone remains unverified.

Existing tests covered rejected writes but not pending writes, unmounting but not
scrolling mounted tiles away, and path-only cache hits but not misses. The new
regressions cover those seams. Diagnostic records are in tmp/image-idle-review/.


Update 2026-10-26: restore cache recovery and path-only return (APK 1.0.11)
-------------------------------------------------------------------------
The 1.0.10 session-wide timeout policy above is superseded. Its permanent flag
made one slow write bypass every later disk hit, even after storage recovered.
Read and write lanes now pause independently while actual timed-out operations
remain pending, and automatically resume on settlement (success or rejection).
A slow write therefore does not prevent reading already cached photos. Late
writes invalidate the metadata/path indexes so subsequent lookups see the disk.

Persistence still does not block display or HTTP slots. A timed-out put releases
the serialized mutation queue, but its shared result remains available until the
actual put settles. The paused write lane prevents accumulating more pending
puts; the retained image is bounded by the existing 5 MiB per-image limit.

Path-only readers now join the existing pending download as consumers, including
completed bytes whose persistence is pending. Disk and pending keys are combined
before choosing a unique identity; conflicting origins or versions are refused.
Cancellation releases only that consumer and retains started HTTP work. After
8 seconds, a path-only component may show its placeholder but keeps listening
for the original bytes. An actual miss or failure still requests a fresh URL.
This avoids a failed signer hiding an otherwise successful late download.

Three regression cases failed before the fix, including a download completing
after 10 seconds. The final suite passed 89 cases, including 12 new return/recovery
checks in tests/catalog-image-return-recovery.test.tsx, plus 7 runtime/layout
checks. Existing cache consumers, ambiguity rules, and queue cancellation were
included. TypeScript, employee build and APK packaging passed. Real Chromium
Cache Storage showed one total download after leave/path-only return, then zero
new downloads on page reload; the decoded image had naturalWidth 160. Native
HTTP remains simulated and physical-device validation is outstanding. Evidence:
tmp/image-return-review/fix-red.log, fix-focused.log, layout-tests.log,
employee-build.log, apk-build.log, and apk-verification.json.

The smaller fix reuses the existing cache and pending queue. No new persistent
format or permanent memory cache was needed. Earlier tests missed recovery after
an operation's deadline and restored workspace data arriving before persistence.
Normal expiry, oversized files, denied storage, and OS eviction can still require
another download; navigation alone no longer discards reusable bytes in the
verified cases.
