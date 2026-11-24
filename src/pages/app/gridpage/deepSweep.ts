import { decodeGeohash, encodeGeohash } from "../../../utils/geohash";

export type DeepSweepCardLike = {
	profileId: string;
	primaryImageUrl?: string | null;
};

export type DeepSweepFilterOverrides = {
	shuffle?: boolean;
	hot?: boolean;
	fresh?: boolean;
};

const DEEP_SWEEP_STORAGE_KEY = "fg-deep-sweep-enabled";

export function loadDeepSweepEnabled(): boolean {
	try {
		return localStorage.getItem(DEEP_SWEEP_STORAGE_KEY) === "1";
	} catch {
		return false;
	}
}

export function saveDeepSweepEnabled(enabled: boolean): void {
	try {
		localStorage.setItem(DEEP_SWEEP_STORAGE_KEY, enabled ? "1" : "0");
	} catch {
		// ignore storage errors
	}
}

/**
 * Computes 4 cardinal micro-geohash cells (~500m N/S/E/W at mid-latitudes)
 * around the given geohash so Deep Sweep can query adjacent cascade buckets
 * via exploreGeoHash without changing the user's reported server location.
 */
export function buildNearbyMicroGeohashes(geohash: string, offsetDegrees = 0.0045): string[] {
	try {
		const decoded = decodeGeohash(geohash.trim().toLowerCase());
		const lat = (decoded.lat[0] + decoded.lat[1]) / 2;
		const lon = (decoded.lon[0] + decoded.lon[1]) / 2;
		const clampLat = (v: number) => Math.max(-89.9, Math.min(89.9, v));
		const clampLon = (v: number) => Math.max(-179.9, Math.min(179.9, v));
		return [
			encodeGeohash(clampLat(lat + offsetDegrees), clampLon(lon)),
			encodeGeohash(clampLat(lat - offsetDegrees), clampLon(lon)),
			encodeGeohash(clampLat(lat), clampLon(lon + offsetDegrees)),
			encodeGeohash(clampLat(lat), clampLon(lon - offsetDegrees)),
		];
	} catch {
		return [];
	}
}

/**
 * Runs a Deep Sweep across shuffle, hot, fresh modes and 4 nearby micro-geohash
 * cells, merging newly discovered unique profiles after baseCards.
 */
export async function runDeepSweep<T extends DeepSweepCardLike>(params: {
	activeGeohash: string;
	exploreGeohash?: string;
	baseCards: T[];
	fetchSlice: (opts: {
		exploreGeohash?: string;
		filterOverrides?: DeepSweepFilterOverrides;
	}) => Promise<{ cards: T[] }>;
}): Promise<{ cards: T[]; addedCount: number }> {
	const targetCenterGeohash = params.exploreGeohash || params.activeGeohash;
	const microCells = buildNearbyMicroGeohashes(targetCenterGeohash);

	const modeTasks: Promise<{ cards: T[] }>[] = [
		params
			.fetchSlice({
				exploreGeohash: params.exploreGeohash,
				filterOverrides: { shuffle: true, hot: undefined, fresh: undefined },
			})
			.catch(() => ({ cards: [] as T[] })),
		params
			.fetchSlice({
				exploreGeohash: params.exploreGeohash,
				filterOverrides: { hot: true, shuffle: undefined, fresh: undefined },
			})
			.catch(() => ({ cards: [] as T[] })),
		params
			.fetchSlice({
				exploreGeohash: params.exploreGeohash,
				filterOverrides: { fresh: true, shuffle: undefined, hot: undefined },
			})
			.catch(() => ({ cards: [] as T[] })),
	];

	const cellTasks: Promise<{ cards: T[] }>[] = microCells.map((cellHash) =>
		params
			.fetchSlice({
				exploreGeohash: cellHash,
			})
			.catch(() => ({ cards: [] as T[] })),
	);

	const results = await Promise.all([...modeTasks, ...cellTasks]);

	const seen = new Map<string, T>();
	const ordered: T[] = [];

	for (const card of params.baseCards) {
		if (!seen.has(card.profileId)) {
			seen.set(card.profileId, card);
			ordered.push(card);
		}
	}

	let addedCount = 0;
	for (const batch of results) {
		for (const card of batch.cards) {
			const existing = seen.get(card.profileId);
			if (!existing) {
				seen.set(card.profileId, card);
				ordered.push(card);
				addedCount += 1;
			} else if (!existing.primaryImageUrl && card.primaryImageUrl) {
				existing.primaryImageUrl = card.primaryImageUrl;
			}
		}
	}

	return { cards: ordered, addedCount };
}
