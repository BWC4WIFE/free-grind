import type { SavedAccountMeta } from "../contexts/auth-context";
import type { AccountLocationEntry } from "../services/backupRestore";
import { getSavedAccountProfile } from "../services/savedAccountProfiles";
import { getThumbImageUrl } from "./media";

export interface FormattedAccountLabel {
	profileId: string;
	displayName: string;
	shortLocation: string | null;
	fullLocation: string | null;
	/** e.g. "DisplayName · Dongtan" when location is present, else displayName */
	label: string;
	avatarUrl: string | null;
}

/**
 * Normalizes a full location label (e.g. "123 Main St, Bangkok, Thailand" or
 * saved location name like "Dongtan") into a compact short tag suitable for
 * tooltips, pills, and compact popovers.
 */
export function shortenLocationName(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;

	// If it already doesn't contain commas (e.g. "Bangkok", "Anna", "Dongtan"), keep it compact.
	if (!trimmed.includes(",")) {
		return trimmed.length > 22 ? `${trimmed.slice(0, 21).trimEnd()}…` : trimmed;
	}

	const parts = trimmed
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
	if (parts.length === 0) return null;

	// Addresses formatted as "Street 123, City, District" — pick the city/short part when >1 segment.
	const firstLooksLikeStreet = /\d/.test(parts[0]) || parts[0].length > 24;
	const candidate = firstLooksLikeStreet && parts.length >= 2 ? parts[1] : parts[0];
	return candidate.length > 22 ? `${candidate.slice(0, 21).trimEnd()}…` : candidate;
}

export function formatAccountLabel(
	profileId: string,
	savedAccounts: SavedAccountMeta[],
	locationsById: Record<string, AccountLocationEntry>,
): FormattedAccountLabel {
	const account = savedAccounts.find((a) => a.profileId === profileId);
	const savedProfile = getSavedAccountProfile(profileId);
	const loc = locationsById[profileId];

	const displayName =
		savedProfile.displayName?.trim() ||
		account?.email?.split("@")[0] ||
		profileId;
	const fullLocation = loc?.locationName?.trim() || null;
	const shortLocation =
		loc?.shortLocationName?.trim() ||
		shortenLocationName(loc?.locationName) ||
		null;
	const label = shortLocation ? `${displayName} · ${shortLocation}` : displayName;
	const avatarUrl = savedProfile.photoHash
		? getThumbImageUrl(savedProfile.photoHash, "75x75")
		: null;

	return {
		profileId,
		displayName,
		shortLocation,
		fullLocation,
		label,
		avatarUrl,
	};
}

export function buildAccountLabelMap(
	accountIds: Iterable<string>,
	savedAccounts: SavedAccountMeta[],
	locationsById: Record<string, AccountLocationEntry>,
): Record<string, FormattedAccountLabel> {
	const map: Record<string, FormattedAccountLabel> = {};
	for (const id of accountIds) {
		if (id && !map[id]) {
			map[id] = formatAccountLabel(id, savedAccounts, locationsById);
		}
	}
	return map;
}
