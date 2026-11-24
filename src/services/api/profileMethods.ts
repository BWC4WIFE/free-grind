import {
	browseCardSchema,
	browseProfileSchema,
	cascadeResponseSchema,
	profileDetailResponseSchema,
	type BrowseCard,
	type ProfileDetail,
} from "../../types/grid";
import type {
	ManagedGender,
	ManagedPronoun,
	ProfileImageUploadResult,
} from "../../types/api-functions";
import type { RestFetcher } from "../../types/chat-service";
import type { VisitingMode } from "../../types/visiting";
import { isVisitingMode } from "../../types/visiting";
import { travelPlansResponseSchema, type TravelPlan, type TravelPlanPayload } from "../../types/travel";
import { homeLocationSchema, type HomeLocation } from "../../types/home-location";
import { ApiFunctionError, assertSuccess, parseJsonSafe } from "../apiHelpers";
import {
	getIncognitoMode,
	getSavedServerPrefsBeforeIncognito,
	isRecordProfileViewsEnabled,
	setSavedServerPrefsBeforeIncognito,
} from "../../utils/privacy";
import { appLog } from "../../utils/logger";
import { coarsenGeohash } from "../../utils/geohash";
import { getThumbImageUrl, validateMediaHash } from "../../utils/media";
import { getActiveChatDbFileName, listMergedFavoriteProfileIds } from "../chatDb";

const GET_PROFILES_CHUNK_IDS = 30;
const INCOGNITO_PARK_GEOHASH = "s00000000000";
const SUPPORTED_CASCADE_ITEM_TYPES = new Set([
	"full_profile_v1",
	"partial_profile_v1",
	"smart_boost_profile_v1",
	"sponsored_profile_v1",
]);
const OPTIONAL_NON_NULL_CARD_KEYS = [
	"isPopular",
	"isVisiting",
	"roaming",
	"isBoosting",
	"unreadCount",
	"favorite",
	"chatted",
] as const;

function safeCoarsenGeohash(hash: string): string {
	try {
		return coarsenGeohash(hash);
	} catch {
		return hash;
	}
}

function extractCascadePayload(item: {
	type: string;
	data: unknown;
}): Record<string, unknown> | null {
	const raw =
		item.type === "sponsored_profile_v1" &&
		typeof item.data === "object" &&
		item.data !== null &&
		"alternativeProfile" in item.data
			? (item.data as { alternativeProfile?: unknown }).alternativeProfile
			: item.data;
	if (typeof raw !== "object" || raw === null) {
		return null;
	}
	return raw as Record<string, unknown>;
}

function sanitizeBrowseCardInput(raw: Record<string, unknown>): Record<string, unknown> {
	const sanitized: Record<string, unknown> = { ...raw };
	for (const key of OPTIONAL_NON_NULL_CARD_KEYS) {
		if (sanitized[key] === null) {
			delete sanitized[key];
		}
	}
	return sanitized;
}

function normalizePrimaryImageUrl(
	raw: Record<string, unknown>,
	existingUrl?: string | null,
): string | undefined {
	const direct = existingUrl?.trim();
	if (direct) {
		return validateMediaHash(direct) ? getThumbImageUrl(direct, "320x320") : direct;
	}
	const profileHash =
		typeof raw.profileImageMediaHash === "string"
			? raw.profileImageMediaHash.trim()
			: "";
	if (profileHash && validateMediaHash(profileHash)) {
		return getThumbImageUrl(profileHash, "320x320");
	}
	const medias = Array.isArray(raw.medias) ? raw.medias : null;
	if (medias && medias.length > 0) {
		const first = medias[0];
		if (typeof first === "object" && first !== null) {
			const mediaHash =
				typeof (first as { mediaHash?: unknown }).mediaHash === "string"
					? (first as { mediaHash: string }).mediaHash.trim()
					: "";
			if (mediaHash && validateMediaHash(mediaHash)) {
				return getThumbImageUrl(mediaHash, "320x320");
			}
		}
	}
	return undefined;
}

