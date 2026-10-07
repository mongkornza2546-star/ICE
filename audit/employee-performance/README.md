# Employee workspace responsiveness — 2026-10-06

## Scope and reproduction

Investigated taps, browsing a long shop list, and returning to the list after saving.
Tests use synthetic data and mock gateways; no production transactions were created.
The browser fixture uses the real `EmployeeShopPicker` with 500 synthetic shops.
Run `npm run dev:demo`, then open `/audit/employee-performance/index.html`.
The fixture is not an entry point of the production build.

## Findings and experiment ledger

| Experiment | Before | After / interpretation |
| --- | --- | --- |
| Ten quantity changes with an initialized workspace cache | 20 catalog localStorage reads, plus redundant return-context reads | 0 catalog reads; quantity remains 10. Initialization now uses lazy state. |
| Open one photo in the 500-shop fixture | React update 43.9 ms in the recorded baseline | 2.5 ms in the recorded verification. The shop-list JSX is reused during photo-preview state changes. Currency formatter is also reused across cards. |
| Confirm delivery while photo URL signing is deliberately unresolved | Stayed in delivery form after confirmed save and refreshed base data | Returns to shop list before photo URLs finish. The real write and required stock/data refresh still finish first. |
| A second data refresh while older photo signing is pending | Original gateway held the shared request through photo signing | Data requests finish independently; older photo completion cannot overwrite the newer cache entry. Regression test covers out-of-order completion. |
| Scroll 120 frames, 500 synthetic shops, desktop browser | No Android device baseline available | Desktop fixture: p95 frame interval 16.8 ms, zero frames over 25 ms. This does not reproduce or rule out Android scroll jank. |
| Existing cached-list behavior | Already preserves the list during tab revalidation | Retained; existing reactivation and recovery tests pass in focused runs. |
| Return to list in browser fixture | 500 shops | Still 500 shops after opening and returning. |

Single browser timings are development-build observations, not device-independent benchmarks.
Mount timings varied (75–192 ms observed); no reliable startup speedup is claimed.
The scroll fixture uses animation-frame-driven scrolling, not physical touchscreen input.
No speculative CSS effects or scrolling changes were made.

## Implementation boundaries

- Lazy initialization removes repeated synchronous storage reads from quantity updates.
- Photo preview updates reuse shop nodes; data changes still update amounts, eligibility and images.
- Progressive base data releases post-save navigation; optional image enrichment remains guarded by request identity.
- Post-save list refresh bypasses the short burst cache so confirmed sales are represented by fresh data.
- Gateway request sharing ends when base data is ready. Cache identity protects against late images from an older request.
- Transaction RPCs, idempotency, permissions, and stock validation were not changed.

Other files were edited concurrently in the shared workspace (including layout and financial screens).
Those edits were preserved; a full APK build includes the current workspace, not only this performance patch.

## Remaining device validation

Install the rebuilt APK on the device where the slowdown occurs. Check repeated quantity taps,
shop photo preview, save-to-list navigation on a slow connection, and long-list touch scrolling.
Android frame timing and an end-to-end comparison with Loyverse have not been measured.

## Final validation and artifact

- Final Vitest run: 68 files passed, 1 failed; 419 tests passed, 2 failed.
- Both failures are newly added concurrent cases in `tests/delivery-cancellation-dialog.test.tsx`:
  cancellation should be blocked for end-of-day and credit slips with allocated payments.
  These cases and their feature implementation are outside this performance patch; no changes were made to them here.
- Performance regressions, existing delivery/payment handoff, cache, and scroll-restoration cases passed.
- Seven focused Node checks passed (image caching, fixed image frames, payment scrolling, Android receipt-font packaging).
- TypeScript and production web build passed. Gradle debug APK build completed successfully,
  including its unit-test/check tasks; cached native tests were up to date.
- APK entries were compared byte-for-byte with the generated JavaScript bundles and index.html.
- No APK was installed on a physical device; Android instrumentation APK was built, not executed.

Artifact: `outputs/android/ice-delivery-performance-2026-10-06.apk` (about 7.2 MB).
SHA-256: `186fc6a3c805942a595da5f90ce71b481a31fc652043f8612bdb1e2635e44715`.

The first full test run overlapped a final edit to the post-save freshness assertion and
reported that one mixed-revision failure. Its focused rerun passed; the final full run above
contains only the two concurrent cancellation-feature failures.

## Review fixes — 2026-10-07

- Shared photo-signing requests by normalized R2 path set independently from shop data.
  Three concurrent readers (including a fresh post-save snapshot) now issue one signing request,
  and the refreshed reader still receives the new delivery status. Different photo sets remain independent.
- Added `refreshCapability: false` for post-save refresh only. Shop data remains forced fresh,
  while capability follows its existing 60-second TTL. Full catalog refresh keeps its previous behavior.
- Both new regression tests failed before the fix (3 signing calls instead of 1; 2 capability
  calls instead of 1). After the fix, 47 relevant tests across five files passed, including
  TTL expiry, explicit full refresh, delayed-photo navigation, payment handoff, and older-photo completion.
- TypeScript, production build, Capacitor sync, and Gradle APK build succeeded.
- Verified packaged index.html and JavaScript against dist byte-for-byte. Physical Android
  scrolling remains unmeasured. The full UI suite was not rerun for this follow-up.

New artifact: `outputs/android/ice-delivery-performance-2026-10-07.apk`.
SHA-256: `a7c6686f53c4eecec083432cbedf59f32decd82bd9254a197b86cacc54b3356f`.
