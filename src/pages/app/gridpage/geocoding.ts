/**
 * geocoding.ts — reverse-geocodes a geohash into a human-readable place
 * name (e.g. "Berlin, Germany") via Nominatim, the same free OSM-backed
 * service already used for forward search in LocationOverlay.tsx.
 *
 * Results are cached by `${geohash}:${lang}` in memory and localStorage, and
 * outgoing Nominatim requests are serialized through a >= 1.1s rate-limited queue
 * so concurrent mounts never trigger HTTP 429 bursts.
 */

import i18n from "../../../i18n";
import { decodeGeohash } from "../../../utils/geohash";
import { appLog } from "../../../utils/logger";

type CachedGeocodeResult = {
	label: string | null;
	city: string | null;
	cityDistrictLabel: string | null;
};

const PERSISTENT_CACHE_KEY = "fg-geocode-cache-v1";
const MAX_PERSISTENT_ENTRIES = 200;
const NOMINATIM_MIN_INTERVAL_MS = 1100;

const cache = new Map<string, Promise<CachedGeocodeResult>>();
let nominatimQueue: Promise<void> = Promise.resolve();
let lastNominatimCallAt = 0;

function getAcceptLanguage(): string {
	return (i18n.language || "en").trim() || "en";
}

function loadPersistentCache(): Record<string, CachedGeocodeResult> {
	if (typeof window === "undefined") return {};
	try {
		const raw = window.localStorage.getItem(PERSISTENT_CACHE_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? (parsed as Record<string, CachedGeocodeResult>) : {};
	} catch {
		return {};
	}
}

function savePersistentCacheEntry(key: string, value: CachedGeocodeResult): void {
	if (typeof window === "undefined") return;
	if (!value.label && !value.city && !value.cityDistrictLabel) return;
	try {
		const current = loadPersistentCache();
		current[key] = value;
		const keys = Object.keys(current);
		if (keys.length > MAX_PERSISTENT_ENTRIES) {
			for (const oldKey of keys.slice(0, keys.length - MAX_PERSISTENT_ENTRIES)) {
				delete current[oldKey];
			}
		}
		window.localStorage.setItem(PERSISTENT_CACHE_KEY, JSON.stringify(current));
	} catch {
		// Ignore storage quota errors
	}
}

function enqueueNominatim<T>(task: () => Promise<T>): Promise<T> {
	const run = nominatimQueue.then(async () => {
		const elapsed = Date.now() - lastNominatimCallAt;
		if (elapsed < NOMINATIM_MIN_INTERVAL_MS) {
			await new Promise((r) => setTimeout(r, NOMINATIM_MIN_INTERVAL_MS - elapsed));
		}
		lastNominatimCallAt = Date.now();
		return task();
	});
	nominatimQueue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

export type NominatimAddress = {
	road?: string;
	house_number?: string;
	neighbourhood?: string;
	suburb?: string;
	borough?: string;
	city_district?: string;
	city?: string;
	town?: string;
	village?: string;
	municipality?: string;
	state?: string;
	country?: string;
};

type NominatimReverseResponse = {
	address?: NominatimAddress;
	display_name?: string;
};

/** city/town/village/municipality, whichever Nominatim populated — shared by the label formatter and the "save as" default name. */
export function getCityFromAddress(address: NominatimAddress): string | null {
	return address.city ?? address.town ?? address.village ?? address.municipality ?? null;
}

export function formatNominatimAddress(address: NominatimAddress, fallback: string | null): string | null {
	const street = address.road
		? (address.house_number ? `${address.road} ${address.house_number}` : address.road)
		: null;
	const cityName = getCityFromAddress(address);
	const district = address.neighbourhood ?? address.suburb ?? address.borough ?? address.city_district ?? null;

	const parts = [street, cityName, district].filter(
		(part, index, all): part is string => !!part && all.indexOf(part) === index,
	);
	if (parts.length > 0) {
		return parts.join(", ");
	}
	return address.country ?? fallback;
}

export function formatCityDistrictAddress(address: NominatimAddress, fallback: string | null): string | null {
	const cityName = getCityFromAddress(address);
	const district = address.neighbourhood ?? address.suburb ?? address.borough ?? address.city_district ?? null;

	const parts = [cityName, district].filter(
		(part, index, all): part is string => !!part && all.indexOf(part) === index,
	);
	if (parts.length > 0) {
		return parts.join(", ");
	}
	return address.country ?? fallback;
}

async function fetchReverseGeocode(
	lat: number,
	lon: number,
	acceptLanguage: string,
): Promise<CachedGeocodeResult> {
	return enqueueNominatim(async () => {
		try {
			const response = await fetch(
				`https://nominatim.openstreetmap.org/reverse?format=json&zoom=18&lat=${lat}&lon=${lon}&accept-language=${encodeURIComponent(acceptLanguage)}`,
			);
			if (!response.ok) {
				return { label: null, city: null, cityDistrictLabel: null };
			}
			const data = (await response.json()) as NominatimReverseResponse;
			if (!data.address) {
				return {
					label: data.display_name ?? null,
					city: null,
					cityDistrictLabel: data.display_name ?? null,
				};
			}
			return {
				label: formatNominatimAddress(data.address, data.display_name ?? null),
				city: getCityFromAddress(data.address),
				cityDistrictLabel: formatCityDistrictAddress(data.address, data.display_name ?? null),
			};
		} catch (error) {
			appLog.warn("[geocoding] reverse lookup failed", error);
			return { label: null, city: null, cityDistrictLabel: null };
		}
	});
}

function resolveGeohash(geohash: string): Promise<CachedGeocodeResult> {
	const lang = getAcceptLanguage();
	const cacheKey = `${geohash}:${lang}`;
	const cached = cache.get(cacheKey);
	if (cached) {
		return cached;
	}

	const persistent = loadPersistentCache()[cacheKey];
	if (persistent) {
		const hit = Promise.resolve(persistent);
		cache.set(cacheKey, hit);
		return hit;
	}

	const run = (async () => {
		try {
			const decoded = decodeGeohash(geohash);
			const lat = (decoded.lat[0] + decoded.lat[1]) / 2;
			const lon = (decoded.lon[0] + decoded.lon[1]) / 2;
			const result = await fetchReverseGeocode(lat, lon, lang);
			savePersistentCacheEntry(cacheKey, result);
			return result;
		} catch (error) {
			appLog.warn(`[geocoding] failed to decode geohash ${geohash}`, error);
			return { label: null, city: null, cityDistrictLabel: null };
		}
	})();

	cache.set(cacheKey, run);
	return run;
}

export async function reverseGeocodeGeohash(geohash: string): Promise<string | null> {
	const { label } = await resolveGeohash(geohash);
	return label;
}

export async function reverseGeocodeCityForGeohash(geohash: string): Promise<string | null> {
	const { city } = await resolveGeohash(geohash);
	return city;
}

export async function reverseGeocodeCityDistrictForGeohash(geohash: string): Promise<string | null> {
	const { cityDistrictLabel } = await resolveGeohash(geohash);
	return cityDistrictLabel;
}
