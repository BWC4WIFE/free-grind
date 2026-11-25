[2026-11-25 23:14] - Task: Fix Incognito toggle across account switches, Windows responsive scaling, and horizontal wheel/Shift+Wheel scrolling
- Created: `src/utils/horizontalWheelScroll.ts`
- Modified: `src/utils/privacy.ts`
- Modified: `src/contexts/AuthContext.tsx`
- Modified: `src/pages/app/SettingsPrivacyPage.tsx`
- Modified: `src/hooks/useDesktopBreakpoint.ts`
- Modified: `src/layouts/ProtectedLayout.tsx`
- Modified: `src/pages/app/ChatPage.tsx`
- Modified: `src/pages/app/chat/ChatInboxHeader.tsx`
- Modified: `src/pages/app/sexual-health/SexualHealthPage.tsx`
- Modified: `src/pages/app/gridpage/components/BrowseGrid.tsx`
- Modified: `src/pages/app/GridPage.tsx`
- Modified: `src/pages/app/chat/ChatThreadPanel.tsx`
- Modified: `src/pages/app/gridpage/components/FloatingMiniChat.tsx`
- Modified: `src/pages/app/gridpage/components/ProfileDetailsContent.tsx`
- Modified: `src/pages/app/IssueSearchPage.tsx`
- Modified: `src-tauri/tauri.conf.json`

[2026-11-25 17:24] - Task: Notify incognito and read-receipt listeners on loadPrivacyCache (account switch)
- Modified: `src/utils/privacy.ts`

[2026-11-25 11:36] - Task: Remove unused BrowseGrid incognito props causing TS6133
- Modified: `src/pages/app/gridpage/components/BrowseGrid.tsx`
- Modified: `src/pages/app/GridPage.tsx`

[2026-11-25 06:40] - Task: Implement server-backed Incognito Mode with non-blocking Grid browsing
- Modified: `src/utils/privacy.ts`
- Modified: `src/services/api/profileMethods.ts`
- Modified: `src/services/chatService.ts`
- Modified: `src/pages/app/SettingsPrivacyPage.tsx`
- Modified: `src/pages/app/GridPage.tsx`
- Modified: `src/pages/app/gridpage/components/BrowseGrid.tsx`
- Modified: `public/locales/en/translation.json`

[2026-11-25 02:14] - Task: Edit chatContactIndex, PreferencesContext, and App router for account scoping and auto location
- Modified: `src/services/chatContactIndex.ts`
- Modified: `src/contexts/PreferencesContext.tsx`
- Modified: `src/App.tsx`
- System: [Implementation Worker] - Applied requested edits.

[2026-11-25 02:15] - Task: Add global_search_master and favorite_notes table support
- Modified: `src-tauri/src/commands/backup.rs`
- Modified: `src-tauri/src/lib.rs`
- Modified: `src/services/backupRestore.ts`
[2026-11-25 02:16] - Task: Add global search shortcut / viewer chaser to ProtectedLayout and create chatThreadHelpers
- Created: `src/pages/app/chat/chatThreadHelpers.ts`
- Modified: `src/layouts/ProtectedLayout.tsx`
- System: [Implementation Worker] - Applied requested edits and validated with stripTypeScriptTypes and brace balance.

[2026-11-25 02:16] - Task: Implement Tiers 1-4 (Ranks 1-11) and bump version to v0.5.8
- Modified: `package.json`
- Modified: `src-tauri/Cargo.toml`
- Modified: `src-tauri/Cargo.lock`
- Modified: `src-tauri/tauri.conf.json`
- Modified: `src/pages/app/gridpage/components/ProfileDetailsContent.tsx`
- Modified: `src/pages/app/gridpage/components/mapStyles.ts`
- Modified: `src/pages/app/gridpage/components/MapLocationPreview.tsx`
- Modified: `src/pages/app/gridpage/components/MapLocationPicker.tsx`
- Modified: `src/pages/app/gridpage/geocoding.ts`
- Modified: `src/pages/app/LocationOverlay.tsx`
- Modified: `src/pages/app/BrowseLocationPage.tsx`
- Modified: `src/pages/app/profile-editor/TravelPlanEditorSheet.tsx`
- Created: `src/services/viewerChaser.ts`
- Modified: `src/hooks/queries/useInterestQueries.ts`
- Modified: `src/layouts/ProtectedLayout.tsx`
- Modified: `src/services/chatDb.ts`
- Modified: `src/services/api/profileMethods.ts`
- Modified: `src/pages/app/ChatPage.tsx`
- Modified: `src/pages/app/GridPage.tsx`
- Modified: `src/pages/app/gridpage/components/ProfileDetailsModal.tsx`
- Modified: `src-tauri/src/commands/backup.rs`
- Modified: `src-tauri/src/lib.rs`
- Modified: `src/services/backupRestore.ts`
- Created: `src/components/GlobalSearchModal.tsx`
- Modified: `src/services/chatContactIndex.ts`
- Modified: `src/contexts/PreferencesContext.tsx`
- Modified: `src/App.tsx`
- Created: `src/pages/app/chat/chatThreadHelpers.ts`

[2026-11-25 02:27] - Task: Fix 7 Windows TypeScript build errors and add Deep Sweep grid discovery
- Created: `src/pages/app/gridpage/deepSweep.ts`
- Modified: `src/services/viewerChaser.ts`
- Modified: `src/pages/app/BrowseLocationPage.tsx`
- Modified: `src/pages/app/LocationOverlay.tsx`
- Modified: `src/pages/app/profile-editor/TravelPlanEditorSheet.tsx`
- Modified: `src/pages/app/ChatPage.tsx`
- Modified: `src/services/chatDb.ts`
- Modified: `src/utils/crashOverlay.ts`
- Modified: `src/pages/app/GridPage.tsx`

[2026-11-25 02:35] - Task: Fix Rust E0382 borrow of moved value pid in global_search_master
- Modified: `src-tauri/src/commands/backup.rs`