export function createProfileMethods(fetchRest: RestFetcher, t: (key: string, options?: { defaultValue?: string }) => string) {
	let lastStoredServerLocationKey: string | null = null;

	const syncServerLocation = async (geohash: string, force = false): Promise<void> => {
		const coarse = safeCoarsenGeohash(geohash);
		const locationKey = `${getActiveChatDbFileName()}:${coarse}`;
		if (!force && locationKey === lastStoredServerLocationKey) {
			return;
		}
		try {
			const response = await fetchRest("/v4/location", {
				method: "PUT",
				body: { geohash: coarse },
			});
			if (response.status >= 200 && response.status < 300) {
				lastStoredServerLocationKey = locationKey;
			} else {
				appLog.warn(`[browse] PUT /v4/location returned status ${response.status}`);
			}
		} catch (error) {
			appLog.warn("[browse] PUT /v4/location sync failed", error);
		}
	};

	return {
		async getServerPrivacyPrefs(): Promise<{
			locationSearchOptOut?: boolean;
			incognito?: boolean;
			showOnMap?: boolean;
		} | null> {
			try {
				const response = await fetchRest("/v3/me/prefs/settings");
				if (response.status < 200 || response.status >= 300) {
					return null;
				}
				const payload = await parseJsonSafe(response);
				if (typeof payload !== "object" || payload === null) {
					return null;
				}
				return payload as {
					locationSearchOptOut?: boolean;
					incognito?: boolean;
					showOnMap?: boolean;
				};
			} catch (error) {
				appLog.warn("[privacy] GET /v3/me/prefs/settings failed", error);
				return null;
			}
		},

		async updateServerPrivacyPrefs(settings: {
			incognito?: boolean;
			locationSearchOptOut?: boolean;
			showOnMap?: boolean;
		}): Promise<boolean> {
			try {
				const response = await fetchRest("/v3/me/prefs/settings", {
					method: "PUT",
					body: { settings },
				});
				return response.status >= 200 && response.status < 300;
			} catch (error) {
				appLog.warn("[privacy] PUT /v3/me/prefs/settings failed", error);
				return false;
			}
		},

		async syncIncognitoServerState(
			enabled: boolean,
			restoreGeohash?: string | null,
		): Promise<void> {
			if (enabled) {
				const currentPrefs = await this.getServerPrivacyPrefs();
				if (currentPrefs && !getSavedServerPrefsBeforeIncognito()) {
					await setSavedServerPrefsBeforeIncognito({
						locationSearchOptOut: currentPrefs.locationSearchOptOut,
						showOnMap: currentPrefs.showOnMap,
					});
				}
				// Best-effort native incognito flag (succeeds on Unlimited, 402 on Free).
				await this.updateServerPrivacyPrefs({ incognito: true });
				// Hide distance and map pin on all tiers (200 OK on Free).
				await this.updateServerPrivacyPrefs({
					locationSearchOptOut: true,
					showOnMap: false,
				});
				// Park server location at an unpopulated ocean geohash so the account
				// disappears from local /v4/cascade and /v7/search grids.
				await syncServerLocation(INCOGNITO_PARK_GEOHASH, true);
				return;
			}

			await this.updateServerPrivacyPrefs({ incognito: false });
			const saved = getSavedServerPrefsBeforeIncognito();
			if (saved) {
				await this.updateServerPrivacyPrefs({
					...(typeof saved.locationSearchOptOut === "boolean"
						? { locationSearchOptOut: saved.locationSearchOptOut }
						: {}),
					...(typeof saved.showOnMap === "boolean"
						? { showOnMap: saved.showOnMap }
						: {}),
				});
				await setSavedServerPrefsBeforeIncognito(null);
			}
			if (restoreGeohash) {
				await syncServerLocation(restoreGeohash, true);
			}
		},

		async getBlockedProfileIds(): Promise<string[]> {
			const response = await fetchRest("/v3.1/me/blocks");
			await assertSuccess(response, t("profile_details.block_failed"));
			const payload = await parseJsonSafe(response);

			if (typeof payload !== "object" || payload === null) {
				throw new ApiFunctionError(
					t("profile_details.block_failed"),
					response.status,
					payload,
				);
			}

			const blocking = (payload as { blocking?: unknown }).blocking;
			if (!Array.isArray(blocking)) {
				return [];
			}

			return blocking
				.map((entry) => {
					if (typeof entry !== "object" || entry === null) {
						return null;
					}
					const profileId = (entry as { profileId?: unknown }).profileId;
					if (typeof profileId === "string" || typeof profileId === "number") {
						return String(profileId);
					}
					return null;
				})
				.filter((profileId): profileId is string => profileId !== null);
		},

		async blockProfile(profileId: string): Promise<{ ok: true }> {
			const response = await fetchRest(
				`/v3/me/blocks/${encodeURIComponent(profileId)}`,
				{ method: "POST" },
			);
			await assertSuccess(response, t("profile_details.block_failed"));
			return { ok: true };
		},

		async unblockProfile(profileId: string): Promise<{ ok: true }> {
			const response = await fetchRest(
				`/v3/me/blocks/${encodeURIComponent(profileId)}`,
				{ method: "DELETE" },
			);
			await assertSuccess(response, t("profile_details.unblock_failed"));
			return { ok: true };
		},

		async unblockAllProfiles(): Promise<{ ok: true }> {
			const response = await fetchRest("/v3/me/blocks", { method: "DELETE" });
			await assertSuccess(response, t("settings_blocked.unblock_all_failed", { defaultValue: "Failed to unblock all profiles." }));
			return { ok: true };
		},

		async getManagedGenders(): Promise<ManagedGender[]> {
			const response = await fetchRest("/public/v2/genders");
			await assertSuccess(response, t("api.errors.load_genders"));
			const payload = await parseJsonSafe(response);
			if (!Array.isArray(payload)) {
				throw new ApiFunctionError(t("api.errors.invalid_genders_response"), response.status, payload);
			}
			return payload
				.map((entry) => {
					if (
						typeof entry === "object" &&
						entry !== null &&
						typeof (entry as { genderId?: unknown }).genderId === "number" &&
						typeof (entry as { gender?: unknown }).gender === "string"
					) {
						const displayGroup = (entry as { displayGroup?: unknown }).displayGroup;
						const sortFilter = (entry as { sortFilter?: unknown }).sortFilter;
						return {
							genderId: (entry as { genderId: number }).genderId,
							gender: (entry as { gender: string }).gender,
							displayGroup: typeof displayGroup === "number" ? displayGroup : 0,
							sortFilter: typeof sortFilter === "number" ? sortFilter : null,
						};
					}
					return null;
				})
				.filter((entry): entry is ManagedGender => entry !== null);
		},

		async getManagedPronouns(): Promise<ManagedPronoun[]> {
			const response = await fetchRest("/v1/pronouns");
			await assertSuccess(response, t("api.errors.load_pronouns"));
			const payload = await parseJsonSafe(response);
			if (!Array.isArray(payload)) {
				throw new ApiFunctionError(t("api.errors.invalid_pronouns_response"), response.status, payload);
			}
			return payload
				.map((entry) => {
					if (
						typeof entry === "object" &&
						entry !== null &&
						typeof (entry as { pronounId?: unknown }).pronounId === "number" &&
						typeof (entry as { pronoun?: unknown }).pronoun === "string"
					) {
						return {
							pronounId: (entry as { pronounId: number }).pronounId,
							pronoun: (entry as { pronoun: string }).pronoun,
						};
					}
					return null;
				})
				.filter((entry): entry is ManagedPronoun => entry !== null);
		},

		async getBrowseProfileMedia(profileId: number | string): Promise<{
			profileImageMediaHash: string | null;
			medias: Array<{ mediaHash?: string }>;
		}> {
			const response = await fetchRest(`/v7/profiles/${profileId}`);
			await assertSuccess(response, t("api.errors.load_profile_media"));
			const parsed = browseProfileSchema.parse(await parseJsonSafe(response));
			return {
				profileImageMediaHash: parsed.profiles[0]?.profileImageMediaHash ?? null,
				medias: parsed.profiles[0]?.medias ?? [],
			};
		},

		async getBrowseCards(params: {
			geohash: string;
			/** Browse a different area via cascade's exploreGeoHash instead of nearbyGeoHash — geohash (your real/reported location) stays untouched either way, see the exploreGeoHash/nearbyGeoHash mutual-exclusion note below. */
			exploreGeohash?: string;
			page?: number;
			filters?: {
				onlineOnly?: boolean;
				photoOnly?: boolean;
				faceOnly?: boolean;
				hasAlbum?: boolean;
				notRecentlyChatted?: boolean;
				fresh?: boolean;
				rightNow?: boolean;
				favorites?: boolean;
				shuffle?: boolean;
				hot?: boolean;
				ageMin?: number;
				ageMax?: number;
				heightCmMin?: number;
				heightCmMax?: number;
				weightGramsMin?: number;
				weightGramsMax?: number;
				tribes?: string;
				lookingFor?: string;
				relationshipStatuses?: string;
				bodyTypes?: string;
				sexualPositions?: string;
				meetAt?: string;
				nsfwPics?: string;
				tags?: string;
			};
		}): Promise<{ cards: BrowseCard[]; nextPage: number | null }> {
			const incognitoActive = getIncognitoMode();
			const coarseGeohash = safeCoarsenGeohash(params.geohash);
			const coarseExploreGeohash = params.exploreGeohash
				? safeCoarsenGeohash(params.exploreGeohash)
				: undefined;

			// While Incognito is active, never send the user's real geohash to
			// PUT /v4/location or nearbyGeoHash; keep server location parked at
			// INCOGNITO_PARK_GEOHASH and browse via exploreGeoHash instead.
			const effectiveLocationGeohash = incognitoActive
				? INCOGNITO_PARK_GEOHASH
				: coarseGeohash;
			const effectiveExploreGeohash = incognitoActive
				? (coarseExploreGeohash ?? coarseGeohash)
				: coarseExploreGeohash;

			await syncServerLocation(
				effectiveLocationGeohash,
				Boolean(!effectiveExploreGeohash && params.filters?.favorites && !params.page),
			);

			// Cascade rejects nearbyGeoHash + exploreGeoHash together with
			// CAS-4001 — exploring apparently relies on the server's own
			// last-known (real) location for "nearby" once exploreGeoHash is
			// present, so send only one or the other, never both.
			const queryParams = new URLSearchParams(
				effectiveExploreGeohash
					? { exploreGeoHash: effectiveExploreGeohash }
					: { nearbyGeoHash: coarseGeohash },
			);

			if (typeof params.page === "number") {
				queryParams.set("pageNumber", String(params.page));
			}

			if (params.filters?.onlineOnly) queryParams.set("onlineOnly", "true");
			if (params.filters?.photoOnly) queryParams.set("photoOnly", "true");
			if (params.filters?.faceOnly) queryParams.set("faceOnly", "true");
			if (params.filters?.hasAlbum) queryParams.set("hasAlbum", "true");
			if (params.filters?.notRecentlyChatted)
				queryParams.set("notRecentlyChatted", "true");
			if (params.filters?.fresh) queryParams.set("fresh", "true");
			if (params.filters?.rightNow) queryParams.set("rightNow", "true");
			if (params.filters?.favorites) queryParams.set("favorites", "true");
			if (params.filters?.shuffle) queryParams.set("shuffle", "true");
			if (params.filters?.hot) queryParams.set("hot", "true");
			if (typeof params.filters?.ageMin === "number") {
				queryParams.set("ageMin", String(params.filters.ageMin));
			}
			if (typeof params.filters?.ageMax === "number") {
				queryParams.set("ageMax", String(params.filters.ageMax));
			}
			if (typeof params.filters?.heightCmMin === "number") {
				queryParams.set("heightCmMin", String(params.filters.heightCmMin));
			}
			if (typeof params.filters?.heightCmMax === "number") {
				queryParams.set("heightCmMax", String(params.filters.heightCmMax));
			}
			if (typeof params.filters?.weightGramsMin === "number") {
				queryParams.set("weightGramsMin", String(params.filters.weightGramsMin));
			}
			if (typeof params.filters?.weightGramsMax === "number") {
				queryParams.set("weightGramsMax", String(params.filters.weightGramsMax));
			}
			if (params.filters?.tribes) queryParams.set("tribes", params.filters.tribes);
			if (params.filters?.lookingFor)
				queryParams.set("lookingFor", params.filters.lookingFor);
			if (params.filters?.relationshipStatuses)
				queryParams.set("relationshipStatuses", params.filters.relationshipStatuses);
			if (params.filters?.bodyTypes)
				queryParams.set("bodyTypes", params.filters.bodyTypes);
			if (params.filters?.sexualPositions)
				queryParams.set("sexualPositions", params.filters.sexualPositions);
			if (params.filters?.meetAt) queryParams.set("meetAt", params.filters.meetAt);
			if (params.filters?.nsfwPics)
				queryParams.set("nsfwPics", params.filters.nsfwPics);
			if (params.filters?.tags) queryParams.set("tags", params.filters.tags);

			const url = `/v4/cascade?${queryParams.toString()}`;
			const response = await fetchRest(url);
			await assertSuccess(response, t("api.errors.load_browse_profiles"));
			const parsed = cascadeResponseSchema.parse(await parseJsonSafe(response));
			if (!coarseExploreGeohash && !params.filters?.favorites) {
				lastStoredServerLocationKey = `${getActiveChatDbFileName()}:${coarseGeohash}`;
			}
			const entries: Array<{ card: BrowseCard; needsHydration: boolean }> = [];
			const hydrateIdSet = new Set<string>();
			for (const item of parsed.items) {
				if (!SUPPORTED_CASCADE_ITEM_TYPES.has(item.type)) {
					continue;
				}
				const raw = extractCascadePayload(item);
				if (!raw) {
					continue;
				}
				const candidate = browseCardSchema.safeParse(sanitizeBrowseCardInput(raw));
				if (!candidate.success) {
					continue;
				}
				const primaryImageUrl = normalizePrimaryImageUrl(raw, candidate.data.primaryImageUrl);
				const card: BrowseCard = {
					...candidate.data,
					...(primaryImageUrl ? { primaryImageUrl } : {}),
				};
				const needsHydration =
					item.type === "partial_profile_v1" ||
					(!card.primaryImageUrl && !card.displayName) ||
					typeof raw.favorite !== "boolean" ||
					typeof raw.chatted !== "boolean";
				if (needsHydration) {
					hydrateIdSet.add(card.profileId);
				}
				entries.push({ card, needsHydration });
			}

			// Batch-resolve partial or base-shaped cascade cards via POST /v3/profiles
			const hydratedByProfileId = new Map<string, Record<string, unknown>>();
			const numericIds = Array.from(hydrateIdSet)
				.map((id) => Number(id))
				.filter((id) => !Number.isNaN(id));
			if (numericIds.length > 0) {
				const batches: number[][] = [];
				for (let i = 0; i < numericIds.length; i += GET_PROFILES_CHUNK_IDS) {
					batches.push(numericIds.slice(i, i + GET_PROFILES_CHUNK_IDS));
				}
				try {
					const responses = await Promise.all(
						batches.map(async (targetProfileIds) => {
							const res = await fetchRest("/v3/profiles", {
								method: "POST",
								body: { targetProfileIds },
							});
							if (res.status < 200 || res.status >= 300) {
								appLog.warn(`[browse] POST /v3/profiles batch returned ${res.status}`);
								return [];
							}
							const data = await parseJsonSafe(res);
							if (
								typeof data === "object" &&
								data !== null &&
								Array.isArray((data as { profiles?: unknown }).profiles)
							) {
								return (data as { profiles: unknown[] }).profiles;
							}
							return [];
						}),
					);
					for (const profile of responses.flat()) {
						if (typeof profile === "object" && profile !== null) {
							const record = profile as Record<string, unknown>;
							if (typeof record.profileId === "string" || typeof record.profileId === "number") {
								hydratedByProfileId.set(String(record.profileId), record);
							}
						}
					}
				} catch (error) {
					appLog.warn("[browse] Failed to resolve lazy/partial cascade profiles", error);
				}
			}

			const nowMs = Date.now();
			const cards: BrowseCard[] = entries.map(({ card }) => {
				const resolved = hydratedByProfileId.get(card.profileId);
				if (!resolved) {
					return card;
				}
				const resolvedImage = normalizePrimaryImageUrl(resolved, null);
				const lastChatTs =
					typeof resolved.lastChatTimestamp === "number" ? resolved.lastChatTimestamp : null;
				const resolvedChatted =
					lastChatTs !== null ? nowMs - lastChatTs < 24 * 60 * 60 * 1000 : undefined;
				return {
					...card,
					displayName:
						card.displayName ??
						(typeof resolved.displayName === "string" ? resolved.displayName : null),
					age: card.age ?? (typeof resolved.age === "number" ? resolved.age : null),
					distanceMeters:
						card.distanceMeters ??
						(typeof resolved.distance === "number" ? resolved.distance : null),
					primaryImageUrl: card.primaryImageUrl ?? resolvedImage ?? null,
					onlineUntil:
						card.onlineUntil ??
						(typeof resolved.onlineUntil === "number" ? resolved.onlineUntil : null),
					lastOnline:
						card.lastOnline ?? (typeof resolved.seen === "number" ? resolved.seen : null),
					favorite:
						card.favorite ??
						(typeof resolved.isFavorite === "boolean" ? resolved.isFavorite : undefined),
					chatted: card.chatted ?? resolvedChatted,
					rightNow:
						card.rightNow ??
						(typeof resolved.rightNow === "string" ? resolved.rightNow : null),
				};
			});

			// When Favorites filter is active on page 1, also pull merged favorites
			// from master.sqlite3/local DBs and batch-hydrate live onlineUntil &
			// distance via POST /v3/profiles so Online + Favorites works across accounts.
			if ((!coarseExploreGeohash || incognitoActive) && params.filters?.favorites && !params.page) {
				try {
					const mergedFavIds = await listMergedFavoriteProfileIds();
					const existingIds = new Set(cards.map((c) => c.profileId));
					const missingNumericIds = mergedFavIds
						.filter((id) => !existingIds.has(id))
						.map((id) => Number(id))
						.filter((n) => Number.isFinite(n) && n > 0)
						.slice(0, 120);

					if (missingNumericIds.length > 0) {
						const batches: number[][] = [];
						for (let i = 0; i < missingNumericIds.length; i += GET_PROFILES_CHUNK_IDS) {
							batches.push(missingNumericIds.slice(i, i + GET_PROFILES_CHUNK_IDS));
						}
						const extraResponses = await Promise.all(
							batches.map(async (targetProfileIds) => {
								const res = await fetchRest("/v3/profiles", {
									method: "POST",
									body: { targetProfileIds },
								});
								if (res.status < 200 || res.status >= 300) return [];
								const data = await parseJsonSafe(res);
								return typeof data === "object" &&
									data !== null &&
									Array.isArray((data as { profiles?: unknown }).profiles)
									? (data as { profiles: unknown[] }).profiles
									: [];
							}),
						);
						for (const rawProfile of extraResponses.flat()) {
							if (typeof rawProfile !== "object" || rawProfile === null) continue;
							const rec = rawProfile as Record<string, unknown>;
							const pid = rec.profileId != null ? String(rec.profileId) : "";
							if (!pid || existingIds.has(pid)) continue;
							const onlineUntil = typeof rec.onlineUntil === "number" ? rec.onlineUntil : null;
							if (params.filters?.onlineOnly && !(typeof onlineUntil === "number" && onlineUntil > nowMs)) {
								continue;
							}
							existingIds.add(pid);
							cards.push({
								profileId: pid,
								displayName: typeof rec.displayName === "string" ? rec.displayName : null,
								age: typeof rec.age === "number" ? rec.age : null,
								distanceMeters: typeof rec.distance === "number" ? rec.distance : null,
								primaryImageUrl: normalizePrimaryImageUrl(rec, null),
								onlineUntil,
								lastOnline: typeof rec.seen === "number" ? rec.seen : null,
								favorite: true,
								chatted:
									typeof rec.lastChatTimestamp === "number"
										? nowMs - rec.lastChatTimestamp < 24 * 60 * 60 * 1000
										: undefined,
								rightNow: typeof rec.rightNow === "string" ? rec.rightNow : null,
							});
						}
					}
				} catch (error) {
					appLog.warn("[browse] Failed to merge master favorites", error);
				}
			}

			return {
				cards,
				nextPage: parsed.nextPage ?? null,
			};
		},

		async getProfileDetail(profileId: string): Promise<ProfileDetail> {
			const response = await fetchRest(`/v7/profiles/${profileId}`);
			await assertSuccess(response, t("api.errors.load_profile_details"));
			const parsed = profileDetailResponseSchema.parse(
				await parseJsonSafe(response),
			);

			return parsed.profiles[0];
		},

		async getRawProfile(profileId: number | string): Promise<unknown> {
			const response = await fetchRest(`/v7/profiles/${profileId}`);
			await assertSuccess(response, t("api.errors.load_profile"));
			return parseJsonSafe(response);
		},

		/**
		 * GET /v4/me/profile — the read counterpart of updateMyProfile/
		 * updateMyProfileImages (both write to /v4 or /v3 "me/profile*"
		 * endpoints). Unlike GET /v7/profiles/:id (a different read path,
		 * used for viewing arbitrary profiles), this one reliably reflects
		 * edits made through those endpoints immediately — no read-after-
		 * write lag — so the profile editor reloads through this after
		 * saving photos/profile fields rather than getRawProfile.
		 */
		async getMyOwnProfile(): Promise<unknown> {
			const response = await fetchRest("/v4/me/profile");
			await assertSuccess(response, t("api.errors.load_profile"));
			return parseJsonSafe(response);
		},

		async recordProfileView(profileId: number | string): Promise<void> {
			if (!isRecordProfileViewsEnabled() || getIncognitoMode()) {
				return;
			}

			try {
				const response = await fetchRest(`/v4/views/${encodeURIComponent(String(profileId))}`, {
					method: "POST",
				});
				if (response.status < 200 || response.status >= 300) {
					appLog.warn(`Failed to record profile view: ${response.status}`);
				}
			} catch (error) {
				appLog.error("Profile view recording error:", error);
			}
		},

		/**
		 * Batch-fetch profile cards for many ids in one request via the cascade
		 * endpoint (POST /v3/profiles). Unlike GET /v7/profiles/{id}, this returns
		 * displayName + media for profiles you've blocked, where the single-profile
		 * endpoint comes back restricted/empty. Returns the raw `{ profiles: [...] }`
		 * payload.
		 */
		async getProfilesByIds(profileIds: (number | string)[]): Promise<unknown> {
			const targetProfileIds = profileIds
				.map((id) => Number(id))
				.filter((id) => !Number.isNaN(id));
			const response = await fetchRest("/v3/profiles", {
				method: "POST",
				body: { targetProfileIds },
			});
			await assertSuccess(response, t("api.errors.load_profile"));
			return parseJsonSafe(response);
		},

		async getVisitingMode(): Promise<VisitingMode> {
			const response = await fetchRest("/v1/visiting/settings");
			await assertSuccess(response, t("api.errors.load_visiting_mode"));
			const payload = await parseJsonSafe(response);
			const setting =
				typeof payload === "object" && payload !== null
					? (payload as { setting?: unknown }).setting
					: null;

			if (!isVisitingMode(setting)) {
				throw new ApiFunctionError(
					t("api.errors.invalid_visiting_mode_response"),
					response.status,
					payload,
				);
			}

			return setting;
		},

		async updateVisitingMode(setting: VisitingMode): Promise<{ ok: true }> {
			const response = await fetchRest("/v1/visiting/settings", {
				method: "PUT",
				body: { setting },
			});
			await assertSuccess(response, t("api.errors.save_visiting_mode"));
			return { ok: true };
		},

		async getHomeLocation(): Promise<HomeLocation> {
			const response = await fetchRest("/v1/visiting/home");
			await assertSuccess(response, t("api.errors.load_home_location"));
			return homeLocationSchema.parse(await parseJsonSafe(response));
		},

		async updateHomeLocation(location: { lat: number; lon: number }): Promise<{ ok: true }> {
			const response = await fetchRest("/v1/visiting/home", {
				method: "PUT",
				body: { lat: location.lat, lon: location.lon },
			});
			await assertSuccess(response, t("api.errors.save_home_location"));
			return { ok: true };
		},

		async getTravelPlans(profileId: number | string): Promise<TravelPlan[]> {
			const response = await fetchRest(`/v6/profiles/travel/${profileId}`);
			await assertSuccess(response, t("api.errors.load_travel_plans"));
			const payload = await parseJsonSafe(response);
			return travelPlansResponseSchema.parse(payload).travelPlans;
		},

		async createTravelPlan(payload: TravelPlanPayload): Promise<{ ok: true }> {
			const { travelPlanId: _ignored, ...body } = payload;
			const response = await fetchRest("/v6/profiles/travel", {
				method: "POST",
				body,
			});
			await assertSuccess(response, t("api.errors.save_travel_plan"));
			return { ok: true };
		},

		async updateTravelPlan(payload: TravelPlanPayload & { travelPlanId: number }): Promise<{ ok: true }> {
			const response = await fetchRest("/v6/profiles/travel/update", {
				method: "POST",
				body: payload,
			});
			await assertSuccess(response, t("api.errors.save_travel_plan"));
			return { ok: true };
		},

		async deleteTravelPlan(travelPlanId: number): Promise<{ ok: true }> {
			const response = await fetchRest(`/v6/profiles/travel/${travelPlanId}`, {
				method: "DELETE",
			});
			await assertSuccess(response, t("api.errors.delete_travel_plan"));
			return { ok: true };
		},

		async updateMyProfile(payload: unknown): Promise<{ ok: true }> {
			const response = await fetchRest("/v4/me/profile", {
				method: "PATCH",
				body: payload,
			});
			await assertSuccess(response, t("api.errors.save_profile"));
			return { ok: true };
		},

		// PATCH /v4/me/profile silently ignores explicit `null` values meant to
		// clear a field (e.g. resetting bodyType/ethnicity to "not set"). Doing a
		// full replace avoids that partial-merge behavior.
		async replaceMyProfile(payload: unknown): Promise<{ ok: true }> {
			const response = await fetchRest("/v3.1/me/profile", {
				method: "PUT",
				body: payload,
			});
			await assertSuccess(response, t("api.errors.save_profile"));
			return { ok: true };
		},

		async updateMyProfileImages(payload: {
			primaryImageHash: string | null;
			secondaryImageHashes: string[];
		}): Promise<{ ok: true }> {
			const response = await fetchRest("/v3/me/profile/images", {
				method: "PUT",
				body: payload,
			});
			await assertSuccess(response, t("api.errors.update_photos"));
			return { ok: true };
		},

		/**
		 * GET /v3.1/me/profile/images — the full pool of images uploaded to the
		 * account, independent of which ones are currently selected into the
		 * profile's photo slots (that selection lives in `medias`/
		 * `profileImageMediaHash` on the profile itself). Used by the profile
		 * picture drawer to let a user pick from previously-uploaded images
		 * without re-uploading them.
		 */
		async getProfileImages(): Promise<{ mediaHash: string; type: number; state: number | null }[]> {
			const response = await fetchRest("/v3.1/me/profile/images");
			await assertSuccess(response, t("api.errors.load_photos"));
			const payload = await parseJsonSafe(response);
			const medias =
				typeof payload === "object" && payload !== null
					? (payload as { medias?: unknown }).medias
					: null;
			if (!Array.isArray(medias)) {
				return [];
			}

			return medias
				.map((item) => {
					if (typeof item !== "object" || item === null) return null;
					const hashRaw = (item as { mediaHash?: unknown }).mediaHash;
					if (typeof hashRaw !== "string" || !hashRaw) return null;
					const typeRaw = (item as { type?: unknown }).type;
					const stateRaw = (item as { state?: unknown }).state;
					return {
						mediaHash: hashRaw,
						type: typeof typeRaw === "number" ? typeRaw : 0,
						state: typeof stateRaw === "number" ? stateRaw : null,
					};
				})
				.filter((item): item is { mediaHash: string; type: number; state: number | null } => item !== null);
		},

		async deleteMyProfileImages(mediaHashes: string[]): Promise<{ ok: true }> {
			const response = await fetchRest("/v3/me/profile/images", {
				method: "DELETE",
				body: { media_hashes: mediaHashes },
			});
			await assertSuccess(response, t("api.errors.delete_photos"));
			return { ok: true };
		},

		async uploadProfileImage(params: {
			path: string;
			body: Uint8Array;
			contentType: string;
		}): Promise<ProfileImageUploadResult> {
			const response = await fetchRest(params.path, {
				method: "POST",
				rawBody: params.body,
				contentType: params.contentType,
			});
			await assertSuccess(response, t("api.errors.upload_image"));
			const payload = await parseJsonSafe(response);
			if (typeof payload !== "object" || payload === null) {
				throw new ApiFunctionError(
					t("api.errors.invalid_upload_profile_response"),
					response.status,
					payload,
				);
			}
			return payload as ProfileImageUploadResult;
		},
	};
}
