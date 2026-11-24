import type { TFunction } from "i18next";
import { VIEW_RECEIVED_EVENT } from "../components/ChatRealtimeBridge";
import {
	getAllCachedBrowseCardsById,
	getAllCachedBrowseCardsByImageHash,
} from "../pages/app/gridpage/cache";
import {
	enrichInterestItemsWithProfiles,
	fromStoredView,
	normalizeViews,
	toStoredView,
	type BrowseHashMatch,
} from "../pages/app/interest/interestUtils";
import { fetchAndStoreAvatar } from "./avatarStore";
import * as chatDb from "./chatDb";
import { interestViewsStore } from "./interestViewsStore";
import { extractMediaHashFromUrl } from "../utils/media";
import { appLog } from "../utils/logger";

type ViewerChaseApi = {
	getViews: () => Promise<unknown>;
	getProfilesByIds: (profileIds: (string | number)[]) => Promise<unknown>;
};

const IDLE_CHASE_INTERVAL_MS = 90_000;
const MIN_PASS_COOLDOWN_MS = 40_000;
const EVENT_DEBOUNCE_MS = 3_000;
const MAX_AVATARS_PER_PASS = 15;

let lastChaseAt = 0;
let activeChasePromise: Promise<number> | null = null;

/**
 * Runs a single background pass to harvest *Viewed Me* entries, resolve
 * `preview:<hash>` stubs against `known_profiles` / `profile_photo_history` /
 * live `browseCache`, hydrate full profile details via `POST /v3/profiles`,
 * and cache every viewer's avatar locally before they move away or swap photos.
 */
export async function runViewerChasePass(
	api: ViewerChaseApi,
	t: TFunction,
	options?: { force?: boolean; onUpdated?: () => void },
): Promise<number> {
	if (activeChasePromise) {
		return activeChasePromise;
	}
	const now = Date.now();
	if (!options?.force && now - lastChaseAt < MIN_PASS_COOLDOWN_MS) {
		return 0;
	}

	activeChasePromise = (async () => {
		try {
			lastChaseAt = Date.now();
			const [viewsResponse, cachedRows, dbDirectory] = await Promise.all([
				api.getViews(),
				interestViewsStore.getAll(),
				chatDb.getKnownProfileDirectory().catch(() => ({
					byProfileId: new Map<string, chatDb.KnownProfileDirectoryEntry>(),
					byImageHash: new Map<string, chatDb.KnownProfileDirectoryEntry>(),
				})),
			]);

			const cachedViews = cachedRows.map(fromStoredView);

			const browseMatches = new Map<string, BrowseHashMatch>();
			for (const [hash, entry] of dbDirectory.byImageHash) {
				browseMatches.set(hash, {
					profileId: entry.profileId,
					displayName: entry.displayName,
					imageHash: entry.primaryImageHash ?? hash,
					onlineUntil: null,
					rightNow: null,
				});
			}
			for (const [hash, card] of getAllCachedBrowseCardsByImageHash()) {
				const existing = browseMatches.get(hash);
				browseMatches.set(hash, {
					profileId: card.profileId,
					displayName: card.displayName ?? existing?.displayName ?? null,
					imageHash: hash,
					onlineUntil: card.onlineUntil ?? null,
					rightNow: card.rightNow ?? null,
				});
			}

			const knownProfileMatches = new Map<string, BrowseHashMatch>();
			for (const [profileId, entry] of dbDirectory.byProfileId) {
				knownProfileMatches.set(profileId, {
					profileId,
					displayName: entry.displayName,
					imageHash: entry.primaryImageHash,
					onlineUntil: null,
					rightNow: null,
				});
			}
			for (const [profileId, card] of getAllCachedBrowseCardsById()) {
				const existing = knownProfileMatches.get(profileId);
				const cardHash = card.primaryImageUrl
					? extractMediaHashFromUrl(card.primaryImageUrl)
					: null;
				knownProfileMatches.set(profileId, {
					profileId,
					displayName: card.displayName ?? existing?.displayName ?? null,
					imageHash: cardHash ?? existing?.imageHash ?? null,
					onlineUntil: card.onlineUntil ?? null,
					rightNow: card.rightNow ?? null,
				});
			}

			const normalizedViews = normalizeViews(
				viewsResponse,
				cachedViews,
				t,
				browseMatches,
				knownProfileMatches,
			);

			// Refresh both favorite viewers AND any non-preview viewer missing a photo or name
			const refreshIds = new Set<string>();
			for (const item of normalizedViews) {
				if (item.profileId.startsWith("preview:")) continue;
				if (item.isFavorite || !item.imageHash || !item.displayName) {
					refreshIds.add(item.profileId);
				}
			}

			const enriched = await enrichInterestItemsWithProfiles(
				normalizedViews,
				api.getProfilesByIds,
				{ refreshIds },
			);

			const knownUpserts: chatDb.KnownProfileUpsertInput[] = [];
			const hashesToSnag = new Set<string>();

			for (const item of enriched.items) {
				if (item.imageHash) {
					hashesToSnag.add(item.imageHash);
				}
				if (item.profileId.startsWith("preview:")) continue;
				const extras = enriched.extraHashesByProfileId.get(item.profileId) ?? [];
				for (const h of extras) {
					hashesToSnag.add(h);
				}
				const dbEntry = dbDirectory.byProfileId.get(item.profileId);
				knownUpserts.push({
					profileId: item.profileId,
					displayName: item.displayName,
					primaryImageHash: item.imageHash,
					extraImageHashes: extras,
					isFavorite:
						item.isFavorite ||
						enriched.favoriteByProfileId.get(item.profileId) ||
						dbEntry?.isFavorite ||
						undefined,
				});
			}

			if (knownUpserts.length > 0) {
				await chatDb.upsertKnownProfiles(knownUpserts).catch(() => undefined);
			}

			// Aggressively snag viewer avatars locally (capped per pass to stay polite)
			let snaggedCount = 0;
			for (const hash of hashesToSnag) {
				if (snaggedCount >= MAX_AVATARS_PER_PASS) break;
				snaggedCount += 1;
				void fetchAndStoreAvatar(hash).catch(() => undefined);
			}

			await interestViewsStore.upsertMany(
				enriched.items.map((item) => toStoredView(item)),
			);

			options?.onUpdated?.();
			return enriched.items.length;
		} catch (error) {
			appLog.warn("[viewer-chaser] background pass failed", error);
			return 0;
		} finally {
			activeChasePromise = null;
		}
	})();

	return activeChasePromise;
}

