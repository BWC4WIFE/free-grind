import { useEffect, useState } from "react";
import { getSetting, setSetting } from "../services/chatDb";

// --- PER-CHAT READ RECEIPTS LOGIC ---
// Backed by the active profile's db, kept in an in-memory cache so the
// synchronous getters below (called from hot paths like chatService.ts and
// ChatRealtimeBridge.tsx) don't need to await a db round-trip — mirrors the
// pattern in utils/autoblock.ts.

export interface SavedServerPrivacyPrefs {
    locationSearchOptOut?: boolean;
    showOnMap?: boolean;
}

interface PrivacySettings {
    hideReadReceiptsGlobal: boolean;
    showReadReceiptToggle: boolean;
    recordProfileViews: boolean;
    readReceiptsExceptions: Record<string, boolean>;
    incognitoMode: boolean;
    savedServerPrefsBeforeIncognito?: SavedServerPrivacyPrefs | null;
}

const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
    hideReadReceiptsGlobal: false,
    showReadReceiptToggle: true,
    recordProfileViews: true,
    readReceiptsExceptions: {},
    incognitoMode: false,
    savedServerPrefsBeforeIncognito: null,
};

const PRIVACY_SETTINGS_KEY = "privacy";

let privacyCache: PrivacySettings = DEFAULT_PRIVACY_SETTINGS;

export async function loadPrivacyCache(): Promise<void> {
    try {
        const stored = await getSetting<Partial<PrivacySettings>>(PRIVACY_SETTINGS_KEY);
        privacyCache = { ...DEFAULT_PRIVACY_SETTINGS, ...stored };
    } catch {
        privacyCache = DEFAULT_PRIVACY_SETTINGS;
    }
}

// localStorage writes don't trigger re-renders in other components, so anything
// that displays read-receipts state (e.g. the chat list) needs to be told to
// recompute when a toggle happens elsewhere (e.g. the chat thread header).
const READ_RECEIPTS_CHANGED_EVENT = "fg-read-receipts-changed";

function notifyReadReceiptsChanged() {
    window.dispatchEvent(new Event(READ_RECEIPTS_CHANGED_EVENT));
}

// Forces the calling component to re-render whenever read-receipts state
// changes anywhere in the app, so cache-derived values stay in sync.
export function useReadReceiptsChanged(): void {
    const [, setVersion] = useState(0);

    useEffect(() => {
        const handler = () => setVersion((v) => v + 1);
        window.addEventListener(READ_RECEIPTS_CHANGED_EVENT, handler);
        return () => window.removeEventListener(READ_RECEIPTS_CHANGED_EVENT, handler);
    }, []);
}

export function isReadReceiptsHidden(conversationId: string): boolean {
    const exception = privacyCache.readReceiptsExceptions[conversationId];
    if (typeof exception === "boolean") {
        return exception;
    }
    return privacyCache.hideReadReceiptsGlobal;
}

/** Optimistic: updates the cache and returns the new state synchronously, persists in the background. */
export function toggleReadReceiptsHidden(conversationId: string): boolean {
    const nextState = !isReadReceiptsHidden(conversationId);
    privacyCache = {
        ...privacyCache,
        readReceiptsExceptions: { ...privacyCache.readReceiptsExceptions, [conversationId]: nextState },
    };
    void setSetting(PRIVACY_SETTINGS_KEY, privacyCache);
    notifyReadReceiptsChanged();
    return nextState;
}

export function getShowReadReceiptToggle(): boolean {
    return privacyCache.showReadReceiptToggle;
}

export function getHideReadReceiptsGlobal(): boolean {
    return privacyCache.hideReadReceiptsGlobal;
}

export async function setHideReadReceiptsGlobal(value: boolean): Promise<void> {
    privacyCache = { ...privacyCache, hideReadReceiptsGlobal: value };
    await setSetting(PRIVACY_SETTINGS_KEY, privacyCache);
    notifyReadReceiptsChanged();
}

export async function setShowReadReceiptToggle(value: boolean): Promise<void> {
    privacyCache = { ...privacyCache, showReadReceiptToggle: value };
    await setSetting(PRIVACY_SETTINGS_KEY, privacyCache);
}

// --- RECORD PROFILE VIEWS SETTING ---

export function isRecordProfileViewsEnabled(): boolean {
    return privacyCache.recordProfileViews;
}

export async function setRecordProfileViewsEnabled(value: boolean): Promise<void> {
    privacyCache = { ...privacyCache, recordProfileViews: value };
    await setSetting(PRIVACY_SETTINGS_KEY, privacyCache);
}

// --- INCOGNITO MODE ---
// While on, the client parks the account's server location at an unpopulated
// ocean geohash, hides distance/map visibility via /v3/me/prefs/settings, and
// routes Grid browsing through exploreGeoHash so the user can still browse
// profiles without appearing on the local grid or leaking views/receipts/typing.

const INCOGNITO_CHANGED_EVENT = "fg-incognito-changed";

function notifyIncognitoChanged() {
    if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(INCOGNITO_CHANGED_EVENT));
    }
}

export function useIncognitoMode(): boolean {
    const [enabled, setEnabled] = useState(() => privacyCache.incognitoMode);

    useEffect(() => {
        const handler = () => setEnabled(privacyCache.incognitoMode);
        window.addEventListener(INCOGNITO_CHANGED_EVENT, handler);
        return () => window.removeEventListener(INCOGNITO_CHANGED_EVENT, handler);
    }, []);

    return enabled;
}

export function getIncognitoMode(): boolean {
    return privacyCache.incognitoMode;
}

export function getSavedServerPrefsBeforeIncognito(): SavedServerPrivacyPrefs | null {
    return privacyCache.savedServerPrefsBeforeIncognito ?? null;
}

export async function setSavedServerPrefsBeforeIncognito(
    prefs: SavedServerPrivacyPrefs | null,
): Promise<void> {
    privacyCache = { ...privacyCache, savedServerPrefsBeforeIncognito: prefs };
    await setSetting(PRIVACY_SETTINGS_KEY, privacyCache);
}

export async function setIncognitoMode(value: boolean): Promise<void> {
    privacyCache = { ...privacyCache, incognitoMode: value };
    await setSetting(PRIVACY_SETTINGS_KEY, privacyCache);
    notifyIncognitoChanged();
}
