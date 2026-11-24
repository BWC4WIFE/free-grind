/**
 * Shared thread and message utility functions for ChatPage and FloatingMiniChat.
 */

/**
 * Checks whether a conversation partner / participant is currently online now.
 */
export function isConversationOnlineNow(
	onlineUntil: number | null | undefined,
	nowMs = Date.now(),
): boolean {
	return (
		typeof onlineUntil === "number" &&
		Number.isFinite(onlineUntil) &&
		onlineUntil > 0 &&
		onlineUntil > nowMs
	);
}

/**
 * Hydrates live onlineUntil and distance for a list of profile IDs by chunking into batches of 50,
 * safely calling getProfilesByIds, catching errors, and returning a Map of profileId -> { onlineUntil, distance }.
 */
export async function hydratePartnerOnlineStatus(
	profileIds: string[],
	getProfilesByIds: (ids: string[]) => Promise<unknown[]>,
): Promise<Map<string, { onlineUntil: number | null; distance: number | null }>> {
	const result = new Map<string, { onlineUntil: number | null; distance: number | null }>();
	if (!profileIds || profileIds.length === 0) {
		return result;
	}

	const uniqueIds = Array.from(new Set(profileIds)).filter(
		(id) => Boolean(id) && !id.startsWith("preview:"),
	);
	if (uniqueIds.length === 0) {
		return result;
	}

	const CHUNK_SIZE = 50;
	const chunks: string[][] = [];
	for (let i = 0; i < uniqueIds.length; i += CHUNK_SIZE) {
		chunks.push(uniqueIds.slice(i, i + CHUNK_SIZE));
	}

	await Promise.all(
		chunks.map(async (chunk) => {
			try {
				const raw = await getProfilesByIds(chunk);
				const profiles =
					raw && typeof raw === "object"
						? Array.isArray(raw)
							? raw
							: Array.isArray((raw as { profiles?: unknown }).profiles)
								? (raw as { profiles: unknown[] }).profiles
								: []
						: [];

				for (const p of profiles) {
					if (!p || typeof p !== "object") continue;
					const idRaw = (p as { profileId?: unknown }).profileId ?? (p as { id?: unknown }).id;
					if (idRaw == null) continue;
					const profileId = String(idRaw);

					const onlineUntilRaw = (p as { onlineUntil?: unknown }).onlineUntil;
					const onlineUntil =
						typeof onlineUntilRaw === "number" && Number.isFinite(onlineUntilRaw)
							? onlineUntilRaw
							: null;

					const distanceRaw =
						(p as { distance?: unknown }).distance ?? (p as { distanceKm?: unknown }).distanceKm;
					const distance =
						typeof distanceRaw === "number" && Number.isFinite(distanceRaw)
							? distanceRaw
							: null;

					result.set(profileId, { onlineUntil, distance });
				}
			} catch {
				// Safely catch errors per chunk
			}
		}),
	);

	return result;
}
