[2026-11-17 16:07] - Task: Implement Facebook OAuth token extraction and third-party login, update APK/IPA CI workflows
- Created: `AGENT_CHANGELOG.md`
- Modified: `src-tauri/src/api/rest.rs`
- Modified: `src-tauri/src/api/auth.rs`
- Modified: `src-tauri/src/lib.rs`
- Modified: `src-tauri/gen/android/app/src/main/AndroidManifest.xml`
- Modified: `src-tauri/gen/android/app/src/main/java/dev/estopia/free_grind/MainActivity.kt`
- Modified: `src-tauri/ios-keyboard-fix/ios/Sources/KeyboardFixPlugin.swift`
- Modified: `src-tauri/Info.plist`
- Modified: `src-tauri/gen/apple/project.yml`
- Modified: `src/types/api.ts`
- Modified: `src/contexts/auth-context.ts`
- Modified: `src/contexts/AuthContext.tsx`
- Modified: `src/pages/auth/SignInPage.tsx`
- Modified: `public/locales/en/translation.json`
- Modified: `.github/workflows/build-fork.yml`
- Modified: `.github/workflows/Build-iOS.yml`

[2026-11-17 16:21] - Task: Fix Build-iOS.yml Xcode project Rust bridge script patching
- Modified: `.github/workflows/Build-iOS.yml`

[2026-11-17 21:24] - Task: Normalize Grindr User-Agent version/build suffix, set HTTP/2 initial_stream_id(3), OkHttp pool/timeout settings, and en_US locale headers
- Modified: `src-tauri/src/api/headers.rs`

[2026-11-17 21:25] - Task: Align REST header ordering (Content-Type/Content-Length before Accept-Encoding) and add requirerealdeviceinfo/requireanondeviceinfo headers
- Modified: `src-tauri/src/api/rest.rs`

[2026-11-17 21:25] - Task: Replace custom FreeGrind WebView userAgent with standard Android Mobile Chrome UA
- Modified: `src-tauri/tauri.conf.json`

[2026-11-17 21:26] - Task: Add coarsenGeohash helper to match open-grind geohash precision
- Modified: `src/utils/geohash.ts`

[2026-11-17 21:27] - Task: Coarsen geohash, sync PUT /v4/location, support all cascade card variants, and batch-hydrate partial profiles via POST /v3/profiles
- Modified: `src/services/api/profileMethods.ts`

[2026-11-17 21:27] - Task: Add Free-Open push trigger to build-fork.yml and Build-iOS.yml workflows
- Modified: `.github/workflows/build-fork.yml`
- Modified: `.github/workflows/Build-iOS.yml`

[2026-11-18 00:13] - Task: Add portable login token/bundle export & import (`fg1:`, `fgbundle1:`, JSON, wrapped JWT) and register `export_login_tokens`
- Modified: `src-tauri/src/api/auth.rs`
- Modified: `src-tauri/src/lib.rs`

[2026-11-18 00:16] - Task: Enable cross-account and non-destructive backup combine, selective restore, and backup unit tests in `backup.rs`
- Modified: `src-tauri/src/commands/backup.rs`

[2026-11-18 00:17] - Task: Add `export_login_tokens` API schema and multi-file selective/cross-account backup combine UI with Select all/Clear toggles and phrase merge
- Modified: `src/types/api.ts`
- Modified: `src/services/backupRestore.ts`
- Modified: `src/pages/app/SettingsDataPage.tsx`

[2026-11-18 00:21] - Task: Add inline multi-source token guide + Paste button in `SignInPage`, Copy Login Token controls in `GridPage` switcher and `SettingsPage` Profile + selectable token modal
- Modified: `src/pages/auth/SignInPage.tsx`
- Modified: `src/pages/app/GridPage.tsx`
- Modified: `src/pages/app/SettingsPage.tsx`

