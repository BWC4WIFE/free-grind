import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiFunctions } from "../useApiFunctions";
import { useEffect } from "react";
import { TAP_RECEIVED_EVENT, VIEW_RECEIVED_EVENT } from "../../components/ChatRealtimeBridge";
import { interestViewsStore } from "../../services/interestViewsStore";
import * as chatDb from "../../services/chatDb";
import { fetchAndStoreAvatar } from "../../services/avatarStore";
import { extractMediaHashFromUrl } from "../../utils/media";
import {
	fromStoredView,
	toStoredView,
	normalizeViews,
	normalizeTaps,
	normalizeSentTaps,
	enrichInterestItemsWithProfiles,
	type BrowseHashMatch,
	type InterestItem,
} from "../../pages/app/interest/interestUtils";
import { getAllCachedBrowseCardsByImageHash, getAllCachedBrowseCardsById } from "../../pages/app/gridpage/cache";
import { useTranslation } from "react-i18next";
import { DEFAULT_STALE_TIME_MS } from "../../config/ui-constants";

export function useInterestData() {
	const api = useApiFunctions();
	const queryClient = useQueryClient();
	const { t } = useTranslation();

	const query = useQuery({
		queryKey: ["interest", "list"],
		queryFn: async () => {
			// 1. Parallel fetch from API
			const [tapsResponse, viewsResponse, sentTapsResponse] = await Promise.all([
				api.getTaps(),
				api.getViews(),
				api.getSentTaps().catch(() => []),
			]);

			// 2. Load cached views from IndexedDB + known profiles/photo history from SQLite
			const [cachedRows, dbDirectory] = await Promise.all([
				interestViewsStore.getAll(),
				chatDb.getKnownProfileDirectory().catch(() => ({
					byProfileId: new Map<string, chatDb.KnownProfileDirectoryEntry>(),
					byImageHash: new Map<string, chatDb.KnownProfileDirectoryEntry>(),
				})),
			]);
			const cachedViews = cachedRows.map(fromStoredView);

			// 3. Scan both persistent DB & live browse-grid cache so any previously seen
			// profile (or past favorite photo hash) resolves locked "Someone" previews.
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
			const browseHashIndex = getAllCachedBrowseCardsByImageHash();
			for (const [hash, card] of browseHashIndex) {
				const existing = browseMatches.get(hash);
				browseMatches.set(hash, {
					profileId: card.profileId,
					displayName: card.displayName ?? existing?.displayName ?? null,
					imageHash: hash,
					onlineUntil: card.onlineUntil ?? null,
					rightNow: card.rightNow ?? null,
				});
			}

			const browseIdIndex = getAllCachedBrowseCardsById();
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
			for (const [profileId, card] of browseIdIndex) {
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
			const normalizedTaps = normalizeTaps(tapsResponse, t);
			const cacheResolvedSentTaps = normalizeSentTaps(sentTapsResponse, browseIdIndex);

			// Refresh favorite profiles & hydrate any views/sent-taps that have a real
			// profileId (including WebSocket-exposed views) via POST /v3/profiles.
			const favoriteRefreshIds = new Set<string>();
			for (const [profileId, entry] of dbDirectory.byProfileId) {
				if (entry.isFavorite) {
					favoriteRefreshIds.add(profileId);
				}
			}

			const [enrichedViewsResult, enrichedSentResult] = await Promise.all([
				enrichInterestItemsWithProfiles(normalizedViews, api.getProfilesByIds, {
					refreshIds: favoriteRefreshIds,
				}),
				enrichInterestItemsWithProfiles(cacheResolvedSentTaps, api.getProfilesByIds, {
					refreshIds: favoriteRefreshIds,
				}),
			]);

			const knownUpserts: chatDb.KnownProfileUpsertInput[] = [];
			const collectUpserts = (
				list: InterestItem[],
				extraMap?: Map<string, string[]>,
				favMap?: Map<string, boolean>,
			) => {
				for (const item of list) {
					if (item.profileId.startsWith("preview:")) continue;
					const dbEntry = dbDirectory.byProfileId.get(item.profileId);
					knownUpserts.push({
						profileId: item.profileId,
						displayName: item.displayName,
						primaryImageHash: item.imageHash,
						extraImageHashes: extraMap?.get(item.profileId),
						isFavorite:
							item.isFavorite ||
							favMap?.get(item.profileId) ||
							dbEntry?.isFavorite ||
							undefined,
					});
				}
			};
			collectUpserts(
				enrichedViewsResult.items,
				enrichedViewsResult.extraHashesByProfileId,
				enrichedViewsResult.favoriteByProfileId,
			);
			collectUpserts(normalizedTaps);
			collectUpserts(
				enrichedSentResult.items,
				enrichedSentResult.extraHashesByProfileId,
				enrichedSentResult.favoriteByProfileId,
			);

			let updatedDirectory = dbDirectory;
			if (knownUpserts.length > 0) {
				try {
					await chatDb.upsertKnownProfiles(knownUpserts);
					updatedDirectory = await chatDb.getKnownProfileDirectory();
				} catch {
					// Best-effort persistence; continue with existing directory metadata.
				}
			}

			// Cache every viewer/tap avatar locally (not only favorites) so
			// Viewed Me doesn't lose photos when a profile swaps or disappears.
			const viewerHashes = new Set<string>();
			for (const item of [...enrichedViewsResult.items, ...normalizedTaps, ...enrichedSentResult.items]) {
				if (item.imageHash) viewerHashes.add(item.imageHash);
			}
			for (const hash of Array.from(viewerHashes).slice(0, 25)) {
				void fetchAndStoreAvatar(hash);
			}

			const attachHistoryMeta = (item: InterestItem): InterestItem => {
				const dir = updatedDirectory.byProfileId.get(item.profileId);
				if (!dir) return item;
				return {
					...item,
					displayName: item.displayName || dir.displayName,
					imageHash: item.imageHash || dir.primaryImageHash,
					isFavorite: item.isFavorite || dir.isFavorite,
					photoChangeCount: dir.photoChangeCount,
				};
			};

			const finalViews = enrichedViewsResult.items.map(attachHistoryMeta);
			const finalTaps = normalizedTaps.map(attachHistoryMeta);
			const finalSentTaps = enrichedSentResult.items.map(attachHistoryMeta);

			// 4. Update persistence store with merged & resolved views
			await interestViewsStore.upsertMany(
				finalViews.map((item) => toStoredView(item)),
			);

			return {
				taps: finalTaps,
				views: finalViews,
				sentTaps: finalSentTaps,
				// Extract viewedCount from the raw response for the UI
				viewedCount: (viewsResponse as any)?.totalViewers || (viewsResponse as any)?.data?.totalViewers || 0,
			};
		},
		staleTime: DEFAULT_STALE_TIME_MS,
		refetchOnWindowFocus: true, // Auto-sync when app returns to foreground
	});

	// Handle WebSocket updates
	useEffect(() => {
		const handleUpdate = () => {
			// Invalidate query to trigger a background refetch
			queryClient.invalidateQueries({ queryKey: ["interest", "list"] });
		};

		window.addEventListener(TAP_RECEIVED_EVENT, handleUpdate);
		window.addEventListener(VIEW_RECEIVED_EVENT, handleUpdate);

		return () => {
			window.removeEventListener(TAP_RECEIVED_EVENT, handleUpdate);
			window.removeEventListener(VIEW_RECEIVED_EVENT, handleUpdate);
		};
	}, [queryClient]);

	return query;
}
