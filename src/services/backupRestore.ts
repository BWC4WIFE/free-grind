import { invoke } from "@tauri-apps/api/core";
import { appCacheDir, join } from "@tauri-apps/api/path";
import { BaseDirectory, mkdir, open, remove, writeFile as writeFsFile } from "@tauri-apps/plugin-fs";

/**
 * Mirrors `EXPORT_TABLES[].category` in `src-tauri/src/commands/backup.rs` —
 * keep the two lists in sync.
 */
export type BackupCategoryId =
	| "chat_messages"
	| "media_albums"
	| "saved_phrases"
	| "saved_locations"
	| "settings"
	| "sexual_health";

export const BACKUP_CATEGORY_IDS: BackupCategoryId[] = [
	"chat_messages",
	"media_albums",
	"saved_phrases",
	"saved_locations",
	"settings",
	"sexual_health",
];

export type BackupInspection =
	| {
			ok: true;
			categories: BackupCategoryId[];
			tables?: string[];
			sourceFormat?: "zip" | "sqlite";
			exportedAt: number;
			ownerUserId?: number;
			isDifferentOwner?: boolean;
	  }
	| { ok: false; error: "wrong_owner" | "invalid_format" };

export type ImportBackupResult = { ok: true; rowsImported: number } | { ok: false; error: "wrong_owner" | "invalid_format" };

export interface PolledTableInfo {
	name: string;
	category?: BackupCategoryId | string | null;
	primaryKey?: string | null;
	rowCount: number;
	columns: string[];
	knownExportTable: boolean;
	hasBlobs: boolean;
}

export interface DatabasePollResult {
	ok: boolean;
	sourceKind: "sqlite" | "zip";
	sourceName: string;
	ownerUserId?: number | null;
	tables: PolledTableInfo[];
	error?: string | null;
}

export interface LocalDatabaseEntry {
	fileName: string;
	path: string;
	sizeBytes: number;
	modifiedAt?: number | null;
	ownerUserId?: number | null;
	kind: "account" | "default" | "shared" | "master";
}

export interface TablePreviewResult {
	ok: boolean;
	table: string;
	columns: string[];
	totalRows: number;
	rows: Record<string, unknown>[];
	error?: string | null;
}

const BACKUP_TEMP_DIR = "backup-tmp";

export function normalizeOwnerId(ownerUserId: number | string): number {
	if (typeof ownerUserId === "number") {
		if (!Number.isSafeInteger(ownerUserId)) {
			throw new Error(`Invalid ownerUserId: ${String(ownerUserId)}`);
		}
		return ownerUserId;
	}
	const trimmed = String(ownerUserId).trim();
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isSafeInteger(parsed)) {
		throw new Error(`Invalid ownerUserId: ${trimmed}`);
	}
	return parsed;
}

async function tempBackupPath(prefix: string, ext = "zip"): Promise<string> {
	await mkdir(BACKUP_TEMP_DIR, { baseDir: BaseDirectory.AppCache, recursive: true });
	return join(await appCacheDir(), BACKUP_TEMP_DIR, `${prefix}-${crypto.randomUUID()}.${ext}`);
}

export function newExportTempPath(ext: "zip" | "sqlite3" = "zip"): Promise<string> {
	return tempBackupPath("export", ext);
}

/** Copies a picked `File` to a scratch path on disk, streamed so a large archive never sits fully in WebView memory. */
export async function copyPickedFileToTemp(file: File): Promise<string> {
	const lower = file.name.toLowerCase();
	const ext = lower.endsWith(".sqlite3")
		? "sqlite3"
		: lower.endsWith(".sqlite")
			? "sqlite"
			: lower.endsWith(".db")
				? "db"
				: "zip";
	const path = await tempBackupPath("import", ext);
	await writeFsFile(path, file.stream());
	return path;
}

export async function cleanupTempFile(path: string): Promise<void> {
	await remove(path).catch(() => {});
}

/** Reads a file back off disk in chunks, for handing to a streaming writer (Android SAF / desktop). */
export async function* readFileInChunks(path: string): AsyncGenerator<Uint8Array> {
	const file = await open(path, { read: true });
	try {
		const CHUNK_SIZE = 512 * 1024;
		while (true) {
			const buffer = new Uint8Array(CHUNK_SIZE);
			const bytesRead = await file.read(buffer);
			if (bytesRead === null) break;
			yield bytesRead === CHUNK_SIZE ? buffer : buffer.slice(0, bytesRead);
		}
	} finally {
		await file.close();
	}
}

