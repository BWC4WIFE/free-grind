import { useCallback, useEffect, useState } from "react";

export interface CrossAccountUiPrefs {
	/** Show short location pills and hover tooltips in Grid & Settings account switchers. */
	showAccountLocationHints: boolean;
	/** Show per-account "Favorite of" and "Chats with" provenance on Grid hover & Profile Details. */
	showGridCrossAccountProvenance: boolean;
	/** Open the compact floating mini-chat preview/reply window instead of jumping straight to /chat. */
	enableFloatingMiniChat: boolean;
}

export const DEFAULT_CROSS_ACCOUNT_UI_PREFS: CrossAccountUiPrefs = {
	showAccountLocationHints: true,
	showGridCrossAccountProvenance: true,
	enableFloatingMiniChat: true,
};

const STORAGE_KEY = "fg-cross-account-ui-prefs";
const CHANGE_EVENT = "fg:cross-account-ui-prefs-changed";

export function readCrossAccountUiPrefs(): CrossAccountUiPrefs {
	if (typeof window === "undefined") {
		return { ...DEFAULT_CROSS_ACCOUNT_UI_PREFS };
	}
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) {
			return { ...DEFAULT_CROSS_ACCOUNT_UI_PREFS };
		}
		const parsed = JSON.parse(raw) as Partial<CrossAccountUiPrefs> | null;
		return {
			showAccountLocationHints:
				typeof parsed?.showAccountLocationHints === "boolean"
					? parsed.showAccountLocationHints
					: DEFAULT_CROSS_ACCOUNT_UI_PREFS.showAccountLocationHints,
			showGridCrossAccountProvenance:
				typeof parsed?.showGridCrossAccountProvenance === "boolean"
					? parsed.showGridCrossAccountProvenance
					: DEFAULT_CROSS_ACCOUNT_UI_PREFS.showGridCrossAccountProvenance,
			enableFloatingMiniChat:
				typeof parsed?.enableFloatingMiniChat === "boolean"
					? parsed.enableFloatingMiniChat
					: DEFAULT_CROSS_ACCOUNT_UI_PREFS.enableFloatingMiniChat,
		};
	} catch {
		return { ...DEFAULT_CROSS_ACCOUNT_UI_PREFS };
	}
}

export function writeCrossAccountUiPrefs(next: CrossAccountUiPrefs): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
		window.dispatchEvent(new CustomEvent<CrossAccountUiPrefs>(CHANGE_EVENT, { detail: next }));
	} catch {
		// Ignore localStorage quota/private mode errors.
	}
}

export function useCrossAccountUiPrefs() {
	const [prefs, setPrefsState] = useState<CrossAccountUiPrefs>(() => readCrossAccountUiPrefs());

	useEffect(() => {
		const sync = () => setPrefsState(readCrossAccountUiPrefs());
		window.addEventListener(CHANGE_EVENT, sync);
		window.addEventListener("storage", sync);
		return () => {
			window.removeEventListener(CHANGE_EVENT, sync);
			window.removeEventListener("storage", sync);
		};
	}, []);

	const setPref = useCallback(
		<K extends keyof CrossAccountUiPrefs>(key: K, value: CrossAccountUiPrefs[K]) => {
			const updated: CrossAccountUiPrefs = { ...readCrossAccountUiPrefs(), [key]: value };
			setPrefsState(updated);
			writeCrossAccountUiPrefs(updated);
		},
		[],
	);

	const resetPrefs = useCallback(() => {
		const defaults = { ...DEFAULT_CROSS_ACCOUNT_UI_PREFS };
		setPrefsState(defaults);
		writeCrossAccountUiPrefs(defaults);
	}, []);

	return { prefs, setPref, resetPrefs };
}