/**
 * Attaches a global `VIEW_RECEIVED_EVENT` listener + idle timer so incoming
 * profile views are chased immediately even when the user is on Grid or Chat.
 */
export function startViewerChaser(
	api: ViewerChaseApi,
	t: TFunction,
	isSessionActive: () => boolean,
	onUpdated?: () => void,
): () => void {
	let debounceTimer: number | null = null;

	const scheduleChase = (force: boolean, delayMs: number) => {
		if (debounceTimer !== null) {
			window.clearTimeout(debounceTimer);
		}
		debounceTimer = window.setTimeout(() => {
			debounceTimer = null;
			if (!isSessionActive()) return;
			if (typeof document !== "undefined" && document.visibilityState === "hidden") {
				return;
			}
			void runViewerChasePass(api, t, { force, onUpdated });
		}, delayMs);
	};

	const onViewReceived = () => {
		scheduleChase(true, EVENT_DEBOUNCE_MS);
	};

	window.addEventListener(VIEW_RECEIVED_EVENT, onViewReceived);

	// Initial gentle idle pass shortly after launch/login
	scheduleChase(false, 12_000);

	const intervalId = window.setInterval(() => {
		if (!isSessionActive()) return;
		if (typeof document !== "undefined" && document.visibilityState === "hidden") {
			return;
		}
		const ric = (window as Window & { requestIdleCallback?: (cb: () => void) => number })
			.requestIdleCallback;
		if (typeof ric === "function") {
			ric(() => {
				if (isSessionActive()) {
					void runViewerChasePass(api, t, { force: false, onUpdated });
				}
			});
		} else {
			void runViewerChasePass(api, t, { force: false, onUpdated });
		}
	}, IDLE_CHASE_INTERVAL_MS);

	return () => {
		window.removeEventListener(VIEW_RECEIVED_EVENT, onViewReceived);
		if (debounceTimer !== null) {
			window.clearTimeout(debounceTimer);
		}
		window.clearInterval(intervalId);
	};
}