[2026-11-18 00:24] - Task: Improve photo reel / album saving (`data:`/`blob:` fetch, Android `DCIM/FreeGrind` public dirs + stream write, iOS fallback album), 1-tap `PhotoViewer` Save button, and album tap-to-view + Save All in `SettingsAlbumsPage`
- Modified: `src/services/saveMedia.ts`
- Modified: `src/components/PhotoViewer.tsx`
- Modified: `src/pages/app/SettingsAlbumsPage.tsx`

[2026-11-18 00:24] - Task: Add `bun run type-check`, `bun run build`, and `cargo test --lib` to `build-fork.yml` workflow
- Modified: `.github/workflows/build-fork.yml`

[2026-11-18 00:43] - Task: Fix `createAndroidMediaUri` TS union types in `saveMedia.ts` and ignore pre-existing unused locals during CI `tsc` check
- Modified: `src/services/saveMedia.ts`
- Modified: `.github/workflows/build-fork.yml`

[2026-11-18 00:44] - Task: Add `known_profiles` and `profile_photo_history` tables/queries in `chatDb.ts` and backup/combine support + tests in `backup.rs`
- Modified: `src/services/chatDb.ts`
- Modified: `src-tauri/src/commands/backup.rs`

[2026-11-18 00:46] - Task: Wire persistent profile & photo history capture from grid cache and realtime WS events, and scan SQLite + `/v3/profiles` during Interest refresh
- Modified: `src/pages/app/gridpage/cache.ts`
- Modified: `src/components/ChatRealtimeBridge.tsx`
- Modified: `src/pages/app/interest/interestUtils.ts`
- Modified: `src/hooks/queries/useInterestQueries.ts`

[2026-11-18 00:47] - Task: Add Scan DB & Refresh button in `InterestPage`, favorite & photo-change badges in `InterestComponents`, Profile Photo History gallery + viewer in `ProfileDetailsContent`, and Profile Directory DB Export/Import in `SettingsDataPage`
- Modified: `src/pages/app/InterestPage.tsx`
- Modified: `src/pages/app/interest/InterestComponents.tsx`
- Modified: `src/pages/app/gridpage/components/ProfileDetailsContent.tsx`
- Modified: `src/pages/app/SettingsDataPage.tsx`

[2026-11-18 01:24] - Task: Resolve desktop/iOS export destinations directly in Rust with WAL busy timeout & tolerant base64 decoding, and grant `fs:allow-open` / `fs:allow-write` in desktop/iOS capabilities
- Modified: `src-tauri/src/commands/backup.rs`
- Modified: `src-tauri/capabilities/desktop.json`
- Modified: `src-tauri/capabilities/ios.json`

[2026-11-18 01:26] - Task: Route desktop/iOS backup exports directly through Rust (`exportBackupToFile`), unwrap Tauri error objects/strings in `getErrorMessage`, and log failures via `appLog.error`
- Modified: `src/pages/app/SettingsDataPage.tsx`

[2026-11-18 01:54] - Task: Coerce AuthContext numeric userId and add DB source provenance schema in chatDb
- Modified: `src/contexts/AuthContext.tsx`
- Modified: `src/services/chatDb.ts`

[2026-11-18 01:58] - Task: Add SQLite snapshot export (VACUUM INTO), cross-format inspect/combine, provenance tracking, DB polling, and table row preview in Rust backend
- Modified: `src-tauri/src/commands/backup.rs`
- Modified: `src-tauri/src/lib.rs`

[2026-11-18 02:02] - Task: Add numeric ownerId normalization, raw SQLite export, DB polling, local DB browser, and table preview viewer in UI
- Modified: `src/services/backupRestore.ts`
- Modified: `src/pages/app/SettingsDataPage.tsx`

[2026-11-22 06:35] - Task: Fix DB merge/import failures (data_pull_log schema mismatch, FK enforcement, table specs vs real chatDb.ts schemas)
- Modified: `src-tauri/src/commands/backup.rs`

[2026-11-22 06:44] - Task: Fix new regression test fixture (disable FK enforcement on source fixture connection)
- Modified: `src-tauri/src/commands/backup.rs`