export function exportBackupToFile(
	dbFileName: string,
	ownerUserId: number | string,
	destPath: string,
	categories: BackupCategoryId[],
	tables?: string[],
): Promise<void> {
	return invoke("export_backup_to_file", {
		dbFileName,
		ownerUserId: normalizeOwnerId(ownerUserId),
		destPath,
		categories,
		tables: tables && tables.length > 0 ? tables : null,
	});
}

export function exportSqliteDbToFile(
	dbFileName: string,
	ownerUserId: number | string,
	destPath: string,
	categories?: BackupCategoryId[],
	tables?: string[],
): Promise<string> {
	return invoke("export_sqlite_db_to_file", {
		dbFileName,
		ownerUserId: normalizeOwnerId(ownerUserId),
		destPath,
		categories: categories ?? null,
		tables: tables && tables.length > 0 ? tables : null,
	});
}

export function inspectBackupFile(srcPath: string, ownerUserId: number | string): Promise<BackupInspection> {
	return invoke("inspect_backup_file", { srcPath, ownerUserId: normalizeOwnerId(ownerUserId) });
}

export function importBackupFile(
	dbFileName: string,
	ownerUserId: number | string,
	srcPath: string,
	categories: BackupCategoryId[],
	tables?: string[],
	sourceLabel?: string,
): Promise<ImportBackupResult> {
	return invoke("import_backup_from_file", {
		dbFileName,
		ownerUserId: normalizeOwnerId(ownerUserId),
		srcPath,
		categories,
		tables: tables && tables.length > 0 ? tables : null,
		sourceLabel: sourceLabel ?? null,
	});
}

export function pollDatabaseTables(options: { dbFileName?: string; srcPath?: string }): Promise<DatabasePollResult> {
	return invoke("poll_database_tables", {
		dbFileName: options.dbFileName ?? null,
		srcPath: options.srcPath ?? null,
	});
}

export function listLocalDatabases(): Promise<LocalDatabaseEntry[]> {
	return invoke("list_local_databases");
}

export function previewTableRows(options: {
	dbFileName?: string;
	srcPath?: string;
	tableName: string;
	limit?: number;
	offset?: number;
}): Promise<TablePreviewResult> {
	return invoke("preview_table_rows", {
		dbFileName: options.dbFileName ?? null,
		srcPath: options.srcPath ?? null,
		tableName: options.tableName,
		limit: options.limit ?? 50,
		offset: options.offset ?? 0,
	});
}

export function syncMasterDatabase(): Promise<ImportBackupResult> {
	return invoke("sync_master_database");
}

export interface AccountLocationEntry {
	profileId: string;
	locationName?: string | null;
	shortLocationName?: string | null;
	geohash?: string | null;
}

export interface ProfileAccountConversation {
	accountId: string;
	conversationId: string;
	lastActivityTimestamp?: number | null;
	unreadCount: number;
	messageCount: number;
	lastMessagePreview?: string | null;
}

export interface ProfileCrossAccountProvenance {
	favoriteAccountIds: string[];
	conversations: ProfileAccountConversation[];
}

export interface MiniChatMessage {
	messageId: string;
	conversationId: string;
	senderId: number;
	timestamp: number;
	msgType?: string | null;
	text?: string | null;
	unsent: boolean;
}

export function listAccountLocations(): Promise<AccountLocationEntry[]> {
	return invoke("list_account_locations");
}

export function getCrossAccountProfileProvenance(
	profileIds: string[],
): Promise<Record<string, ProfileCrossAccountProvenance>> {
	if (profileIds.length === 0) {
		return Promise.resolve({});
	}
	return invoke("get_cross_account_profile_provenance", { profileIds });
}

export function readAccountConversationMessages(
	accountId: string,
	conversationId: string,
	limit = 40,
): Promise<MiniChatMessage[]> {
	return invoke("read_account_conversation_messages", {
		accountId,
		conversationId,
		limit,
	});
}