[2026-11-22 19:02] - Task: Enforce per-account location lock across account switches and disable auto-location drift
- Modified: `src/contexts/PreferencesContext.tsx`
- Modified: `src/services/api/profileMethods.ts`
- Modified: `src/pages/app/GridPage.tsx`

[2026-11-22 19:06] - Task: Add shared live Master DB (master.sqlite3) dual-write/union-read, sync_master_database command, and locationPreferences merge protection
- Modified: `src/services/chatDb.ts`
- Modified: `src-tauri/src/commands/backup.rs`
- Modified: `src-tauri/src/lib.rs`
- Modified: `src/services/backupRestore.ts`
- Modified: `src/contexts/AuthContext.tsx`
- Modified: `src/pages/app/SettingsDataPage.tsx`

[2026-11-23 18:04] - Task: Prevent iOS/iPadOS unregisterListener unhandled rejection and strip redundant ?token= query param causing WS HTTP 414
- Modified: `src/services/tauriWebSocket.ts`
- Modified: `src-tauri/src/api/websocket.rs`

[2026-11-23 22:53] - Task: Convert GitHub Actions builds to dispatch-only and integrate Build-iOS.yml into build-fork.yml with per-platform toggles
- Modified: `.github/workflows/Build-iOS.yml`
- Modified: `.github/workflows/build-fork.yml`
- Modified: `.github/workflows/WinDoze.yml`

[2026-11-23 23:16] - Task: Add fixed dispatch-enabled JustIPA.yml workflow to Free-Open
- Created: `.github/workflows/JustIPA.yml`

[2026-11-23 23:43] - Task: Incorporate Dismiss button and app-wide Tauri unregisterListener error guards from upstream PR #238
- Modified: `src/utils/crashOverlay.ts`
- Modified: `vite.config.mjs`

[2026-11-24 03:54] - Task: Merge cross-account favorites, known_profiles, profile_photo_history, and profile_snapshots across Downloads\FreeGrind and AppData DBs with compatibility schema rebuild
- System: `[Database]` - Backed up `%APPDATA%\dev.estopia.free-grind\{chat-345583344,chat-777395649,chat-801862494,master}.sqlite3` to `.bak`, merged 11,356 known profiles (365 favorites), 11,138 photo-history entries, 62 profile snapshots, and conversation favorite flags across all 4 AppData DBs and all 6 `.sqlite3` files in `Downloads\FreeGrind`, and rebuilt `profile_snapshots`/`data_pull_log` with `DEFAULT`s + legacy compatibility columns.

[2026-11-25 01:28] - Task: Bump to v0.5.7 and add toggleable account location hints, Grid cross-account provenance, and floating mini-chat
- Modified: `package.json`
- Modified: `src-tauri/Cargo.toml`
- Modified: `src-tauri/Cargo.lock`
- Modified: `src-tauri/tauri.conf.json`
- Modified: `src-tauri/src/commands/backup.rs`
- Modified: `src-tauri/src/lib.rs`
- Modified: `src/services/backupRestore.ts`
- Modified: `src/services/chatDb.ts`
- Created: `src/utils/crossAccountUiPrefs.ts`
- Created: `src/utils/accountLabels.ts`
- Created: `src/components/CrossAccountUiSettingsModal.tsx`
- Created: `src/pages/app/gridpage/components/FloatingMiniChat.tsx`
- Modified: `src/pages/app/gridpage/components/BrowseCardTile.tsx`
- Modified: `src/pages/app/gridpage/components/BrowseGrid.tsx`
- Modified: `src/pages/app/gridpage/components/ProfileDetailsModal.tsx`
- Modified: `src/pages/app/GridPage.tsx`
- Modified: `src/pages/app/SettingsPage.tsx`
- System: `[Database]` - Seeded `account_profile_favorites` in `master.sqlite3` from `.bak` per-account backups (`345583344`: 219, `777395649`: 204, `801862494`: 49).
