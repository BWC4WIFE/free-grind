import { useCallback, useEffect, useRef, useState } from "react";
import {
	CalendarDays,
	Check,
	Database,
	Download,
	Eye,
	FileDown,
	FileUp,
	Loader2,
	MessageSquareQuote,
	RefreshCw,
	RotateCcw,
	ShieldCheck,
	Trash2,
	Upload,
	X,
} from "lucide-react";
import toast from "react-hot-toast";
import { useTranslation } from "react-i18next";
import { BackToSettings } from "../../components/BackToSettings";
import { BackupCategoryPicker } from "../../components/BackupCategoryPicker";
import { BottomSheet, SheetClose } from "../../components/ui/bottom-sheet";
import { ConfirmDialog } from "../../components/ui/confirm-dialog";
import { useAuth } from "../../contexts/useAuth";
import { useDesktopBreakpoint } from "../../hooks/useDesktopBreakpoint";
import { AndroidFs, AndroidPublicGeneralPurposeDir } from "tauri-plugin-android-fs-api";
import { BaseDirectory, mkdir, writeFile as writeFsFile } from "@tauri-apps/plugin-fs";
import * as chatDb from "../../services/chatDb";
import {
	BACKUP_CATEGORY_IDS,
	cleanupTempFile,
	copyPickedFileToTemp,
	exportBackupToFile,
	exportSqliteDbToFile,
	importBackupFile,
	inspectBackupFile,
	listLocalDatabases,
	newExportTempPath,
	pollDatabaseTables,
	previewTableRows,
	readFileInChunks,
	syncMasterDatabase,
	type BackupCategoryId,
	type DatabasePollResult,
	type LocalDatabaseEntry,
	type PolledTableInfo,
	type TablePreviewResult,
} from "../../services/backupRestore";
import { loadEncounters } from "../../services/encounters";
import { encountersToIcs } from "../../services/icsExport";
import { deleteAllDownloadedMedia, getDownloadedMediaUsage, isAndroid, isIos } from "../../services/saveMedia";
import { loadSavedPhrases, parsePhrasesFromTxt, phrasesToTxt, saveSavedPhrases } from "../../services/savedPhrases";
import { resetAllSettings } from "../../utils/resetSettings";
import { useSettingsHighlight } from "../../hooks/useSettingsHighlight";
import { appLog } from "../../utils/logger";

function formatBytes(bytes: number): string {
	if (bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB"];
	const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	const value = bytes / 1024 ** exponent;
	return `${exponent === 0 ? value : value.toFixed(1)} ${units[exponent]}`;
}

function getErrorMessage(error: unknown, fallback: string): string {
	if (error instanceof Error && error.message) {
		return error.message;
	}
	if (typeof error === "string" && error.trim()) {
		return error.trim();
	}
	if (error && typeof error === "object") {
		const record = error as {
			prettyMessage?: unknown;
			message?: unknown;
		};
		if (typeof record.prettyMessage === "string" && record.prettyMessage.trim()) {
			return record.prettyMessage.trim();
		}
		if (typeof record.message === "string" && record.message.trim()) {
			return record.message.trim();
		}
		if (record.message && typeof record.message === "object") {
			const nested = (record.message as { message?: unknown }).message;
			if (typeof nested === "string" && nested.trim()) {
				return nested.trim();
			}
		}
	}
	return fallback;
}

function PolledTableChecklist({
	tables,
	selected,
	onToggle,
	onSelectAll,
	onClear,
	onPreview,
	disabled,
}: {
	tables: PolledTableInfo[];
	selected: Set<string>;
	onToggle: (tableName: string) => void;
	onSelectAll: () => void;
	onClear: () => void;
	onPreview?: (tableName: string) => void;
	disabled?: boolean;
}) {
	if (tables.length === 0) return null;
	return (
		<div className="mx-4 mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/60 p-3">
			<div className="mb-2 flex items-center justify-between gap-2">
				<span className="text-xs font-semibold text-[var(--text)]">
					Polled DB tables ({selected.size}/{tables.length})
				</span>
				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={onSelectAll}
						disabled={disabled}
						className="text-xs font-medium text-[var(--accent)] hover:underline disabled:opacity-50"
					>
						All
					</button>
					<span className="text-xs text-[var(--text-muted)]">·</span>
					<button
						type="button"
						onClick={onClear}
						disabled={disabled}
						className="text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-50"
					>
						None
					</button>
				</div>
			</div>
			<div className="max-h-56 divide-y divide-[var(--border)] overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)]">
				{tables.map((tbl) => {
					const checked = selected.has(tbl.name);
					return (
						<div key={tbl.name} className="flex items-center gap-2 px-2.5 py-2">
							<button
								type="button"
								onClick={() => onToggle(tbl.name)}
								disabled={disabled}
								className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
							>
								<span
									className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
										checked
											? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)]"
											: "border-[var(--border)] bg-transparent"
									}`}
								>
									{checked ? <Check className="h-3 w-3" /> : null}
								</span>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-1.5">
										<span className="truncate font-mono text-xs font-semibold text-[var(--text)]">
											{tbl.name}
										</span>
										{!tbl.knownExportTable && (
											<span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
												extra
											</span>
										)}
									</div>
									<p className="truncate text-[11px] text-[var(--text-muted)]">
										{tbl.rowCount.toLocaleString()} rows · {tbl.columns.length} cols
										{tbl.category ? ` · ${tbl.category}` : ""}
									</p>
								</div>
							</button>
							{onPreview && (
								<button
									type="button"
									onClick={() => onPreview(tbl.name)}
									disabled={disabled}
									title={`Preview ${tbl.name}`}
									className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] text-[var(--text-muted)] transition hover:border-[var(--accent)] hover:text-[var(--text)] disabled:opacity-50"
								>
									<Eye className="h-3.5 w-3.5" />
								</button>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}

export function SettingsDataPage() {
	const { t } = useTranslation();
	const highlightId = useSettingsHighlight();
	const { userId } = useAuth();

	const [usage, setUsage] = useState<{ count: number; totalBytes: number } | null>(null);
	const [isLoadingUsage, setIsLoadingUsage] = useState(true);
	const [isDeleting, setIsDeleting] = useState(false);
	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
	const [isExporting, setIsExporting] = useState(false);
	const [isImporting, setIsImporting] = useState(false);
	const [isSyncingMaster, setIsSyncingMaster] = useState(false);
	const [isResetting, setIsResetting] = useState(false);
	const [showResetConfirm, setShowResetConfirm] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const isDesktop = useDesktopBreakpoint();

	const [exportCategories, setExportCategories] = useState<Set<BackupCategoryId>>(new Set(BACKUP_CATEGORY_IDS));
	const [exportFormat, setExportFormat] = useState<"zip" | "sqlite3">("zip");
	const [exportPollTables, setExportPollTables] = useState<PolledTableInfo[]>([]);
	const [selectedExportTables, setSelectedExportTables] = useState<Set<string> | null>(null);
	const [isPollingExportDb, setIsPollingExportDb] = useState(false);
	const [showExportCategoryPicker, setShowExportCategoryPicker] = useState(false);
	const [pendingImport, setPendingImport] = useState<{
		items: {
			tempPath: string;
			fileName: string;
			categories: BackupCategoryId[];
			tables: string[];
			ownerUserId?: number;
			isDifferentOwner?: boolean;
			isTemp: boolean;
		}[];
		categories: BackupCategoryId[];
		selected: Set<BackupCategoryId>;
		polledTables: PolledTableInfo[];
		selectedTables: Set<string>;
		useTableFilter: boolean;
		hasDifferentOwner: boolean;
	} | null>(null);

	const [showDbBrowser, setShowDbBrowser] = useState(false);
	const [localDbs, setLocalDbs] = useState<LocalDatabaseEntry[]>([]);
	const [isLoadingLocalDbs, setIsLoadingLocalDbs] = useState(false);
	const [browsedDbPath, setBrowsedDbPath] = useState<string | null>(null);
	const [browsedPoll, setBrowsedPoll] = useState<DatabasePollResult | null>(null);
	const [isPollingBrowser, setIsPollingBrowser] = useState(false);
	const [tablePreview, setTablePreview] = useState<{
		sourcePath?: string;
		dbFileName?: string;
		sourceLabel: string;
		tableName: string;
		offset: number;
		loading: boolean;
		data: TablePreviewResult | null;
	} | null>(null);

	const [savedPhrases, setSavedPhrases] = useState<string[]>([]);
	const [isExportingPhrases, setIsExportingPhrases] = useState(false);
	const [isImportingPhrases, setIsImportingPhrases] = useState(false);
	const phrasesInputRef = useRef<HTMLInputElement>(null);

	const [isExportingEncounters, setIsExportingEncounters] = useState(false);

	useEffect(() => {
		void loadSavedPhrases().then(setSavedPhrases);
	}, []);

	const loadUsage = useCallback(async () => {
		setIsLoadingUsage(true);
		try {
			setUsage(await getDownloadedMediaUsage());
		} catch (error) {
			appLog.error("[SettingsDataPage] failed to load downloaded-media usage", error);
		} finally {
			setIsLoadingUsage(false);
		}
	}, []);

	useEffect(() => {
		void loadUsage();
	}, [loadUsage]);

	const handleDeleteAll = async () => {
		setIsDeleting(true);
		try {
			const result = await deleteAllDownloadedMedia();
			if (result.failed > 0) {
				toast.error(
					t("data_backup.delete_partial", {
						defaultValue: "Deleted {{deleted}} files, {{failed}} failed.",
						deleted: result.deleted,
						failed: result.failed,
					}),
				);
			} else {
				toast.success(
					t("data_backup.delete_success", {
						defaultValue: "Deleted {{count}} downloaded files.",
						count: result.deleted,
					}),
				);
			}
			await loadUsage();
		} catch (error) {
			toast.error(getErrorMessage(error, t("data_backup.delete_failed", { defaultValue: "Failed to delete downloaded media." })));
		} finally {
			setIsDeleting(false);
			setShowDeleteConfirm(false);
		}
	};

	const pollActiveExportDb = useCallback(async (categoriesSnapshot?: Set<BackupCategoryId>) => {
		setIsPollingExportDb(true);
		try {
			const res = await pollDatabaseTables({ dbFileName: chatDb.getActiveChatDbFileName() });
			setExportPollTables(res.tables);
			const activeCats = categoriesSnapshot ?? exportCategories;
			const nextSelected = new Set(
				res.tables
					.filter((tbl) => (tbl.category ? activeCats.has(tbl.category as BackupCategoryId) : false))
					.map((tbl) => tbl.name),
			);
			setSelectedExportTables(nextSelected);
		} catch (error) {
			appLog.error("[SettingsDataPage] poll active DB failed", error);
			toast.error(getErrorMessage(error, "Failed to poll database tables."));
		} finally {
			setIsPollingExportDb(false);
		}
	}, [exportCategories]);

	useEffect(() => {
		if (showExportCategoryPicker && exportPollTables.length === 0) {
			void pollActiveExportDb();
		}
	}, [showExportCategoryPicker, exportPollTables.length, pollActiveExportDb]);

	const handleExport = async (
		overrideCategories?: BackupCategoryId[],
		filePrefix = "free-grind-data",
		overrideFormat?: "zip" | "sqlite3",
		explicitTables?: string[],
	): Promise<boolean> => {
		if (userId == null) {
			toast.error(t("data_backup.export_no_user", { defaultValue: "You must be signed in to export." }));
			return false;
		}
		const categoriesToExport = overrideCategories ?? Array.from(exportCategories);
		const tablesToExport =
			explicitTables ??
			(overrideCategories == null && selectedExportTables != null ? Array.from(selectedExportTables) : undefined);
		const useTableSelection = tablesToExport != null && selectedExportTables != null && overrideCategories == null;
		if (useTableSelection && tablesToExport.length === 0) {
			toast.error("Choose at least one table to export.");
			return false;
		}
		if (!useTableSelection && categoriesToExport.length === 0) {
			toast.error(t("data_backup.export_no_categories", { defaultValue: "Choose at least one category to export." }));
			return false;
		}
		const format = overrideFormat ?? exportFormat;
		setIsExporting(true);
		let tempPath: string | null = null;
		try {
			const fileName = `${filePrefix}-${new Date().toISOString().slice(0, 10)}.${format}`;
			const mimeType = format === "sqlite3" ? "application/x-sqlite3" : "application/zip";

			if (isAndroid()) {
				// On Android, write to an app-cache scratch file first, then stream
				// chunks into a pending MediaStore Download/FreeGrind entry.
				tempPath = await newExportTempPath(format);
				if (format === "sqlite3") {
					await exportSqliteDbToFile(
						chatDb.getActiveChatDbFileName(),
						userId,
						tempPath,
						categoriesToExport,
						useTableSelection ? tablesToExport : undefined,
					);
				} else {
					await exportBackupToFile(
						chatDb.getActiveChatDbFileName(),
						userId,
						tempPath,
						categoriesToExport,
						useTableSelection ? tablesToExport : undefined,
					);
				}
				const uri = await AndroidFs.createNewPublicFile(AndroidPublicGeneralPurposeDir.Download, `FreeGrind/${fileName}`, mimeType, {
					isPending: true,
				});
				try {
					const writable = await AndroidFs.openWriteFileStream(uri);
					const writer = writable.getWriter();
					try {
						for await (const chunk of readFileInChunks(tempPath)) {
							await writer.write(chunk);
						}
						await writer.close();
					} catch (error) {
						// A write failure already released the stream, so closing it
						// again would throw and mask the real error below.
						await writer.abort(error).catch(() => {});
						throw error;
					}
					await AndroidFs.setPublicFilePending(uri, false);
					await AndroidFs.scanPublicFile(uri);
				} catch (error) {
					await AndroidFs.removeFile(uri).catch(() => {});
					throw error;
				}
			} else {
				// Desktop (Windows/macOS/Linux) and iOS resolve relative paths
				// directly in Rust to Downloads/FreeGrind or Documents/FreeGrind,
				// avoiding temp copies and WebView IPC streaming.
				const relPath = `FreeGrind/${fileName}`;
				if (format === "sqlite3") {
					await exportSqliteDbToFile(
						chatDb.getActiveChatDbFileName(),
						userId,
						relPath,
						categoriesToExport,
						useTableSelection ? tablesToExport : undefined,
					);
				} else {
					await exportBackupToFile(
						chatDb.getActiveChatDbFileName(),
						userId,
						relPath,
						categoriesToExport,
						useTableSelection ? tablesToExport : undefined,
					);
				}
			}

			toast.success(
				isAndroid()
					? t("data_backup.export_success", { defaultValue: "Data exported." })
					: isIos()
						? t("data_backup.export_success_ios", { defaultValue: "Data exported. Find it in the Files app under On My iPhone/iPad → Free Grind." })
						: `Exported ${fileName} to Downloads/FreeGrind.`,
			);
			return true;
		} catch (error) {
			appLog.error("[SettingsDataPage] export failed", error);
			toast.error(getErrorMessage(error, t("data_backup.export_failed", { defaultValue: "Failed to export data." })));
			return false;
		} finally {
			setIsExporting(false);
			if (tempPath) {
				await cleanupTempFile(tempPath);
			}
		}
	};

	const showImportError = (error: "wrong_owner" | "invalid_format") => {
		toast.error(
			error === "wrong_owner"
				? t("data_backup.import_wrong_owner", { defaultValue: "This export belongs to a different profile and can't be imported here." })
				: t("data_backup.import_invalid", { defaultValue: "This file isn't a valid data export." }),
		);
	};

	const inspectPathsIntoPendingImport = async (
		sources: { path: string; fileName: string; isTemp: boolean }[],
	) => {
		if (userId == null) {
			toast.error(t("data_backup.import_no_user", { defaultValue: "You must be signed in to import." }));
			return;
		}
		setIsImporting(true);
		try {
			const items: {
				tempPath: string;
				fileName: string;
				categories: BackupCategoryId[];
				tables: string[];
				ownerUserId?: number;
				isDifferentOwner?: boolean;
				isTemp: boolean;
			}[] = [];
			const unionSet = new Set<BackupCategoryId>();
			const polledByName = new Map<string, PolledTableInfo>();
			let hasDifferentOwner = false;

			for (const source of sources) {
				const inspection = await inspectBackupFile(source.path, userId);
				if (!inspection.ok) {
					showImportError(inspection.error);
					await Promise.all(sources.filter((s) => s.isTemp).map((s) => cleanupTempFile(s.path)));
					return;
				}
				const polled = await pollDatabaseTables({ srcPath: source.path }).catch(() => null);
				const tableNames = polled ? polled.tables.map((tbl) => tbl.name) : inspection.tables ?? [];
				if (polled) {
					for (const tbl of polled.tables) {
						const existing = polledByName.get(tbl.name);
						if (!existing) {
							polledByName.set(tbl.name, { ...tbl });
						} else {
							polledByName.set(tbl.name, {
								...existing,
								rowCount: existing.rowCount + tbl.rowCount,
							});
						}
					}
				}
				for (const category of inspection.categories) {
					unionSet.add(category);
				}
				if (inspection.isDifferentOwner) {
					hasDifferentOwner = true;
				}
				items.push({
					tempPath: source.path,
					fileName: source.fileName,
					categories: inspection.categories,
					tables: tableNames,
					ownerUserId: inspection.ownerUserId,
					isDifferentOwner: inspection.isDifferentOwner,
					isTemp: source.isTemp,
				});
			}

			const availableCategories = BACKUP_CATEGORY_IDS.filter((id) => unionSet.has(id));
			const polledTables = Array.from(polledByName.values());
			const defaultSelectedTables = new Set(
				polledTables
					.filter((tbl) => tbl.rowCount > 0 && (tbl.knownExportTable || sources.some((s) => !s.isTemp)))
					.map((tbl) => tbl.name),
			);
			setPendingImport({
				items,
				categories: availableCategories,
				selected: new Set(availableCategories),
				polledTables,
				selectedTables: defaultSelectedTables,
				useTableFilter: polledTables.length > 0,
				hasDifferentOwner,
			});
		} catch (error) {
			appLog.error("[SettingsDataPage] import inspection failed", error);
			toast.error(getErrorMessage(error, t("data_backup.import_failed", { defaultValue: "Failed to import data." })));
			await Promise.all(sources.filter((s) => s.isTemp).map((s) => cleanupTempFile(s.path)));
		} finally {
			setIsImporting(false);
		}
	};

	const handleImportFiles = async (fileList: FileList | File[]) => {
		const files = Array.from(fileList);
		if (files.length === 0) return;
		if (userId == null) {
			toast.error(t("data_backup.import_no_user", { defaultValue: "You must be signed in to import." }));
			return;
		}
		setIsImporting(true);
		const copiedSources: { path: string; fileName: string; isTemp: boolean }[] = [];
		try {
			for (const file of files) {
				const tempPath = await copyPickedFileToTemp(file);
				copiedSources.push({ path: tempPath, fileName: file.name, isTemp: true });
			}
			await inspectPathsIntoPendingImport(copiedSources);
		} catch (error) {
			appLog.error("[SettingsDataPage] import copy failed", error);
			toast.error(getErrorMessage(error, t("data_backup.import_failed", { defaultValue: "Failed to import data." })));
			await Promise.all(copiedSources.map((s) => cleanupTempFile(s.path)));
			setIsImporting(false);
		}
	};

	const handleCancelImport = () => {
		if (pendingImport) {
			void Promise.all(pendingImport.items.filter((item) => item.isTemp).map((item) => cleanupTempFile(item.tempPath)));
		}
		setPendingImport(null);
	};

	const handleConfirmImport = async () => {
		if (!pendingImport || userId == null) {
			return;
		}
		setIsImporting(true);
		try {
			let totalRows = 0;
			for (const item of pendingImport.items) {
				const selectedForFile = item.categories.filter((c) => pendingImport.selected.has(c));
				const selectedTablesForFile = pendingImport.useTableFilter
					? item.tables.filter((tbl) => pendingImport.selectedTables.has(tbl))
					: undefined;
				if (pendingImport.useTableFilter) {
					if (!selectedTablesForFile || selectedTablesForFile.length === 0) continue;
				} else if (selectedForFile.length === 0) {
					continue;
				}
				const result = await importBackupFile(
					chatDb.getActiveChatDbFileName(),
					userId,
					item.tempPath,
					selectedForFile.length > 0 ? selectedForFile : item.categories,
					selectedTablesForFile,
					item.fileName,
				);
				if (!result.ok) {
					showImportError(result.error);
					return;
				}
				totalRows += result.rowsImported;
			}
			// A full import can touch conversations, messages, and every
			// setting (automation, privacy, browse filters, location, etc.),
			// each of which is otherwise cached in memory or React state and
			// only ever (re)loaded on app start / account switch — a reload
			// is the only way to guarantee everything reflects the import.
			toast.success(
				t("data_backup.import_success", {
					defaultValue: "Imported {{count}} rows. Reloading…",
					count: totalRows,
				}),
			);
			await Promise.all(pendingImport.items.filter((item) => item.isTemp).map((item) => cleanupTempFile(item.tempPath)));
			setPendingImport(null);
			window.location.reload();
		} catch (error) {
			appLog.error("[SettingsDataPage] import failed", error);
			toast.error(getErrorMessage(error, t("data_backup.import_failed", { defaultValue: "Failed to import data." })));
		} finally {
			setIsImporting(false);
		}
	};

	const openTablePreview = async (
		opts: { sourcePath?: string; dbFileName?: string; sourceLabel: string; tableName: string },
		offset = 0,
	) => {
		setTablePreview({
			sourcePath: opts.sourcePath,
			dbFileName: opts.dbFileName,
			sourceLabel: opts.sourceLabel,
			tableName: opts.tableName,
			offset,
			loading: true,
			data: null,
		});
		try {
			const data = await previewTableRows({
				srcPath: opts.sourcePath,
				dbFileName: opts.dbFileName,
				tableName: opts.tableName,
				limit: 50,
				offset,
			});
			setTablePreview((prev) => (prev ? { ...prev, loading: false, data } : prev));
		} catch (error) {
			appLog.error("[SettingsDataPage] table preview failed", error);
			toast.error(getErrorMessage(error, `Failed to preview ${opts.tableName}.`));
			setTablePreview((prev) => (prev ? { ...prev, loading: false } : prev));
		}
	};

	const handleSyncMasterDb = async () => {
		setIsSyncingMaster(true);
		try {
			const res = await syncMasterDatabase();
			if (res.ok) {
				toast.success(`Master database (master.sqlite3) synced (${res.rowsImported} rows).`);
				if (showDbBrowser) {
					setLocalDbs(await listLocalDatabases());
				}
			} else {
				toast.error("Failed to sync master database.");
			}
		} catch (error) {
			appLog.error("[SettingsDataPage] sync master db failed", error);
			toast.error(getErrorMessage(error, "Failed to sync master database."));
		} finally {
			setIsSyncingMaster(false);
		}
	};

	const pollBrowserDb = async (targetPath: string | null) => {
		setBrowsedDbPath(targetPath);
		setIsPollingBrowser(true);
		try {
			const res = await pollDatabaseTables(
				targetPath ? { srcPath: targetPath } : { dbFileName: chatDb.getActiveChatDbFileName() },
			);
			setBrowsedPoll(res);
		} catch (error) {
			appLog.error("[SettingsDataPage] poll DB failed", error);
			toast.error(getErrorMessage(error, "Failed to poll database."));
		} finally {
			setIsPollingBrowser(false);
		}
	};

	const openDbBrowser = async () => {
		setShowDbBrowser(true);
		setIsLoadingLocalDbs(true);
		try {
			const dbs = await listLocalDatabases();
			setLocalDbs(dbs);
		} catch (error) {
			appLog.error("[SettingsDataPage] listLocalDatabases failed", error);
			toast.error(getErrorMessage(error, "Failed to list local databases."));
		} finally {
			setIsLoadingLocalDbs(false);
		}
		await pollBrowserDb(null);
	};

	const toggleImportCategory = (id: BackupCategoryId) => {
		setPendingImport((prev) => {
			if (!prev) return prev;
			const next = new Set(prev.selected);
			const adding = !next.has(id);
			if (adding) {
				next.add(id);
			} else {
				next.delete(id);
			}
			const nextTables = new Set(prev.selectedTables);
			for (const tbl of prev.polledTables) {
				if (tbl.category === id) {
					if (adding) nextTables.add(tbl.name);
					else nextTables.delete(tbl.name);
				}
			}
			return { ...prev, selected: next, selectedTables: nextTables };
		});
	};

	const toggleExportCategory = (id: BackupCategoryId) => {
		setExportCategories((prev) => {
			const next = new Set(prev);
			const adding = !next.has(id);
			if (adding) {
				next.add(id);
			} else {
				next.delete(id);
			}
			setSelectedExportTables((prevTables) => {
				if (!prevTables) return prevTables;
				const nextTables = new Set(prevTables);
				for (const tbl of exportPollTables) {
					if (tbl.category === id) {
						if (adding) nextTables.add(tbl.name);
						else nextTables.delete(tbl.name);
					}
				}
				return nextTables;
			});
			return next;
		});
	};

	const toggleExportTable = (tableName: string) => {
		setSelectedExportTables((prev) => {
			const next = new Set(prev ?? exportPollTables.map((t) => t.name));
			if (next.has(tableName)) next.delete(tableName);
			else next.add(tableName);
			return next;
		});
	};

	const toggleImportTable = (tableName: string) => {
		setPendingImport((prev) => {
			if (!prev) return prev;
			const next = new Set(prev.selectedTables);
			if (next.has(tableName)) next.delete(tableName);
			else next.add(tableName);
			return { ...prev, selectedTables: next, useTableFilter: true };
		});
	};

	const handleExportPhrasesTxt = async () => {
		const content = phrasesToTxt(savedPhrases);
		if (!content) {
			toast.error(t("data_backup.phrases_export_empty", { defaultValue: "No saved phrases to export." }));
			return;
		}
		setIsExportingPhrases(true);
		try {
			const bytes = new TextEncoder().encode(`${content}\n`);
			const fileName = `free-grind-saved-phrases-${new Date().toISOString().slice(0, 10)}.txt`;

			if (isAndroid()) {
				// Blob-URL + <a download> doesn't trigger a save on Android's WebView
				// (same reasoning as the other exports on this page), so this writes
				// via the same open-stream + writer pattern used for the full data
				// and encounters exports.
				const uri = await AndroidFs.createNewPublicFile(AndroidPublicGeneralPurposeDir.Download, `FreeGrind/${fileName}`, "text/plain", {
					isPending: true,
				});
				try {
					const writable = await AndroidFs.openWriteFileStream(uri);
					const writer = writable.getWriter();
					try {
						await writer.write(bytes);
						await writer.close();
					} catch (error) {
						await writer.abort(error).catch(() => {});
						throw error;
					}
					await AndroidFs.setPublicFilePending(uri, false);
					await AndroidFs.scanPublicFile(uri);
				} catch (error) {
					await AndroidFs.removeFile(uri).catch(() => {});
					throw error;
				}
			} else {
				const baseDir = isIos() ? BaseDirectory.Document : BaseDirectory.Download;
				await mkdir("FreeGrind", { baseDir, recursive: true });
				await writeFsFile(`FreeGrind/${fileName}`, bytes, { baseDir });
			}

			toast.success(
				isAndroid()
					? t("data_backup.phrases_export_success", { defaultValue: "Saved phrases exported." })
					: isIos()
						? t("data_backup.phrases_export_success_ios", {
								defaultValue: "Saved phrases exported. Find it in the Files app under On My iPhone/iPad → Free Grind.",
							})
						: t("data_backup.phrases_export_success_desktop", { defaultValue: "Saved phrases exported to Downloads/FreeGrind." }),
			);
		} catch (error) {
			appLog.error("[SettingsDataPage] phrases export failed", error);
			toast.error(getErrorMessage(error, t("data_backup.phrases_export_failed", { defaultValue: "Failed to export saved phrases." })));
		} finally {
			setIsExportingPhrases(false);
		}
	};

	const handleImportPhrasesFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		event.target.value = "";
		if (!file) return;

		setIsImportingPhrases(true);
		try {
			const content = await file.text();
			const imported = parsePhrasesFromTxt(content);
			if (imported.length === 0) {
				toast.error(t("data_backup.phrases_import_empty", { defaultValue: "No valid phrases found in that file." }));
				return;
			}
			const existing = await loadSavedPhrases();
			const combined = Array.from(new Set([...existing, ...imported]));
			const updated = await saveSavedPhrases(combined);
			setSavedPhrases(updated);
			toast.success(t("data_backup.phrases_import_success", { defaultValue: "Saved phrases imported." }));
		} catch {
			toast.error(t("data_backup.phrases_import_error", { defaultValue: "Failed to import saved phrases." }));
		} finally {
			setIsImportingPhrases(false);
		}
	};

	const handleExportEncountersIcs = async () => {
		setIsExportingEncounters(true);
		try {
			const encounters = await loadEncounters();
			if (encounters.length === 0) {
				toast.error(t("data_backup.encounters_export_empty", { defaultValue: "No logged encounters to export." }));
				return;
			}
			const bytes = new TextEncoder().encode(encountersToIcs(encounters));
			const fileName = `free-grind-encounters-${new Date().toISOString().slice(0, 10)}.ics`;

			if (isAndroid()) {
				// Same reasoning as the full data export above: blob-URL + <a download>
				// doesn't trigger a save on Android's WebView. Writes via the same
				// open-stream + writer pattern as the full data export below — a
				// direct AndroidFs.writeFile(uri, bytes) call on a freshly-created
				// pending MediaStore entry was unreliable on-device even though it
				// type-checks and works on desktop.
				const uri = await AndroidFs.createNewPublicFile(AndroidPublicGeneralPurposeDir.Download, `FreeGrind/${fileName}`, "text/calendar", {
					isPending: true,
				});
				try {
					const writable = await AndroidFs.openWriteFileStream(uri);
					const writer = writable.getWriter();
					try {
						await writer.write(bytes);
						await writer.close();
					} catch (error) {
						await writer.abort(error).catch(() => {});
						throw error;
					}
					await AndroidFs.setPublicFilePending(uri, false);
					await AndroidFs.scanPublicFile(uri);
				} catch (error) {
					await AndroidFs.removeFile(uri).catch(() => {});
					throw error;
				}
			} else {
				const baseDir = isIos() ? BaseDirectory.Document : BaseDirectory.Download;
				await mkdir("FreeGrind", { baseDir, recursive: true });
				await writeFsFile(`FreeGrind/${fileName}`, bytes, { baseDir });
			}

			toast.success(
				isAndroid()
					? t("data_backup.encounters_export_success", { defaultValue: "Encounters exported." })
					: isIos()
						? t("data_backup.encounters_export_success_ios", {
								defaultValue: "Encounters exported. Find it in the Files app under On My iPhone/iPad → Free Grind.",
							})
						: t("data_backup.encounters_export_success_desktop", { defaultValue: "Encounters exported to Downloads/FreeGrind." }),
			);
		} catch (error) {
			appLog.error("[SettingsDataPage] encounters export failed", error);
			toast.error(getErrorMessage(error, t("data_backup.encounters_export_failed", { defaultValue: "Failed to export encounters." })));
		} finally {
			setIsExportingEncounters(false);
		}
	};

	const handleResetAllSettings = async () => {
		setIsResetting(true);
		try {
			await resetAllSettings();
			toast.success(t("data_backup.reset_success", { defaultValue: "All settings reset. Reloading…" }));
			window.location.reload();
		} catch (error) {
			toast.error(getErrorMessage(error, t("data_backup.reset_failed", { defaultValue: "Failed to reset settings." })));
			setIsResetting(false);
			setShowResetConfirm(false);
		}
	};

	return (
		<section className="app-screen">
			<header className="mb-7">
				<BackToSettings />
				<h1 className="app-title mb-1">{t("data_backup.title", { defaultValue: "Backup & Restore" })}</h1>
				<p className="app-subtitle">
					{t("data_backup.subtitle", { defaultValue: "Manage downloaded media and back up your account's entire data." })}
				</p>
			</header>

			<div className="grid gap-8">
				<div>
					<div className="surface-card overflow-hidden divide-y divide-[var(--border)]">
						<button
							id="data-export"
							type="button"
							onClick={() => setShowExportCategoryPicker(true)}
							disabled={isExporting}
							className={`flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors ${isExporting ? "opacity-50" : "hover:bg-[var(--surface-2)] active:bg-[var(--surface-2)]"} ${highlightId === "data-export" ? "animate-settings-highlight" : ""}`}
						>
							<div className="shrink-0 rounded-2xl bg-teal-500/15 p-2.5 text-teal-400">
								<FileDown className="h-5 w-5" />
							</div>
							<div className="min-w-0 flex-1">
								<p className="text-sm font-semibold leading-snug">
									{t("data_backup.export", { defaultValue: "Export all data" })}
								</p>
								<p className="mt-0.5 text-xs leading-snug text-[var(--text-muted)]">
									{t("data_backup.export_card_desc", {
										defaultValue: "Save your entire account to a file: conversations, messages, albums, avatars, cached photos/videos, saved phrases, saved locations, and every app setting.",
									})}
								</p>
							</div>
							{isExporting ? (
								<Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--text-muted)]" />
							) : (
								<Download className="h-4 w-4 shrink-0 text-[var(--text-muted)] opacity-50" />
							)}
						</button>

						<button
							id="data-import"
							type="button"
							onClick={() => fileInputRef.current?.click()}
							disabled={isImporting}
							className={`flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors ${isImporting ? "opacity-50" : "hover:bg-[var(--surface-2)] active:bg-[var(--surface-2)]"} ${highlightId === "data-import" ? "animate-settings-highlight" : ""}`}
						>
							<div className="shrink-0 rounded-2xl bg-violet-500/15 p-2.5 text-violet-400">
								<FileUp className="h-5 w-5" />
							</div>
							<div className="min-w-0 flex-1">
								<p className="text-sm font-semibold leading-snug">
									{t("data_backup.import", { defaultValue: "Import & combine data" })}
								</p>
								<p className="mt-0.5 text-xs leading-snug text-[var(--text-muted)]">
									{t("data_backup.import_card_desc", {
										defaultValue: "Select one or more backup files to merge selectively — existing data is preserved. The app reloads afterwards.",
									})}
								</p>
							</div>
							{isImporting ? (
								<Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--text-muted)]" />
							) : (
								<Upload className="h-4 w-4 shrink-0 text-[var(--text-muted)] opacity-50" />
							)}
						</button>
						<input
							ref={fileInputRef}
							type="file"
							multiple
							accept="application/zip,.zip,.sqlite,.sqlite3,.db"
							className="hidden"
							onChange={(event) => {
								const files = event.target.files ? Array.from(event.target.files) : [];
								event.target.value = "";
								if (files.length > 0) void handleImportFiles(files);
							}}
						/>

						<div className="flex items-start gap-2.5 px-4 py-3">
							<ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
							<p className="text-xs leading-relaxed text-[var(--text-muted)]">
								{t("data_backup.backup_note", {
									defaultValue: "Pick one or multiple backups to combine selectively, including exports from another account (chats, outgoing messages, and albums remap to your active profile).",
								})}
							</p>
						</div>
					</div>
				</div>

				<div className="grid gap-4">
					{/* Profile Directory & Photo History DB */}
					<div>
						<p className="mb-2 px-1 text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">
							{t("data_backup.profile_directory_db", { defaultValue: "Profile Directory & Photo History DB" })}
						</p>
						<div className="surface-card overflow-hidden divide-y divide-[var(--border)]">
							<button
								type="button"
								onClick={() => void handleExport(["chat_messages", "media_albums"], "free-grind-profile-db")}
								disabled={isExporting}
								className={`flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors ${isExporting ? "opacity-50" : "hover:bg-[var(--surface-2)] active:bg-[var(--surface-2)]"}`}
							>
								<div className="shrink-0 rounded-2xl bg-sky-500/15 p-2.5 text-sky-400">
									<Database className="h-5 w-5" />
								</div>
								<div className="min-w-0 flex-1">
									<p className="text-sm font-semibold leading-snug">
										{t("data_backup.export_profile_db", { defaultValue: "Export Profile & Photo History DB" })}
									</p>
									<p className="mt-0.5 text-xs leading-snug text-[var(--text-muted)]">
										{t("data_backup.export_profile_db_desc", {
											defaultValue: "Exports known profile IDs, favorite photo history, avatars, and chat directory into a portable backup.",
										})}
									</p>
								</div>
								{isExporting ? (
									<Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--text-muted)]" />
								) : (
									<Download className="h-4 w-4 shrink-0 text-[var(--text-muted)] opacity-50" />
								)}
							</button>
							<button
								type="button"
								onClick={() => void handleExport(BACKUP_CATEGORY_IDS, "free-grind-db", "sqlite3")}
								disabled={isExporting}
								className={`flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors ${isExporting ? "opacity-50" : "hover:bg-[var(--surface-2)] active:bg-[var(--surface-2)]"}`}
							>
								<div className="shrink-0 rounded-2xl bg-emerald-500/15 p-2.5 text-emerald-400">
									<Database className="h-5 w-5" />
								</div>
								<div className="min-w-0 flex-1">
									<p className="text-sm font-semibold leading-snug">
										{t("data_backup.export_sqlite_db", { defaultValue: "Export Raw SQLite DB (.sqlite3)" })}
									</p>
									<p className="mt-0.5 text-xs leading-snug text-[var(--text-muted)]">
										{t("data_backup.export_sqlite_db_desc", {
											defaultValue: "Creates a clean, self-contained .sqlite3 snapshot with provenance tracking for direct inspection or combining.",
										})}
									</p>
								</div>
								{isExporting ? (
									<Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--text-muted)]" />
								) : (
									<Download className="h-4 w-4 shrink-0 text-[var(--text-muted)] opacity-50" />
								)}
							</button>
							<button
								type="button"
								onClick={() => void handleSyncMasterDb()}
								disabled={isSyncingMaster}
								className={`flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors ${isSyncingMaster ? "opacity-50" : "hover:bg-[var(--surface-2)] active:bg-[var(--surface-2)]"}`}
							>
								<div className="shrink-0 rounded-2xl bg-purple-500/15 p-2.5 text-purple-400">
									<Database className="h-5 w-5" />
								</div>
								<div className="min-w-0 flex-1">
									<p className="text-sm font-semibold leading-snug">
										{t("data_backup.sync_master_db", { defaultValue: "Sync Master Database (master.sqlite3)" })}
									</p>
									<p className="mt-0.5 text-xs leading-snug text-[var(--text-muted)]">
										{t("data_backup.sync_master_db_desc", {
											defaultValue: "Consolidates known profiles, photo history, snapshots, albums, avatars, and chats across all accounts without mixing locations.",
										})}
									</p>
								</div>
								{isSyncingMaster ? (
									<Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--text-muted)]" />
								) : (
									<RefreshCw className="h-4 w-4 shrink-0 text-[var(--text-muted)] opacity-50" />
								)}
							</button>
							<button
								type="button"
								onClick={() => void openDbBrowser()}
								className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-[var(--surface-2)] active:bg-[var(--surface-2)]"
							>
								<div className="shrink-0 rounded-2xl bg-amber-500/15 p-2.5 text-amber-400">
									<Eye className="h-5 w-5" />
								</div>
								<div className="min-w-0 flex-1">
									<p className="text-sm font-semibold leading-snug">
										{t("data_backup.poll_browse_db", { defaultValue: "Poll & Browse Databases" })}
									</p>
									<p className="mt-0.5 text-xs leading-snug text-[var(--text-muted)]">
										{t("data_backup.poll_browse_db_desc", {
											defaultValue: "Discover all local SQLite DBs & tables (snapshots, blocks, pull logs, contact status), preview rows, and merge from another account DB.",
										})}
									</p>
								</div>
								<Eye className="h-4 w-4 shrink-0 text-[var(--text-muted)] opacity-50" />
							</button>
							<button
								type="button"
								onClick={() => fileInputRef.current?.click()}
								disabled={isImporting}
								className={`flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors ${isImporting ? "opacity-50" : "hover:bg-[var(--surface-2)] active:bg-[var(--surface-2)]"}`}
							>
								<div className="shrink-0 rounded-2xl bg-indigo-500/15 p-2.5 text-indigo-400">
									<FileUp className="h-5 w-5" />
								</div>
								<div className="min-w-0 flex-1">
									<p className="text-sm font-semibold leading-snug">
										{t("data_backup.import_profile_db", { defaultValue: "Import / Combine DB or ZIP" })}
									</p>
									<p className="mt-0.5 text-xs leading-snug text-[var(--text-muted)]">
										{t("data_backup.import_profile_db_desc", {
											defaultValue: "Merge one or more .zip or .sqlite3/.db files into this account and choose exact tables to include.",
										})}
									</p>
								</div>
								{isImporting ? (
									<Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--text-muted)]" />
								) : (
									<Upload className="h-4 w-4 shrink-0 text-[var(--text-muted)] opacity-50" />
								)}
							</button>
						</div>
					</div>

					{/* Media Storage */}
					<div>
						<p className="mb-2 px-1 text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">
							{t("data_backup.media_storage", { defaultValue: "Media Storage" })}
						</p>
						<div className="surface-card overflow-hidden divide-y divide-[var(--border)]">
							<div
								id="data-storage-used"
								className={`flex items-center justify-between gap-4 px-4 py-3.5 ${highlightId === "data-storage-used" ? "animate-settings-highlight" : ""}`}
							>
								<div className="min-w-0">
									<p className="text-sm font-medium text-[var(--text)]">
										{t("data_backup.storage_used", { defaultValue: "Storage used" })}
									</p>
									<p className="mt-0.5 text-xs text-[var(--text-muted)]">
										{isLoadingUsage
											? t("data_backup.storage_loading", { defaultValue: "Calculating…" })
											: t("data_backup.storage_summary", {
													defaultValue: "{{size}} across {{count}} files",
													size: formatBytes(usage?.totalBytes ?? 0),
													count: usage?.count ?? 0,
												})}
									</p>
								</div>
								<button
									type="button"
									onClick={() => setShowDeleteConfirm(true)}
									disabled={isDeleting || isLoadingUsage || (usage?.count ?? 0) === 0}
									className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border border-red-500/30 bg-red-500/10 px-3 text-xs font-semibold text-red-400 transition hover:bg-red-500/20 disabled:opacity-50"
								>
									{isDeleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
									{t("data_backup.delete_all", { defaultValue: "Delete all" })}
								</button>
							</div>
						</div>
					</div>

					{/* Saved Phrases */}
					<div>
						<p className="mb-2 px-1 text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">
							{t("data_backup.phrases_section", { defaultValue: "Saved Phrases" })}
						</p>
						<div className="surface-card overflow-hidden divide-y divide-[var(--border)]">
							<button
								id="data-phrases-export"
								type="button"
								onClick={() => void handleExportPhrasesTxt()}
								disabled={savedPhrases.length === 0 || isExportingPhrases}
								className={`flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors ${savedPhrases.length === 0 ? "opacity-50" : "hover:bg-[var(--surface-2)] active:bg-[var(--surface-2)]"} ${highlightId === "data-phrases-export" ? "animate-settings-highlight" : ""}`}
							>
								<div className="shrink-0 rounded-2xl bg-teal-500/15 p-2.5 text-teal-400">
									<MessageSquareQuote className="h-5 w-5" />
								</div>
								<div className="min-w-0 flex-1">
									<p className="text-sm font-semibold leading-snug">
										{t("data_backup.phrases_export", { defaultValue: "Export .txt" })}
									</p>
									<p className="mt-0.5 text-xs leading-snug text-[var(--text-muted)]">
										{t("data_backup.phrases_export_desc", {
											defaultValue: "Save your saved phrases as a plain text file, one per line.",
										})}
									</p>
								</div>
								{isExportingPhrases ? (
									<Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--text-muted)]" />
								) : (
									<Download className="h-4 w-4 shrink-0 text-[var(--text-muted)] opacity-50" />
								)}
							</button>

							<button
								id="data-phrases-import"
								type="button"
								onClick={() => phrasesInputRef.current?.click()}
								disabled={isImportingPhrases}
								className={`flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors ${isImportingPhrases ? "opacity-50" : "hover:bg-[var(--surface-2)] active:bg-[var(--surface-2)]"} ${highlightId === "data-phrases-import" ? "animate-settings-highlight" : ""}`}
							>
								<div className="shrink-0 rounded-2xl bg-violet-500/15 p-2.5 text-violet-400">
									<Upload className="h-5 w-5" />
								</div>
								<div className="min-w-0 flex-1">
									<p className="text-sm font-semibold leading-snug">
										{isImportingPhrases
											? t("data_backup.phrases_importing", { defaultValue: "Importing…" })
											: t("data_backup.phrases_import", { defaultValue: "Import .txt" })}
									</p>
									<p className="mt-0.5 text-xs leading-snug text-[var(--text-muted)]">
										{t("data_backup.phrases_import_desc", {
											defaultValue: "One phrase per line — replaces the current list.",
										})}
									</p>
								</div>
								{isImportingPhrases ? (
									<Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--text-muted)]" />
								) : (
									<Upload className="h-4 w-4 shrink-0 text-[var(--text-muted)] opacity-50" />
								)}
							</button>
						</div>
						<input
							ref={phrasesInputRef}
							type="file"
							accept=".txt,text/plain"
							className="hidden"
							onChange={(event) => void handleImportPhrasesFile(event)}
						/>
					</div>

					{/* Encounters */}
					<div>
						<p className="mb-2 px-1 text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">
							{t("data_backup.encounters_section", { defaultValue: "Sexual Encounters" })}
						</p>
						<div className="surface-card overflow-hidden divide-y divide-[var(--border)]">
							<button
								id="data-encounters-export"
								type="button"
								onClick={() => void handleExportEncountersIcs()}
								disabled={isExportingEncounters}
								className={`flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors ${isExportingEncounters ? "opacity-50" : "hover:bg-[var(--surface-2)] active:bg-[var(--surface-2)]"} ${highlightId === "data-encounters-export" ? "animate-settings-highlight" : ""}`}
							>
								<div className="shrink-0 rounded-2xl bg-teal-500/15 p-2.5 text-teal-400">
									<CalendarDays className="h-5 w-5" />
								</div>
								<div className="min-w-0 flex-1">
									<p className="text-sm font-semibold leading-snug">
										{t("data_backup.encounters_export", { defaultValue: "Export .ics" })}
									</p>
									<p className="mt-0.5 text-xs leading-snug text-[var(--text-muted)]">
										{t("data_backup.encounters_export_desc", {
											defaultValue: "Save your logged encounters as a calendar file you can import into any calendar app.",
										})}
									</p>
								</div>
								{isExportingEncounters ? (
									<Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--text-muted)]" />
								) : (
									<Download className="h-4 w-4 shrink-0 text-[var(--text-muted)] opacity-50" />
								)}
							</button>
						</div>
					</div>
				</div>

				{/* Danger Zone */}
				<div>
					<p className="mb-2 px-1 text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)]">
						{t("data_backup.danger_zone", { defaultValue: "Danger Zone" })}
					</p>
					<div className="surface-card overflow-hidden divide-y divide-[var(--border)]">
						<div
							id="data-reset-all"
							className={`flex items-center justify-between gap-4 px-4 py-3.5 ${highlightId === "data-reset-all" ? "animate-settings-highlight" : ""}`}
						>
							<div className="min-w-0">
								<p className="text-sm font-medium text-[var(--text)]">
									{t("data_backup.reset_all", { defaultValue: "Reset all settings" })}
								</p>
								<p className="mt-0.5 text-xs leading-snug text-[var(--text-muted)]">
									{t("data_backup.reset_all_desc", {
										defaultValue: "Restores theme, layout, privacy, automation, filters and notification settings to their defaults. Conversations and media are not affected.",
									})}
								</p>
							</div>
							<button
								type="button"
								onClick={() => setShowResetConfirm(true)}
								disabled={isResetting}
								className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border border-red-500/30 bg-red-500/10 px-3 text-xs font-semibold text-red-400 transition hover:bg-red-500/20 disabled:opacity-50"
							>
								{isResetting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
								{t("data_backup.reset_all", { defaultValue: "Reset all settings" })}
							</button>
						</div>
					</div>
				</div>
			</div>

			<ConfirmDialog
				isOpen={showDeleteConfirm}
				title={t("data_backup.delete_confirm_title", { defaultValue: "Delete all downloaded media?" })}
				message={t("data_backup.delete_confirm_message", {
					defaultValue: "This permanently deletes every photo and video this app has saved to your device. The app's own local cache is not affected.",
				})}
				confirmLabel={t("data_backup.delete_all", { defaultValue: "Delete all" })}
				cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
				confirmTone="danger"
				isProcessing={isDeleting}
				onConfirm={() => void handleDeleteAll()}
				onCancel={() => setShowDeleteConfirm(false)}
			/>

			<ConfirmDialog
				isOpen={showResetConfirm}
				title={t("data_backup.reset_confirm_title", { defaultValue: "Reset all settings?" })}
				message={t("data_backup.reset_confirm_message", {
					defaultValue: "This restores theme, layout, privacy, automation, filters and notification settings to their defaults. Conversations, media and your account are not affected. The app will reload.",
				})}
				confirmLabel={t("data_backup.reset_all", { defaultValue: "Reset all settings" })}
				cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
				confirmTone="danger"
				isProcessing={isResetting}
				onConfirm={() => void handleResetAllSettings()}
				onCancel={() => setShowResetConfirm(false)}
			/>

			{showExportCategoryPicker && (
				<BottomSheet
					onClose={() => setShowExportCategoryPicker(false)}
					isDesktop={isDesktop}
					isProcessing={isExporting}
					panelClassName="max-h-[86dvh]"
				>
					<div className="flex items-center justify-between px-4 pb-3">
						<p className="text-sm font-semibold text-[var(--text)]">
							{t("data_backup.export_categories_title", { defaultValue: "What do you want to export?" })}
						</p>
						<SheetClose
							disabled={isExporting}
							className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text)] disabled:opacity-60"
						>
							<X className="h-4 w-4" />
						</SheetClose>
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto pb-4" data-lenis-prevent>
						<div className="mx-4 mb-3 flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-1">
							<button
								type="button"
								onClick={() => setExportFormat("zip")}
								disabled={isExporting}
								className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
									exportFormat === "zip"
										? "bg-[var(--accent)] text-[var(--accent-contrast)]"
										: "text-[var(--text-muted)] hover:text-[var(--text)]"
								}`}
							>
								ZIP Backup (.zip)
							</button>
							<button
								type="button"
								onClick={() => setExportFormat("sqlite3")}
								disabled={isExporting}
								className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
									exportFormat === "sqlite3"
										? "bg-[var(--accent)] text-[var(--accent-contrast)]"
										: "text-[var(--text-muted)] hover:text-[var(--text)]"
								}`}
							>
								SQLite DB (.sqlite3)
							</button>
						</div>
						<div className="mb-2 flex items-center justify-between gap-2 px-4">
							<button
								type="button"
								onClick={() => void pollActiveExportDb()}
								disabled={isExporting || isPollingExportDb}
								className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--accent)] hover:underline disabled:opacity-50"
							>
								<RefreshCw className={`h-3 w-3 ${isPollingExportDb ? "animate-spin" : ""}`} />
								<span>Poll DB tables</span>
							</button>
							<div className="flex items-center gap-2">
								<button
									type="button"
									onClick={() => {
										setExportCategories(new Set(BACKUP_CATEGORY_IDS));
										if (exportPollTables.length > 0) {
											setSelectedExportTables(new Set(exportPollTables.map((tbl) => tbl.name)));
										}
									}}
									disabled={isExporting}
									className="text-xs font-medium text-[var(--accent)] hover:underline disabled:opacity-50"
								>
									{t("data_backup.select_all", { defaultValue: "Select all" })}
								</button>
								<span className="text-xs text-[var(--text-muted)]">·</span>
								<button
									type="button"
									onClick={() => {
										setExportCategories(new Set());
										setSelectedExportTables(new Set());
									}}
									disabled={isExporting}
									className="text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-50"
								>
									{t("data_backup.deselect_all", { defaultValue: "Clear" })}
								</button>
							</div>
						</div>
						<BackupCategoryPicker categories={BACKUP_CATEGORY_IDS} selected={exportCategories} onToggle={toggleExportCategory} />
						{exportPollTables.length > 0 && selectedExportTables && (
							<PolledTableChecklist
								tables={exportPollTables}
								selected={selectedExportTables}
								onToggle={toggleExportTable}
								onSelectAll={() => setSelectedExportTables(new Set(exportPollTables.map((tbl) => tbl.name)))}
								onClear={() => setSelectedExportTables(new Set())}
								onPreview={(tableName) =>
									void openTablePreview({
										dbFileName: chatDb.getActiveChatDbFileName(),
										sourceLabel: chatDb.getActiveChatDbFileName(),
										tableName,
									})
								}
								disabled={isExporting}
							/>
						)}
					</div>
					<div className="flex gap-2 px-4 pb-4 pt-2">
						<SheetClose
							disabled={isExporting}
							className="inline-flex h-11 flex-1 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 text-sm font-medium text-[var(--text-muted)] transition hover:border-[var(--accent)] hover:text-[var(--text)] disabled:opacity-60"
						>
							{t("common.cancel", { defaultValue: "Cancel" })}
						</SheetClose>
						<button
							type="button"
							onClick={() => {
								void (async () => {
									const success = await handleExport();
									if (success) {
										setShowExportCategoryPicker(false);
									}
								})();
							}}
							disabled={
								isExporting ||
								(selectedExportTables != null ? selectedExportTables.size === 0 : exportCategories.size === 0)
							}
							className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-[var(--accent)] bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--accent-contrast)] transition hover:brightness-110 disabled:opacity-60"
						>
							{isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
							<span>{exportFormat === "sqlite3" ? "Export .sqlite3" : t("data_backup.export_confirm", { defaultValue: "Export" })}</span>
						</button>
					</div>
				</BottomSheet>
			)}

			{pendingImport && (
				<BottomSheet onClose={handleCancelImport} isDesktop={isDesktop} isProcessing={isImporting} panelClassName="max-h-[86dvh]">
					<div className="flex items-center justify-between px-4 pb-3">
						<p className="text-sm font-semibold text-[var(--text)]">
							{t("data_backup.import_categories_title", { defaultValue: "What do you want to restore?" })}
						</p>
						<SheetClose
							disabled={isImporting}
							className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text)] disabled:opacity-60"
						>
							<X className="h-4 w-4" />
						</SheetClose>
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto pb-4" data-lenis-prevent>
						<p className="mb-2 px-4 text-xs leading-relaxed text-[var(--text-muted)]">
							{pendingImport.items.length > 1
								? t("data_backup.import_combine_multi_desc", {
										defaultValue: "Combining {{count}} backup archives cleanly without erasing existing records.",
										count: pendingImport.items.length,
									})
								: t("data_backup.import_categories_desc", {
										defaultValue: "Choose which categories or individual tables to merge into your active database.",
									})}
						</p>
						{pendingImport.items.length > 0 && (
							<div className="mx-4 mb-2 flex flex-wrap gap-1.5">
								{pendingImport.items.map((item) => (
									<span
										key={item.tempPath}
										className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5 font-mono text-[11px] text-[var(--text-muted)]"
									>
										{item.fileName}
										{item.ownerUserId != null ? ` (#${item.ownerUserId})` : ""}
									</span>
								))}
							</div>
						)}
						{pendingImport.hasDifferentOwner && (
							<div className="mx-4 mb-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-300">
								{t("data_backup.import_cross_owner_note", {
									defaultValue: "Includes a backup from another account — conversations, outgoing messages, and albums remap to your active profile while keeping source provenance.",
								})}
							</div>
						)}
						<div className="mb-2 flex items-center justify-end gap-2 px-4">
							<button
								type="button"
								onClick={() =>
									setPendingImport((prev) =>
										prev
											? {
													...prev,
													selected: new Set(prev.categories),
													selectedTables: new Set(prev.polledTables.map((tbl) => tbl.name)),
												}
											: prev,
									)
								}
								disabled={isImporting}
								className="text-xs font-medium text-[var(--accent)] hover:underline disabled:opacity-50"
							>
								{t("data_backup.select_all", { defaultValue: "Select all" })}
							</button>
							<span className="text-xs text-[var(--text-muted)]">·</span>
							<button
								type="button"
								onClick={() =>
									setPendingImport((prev) =>
										prev ? { ...prev, selected: new Set(), selectedTables: new Set() } : prev,
									)
								}
								disabled={isImporting}
								className="text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-50"
							>
								{t("data_backup.deselect_all", { defaultValue: "Clear" })}
							</button>
						</div>
						<BackupCategoryPicker categories={pendingImport.categories} selected={pendingImport.selected} onToggle={toggleImportCategory} />
						{pendingImport.polledTables.length > 0 && (
							<PolledTableChecklist
								tables={pendingImport.polledTables}
								selected={pendingImport.selectedTables}
								onToggle={toggleImportTable}
								onSelectAll={() =>
									setPendingImport((prev) =>
										prev
											? {
													...prev,
													selectedTables: new Set(prev.polledTables.map((tbl) => tbl.name)),
													useTableFilter: true,
												}
											: prev,
									)
								}
								onClear={() =>
									setPendingImport((prev) =>
										prev ? { ...prev, selectedTables: new Set(), useTableFilter: true } : prev,
									)
								}
								onPreview={(tableName) => {
									const match = pendingImport.items.find((it) => it.tables.includes(tableName)) ?? pendingImport.items[0];
									if (match) {
										void openTablePreview({
											sourcePath: match.tempPath,
											sourceLabel: match.fileName,
											tableName,
										});
									}
								}}
								disabled={isImporting}
							/>
						)}
					</div>
					<div className="flex gap-2 px-4 pb-4 pt-2">
						<SheetClose
							disabled={isImporting}
							className="inline-flex h-11 flex-1 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 text-sm font-medium text-[var(--text-muted)] transition hover:border-[var(--accent)] hover:text-[var(--text)] disabled:opacity-60"
						>
							{t("common.cancel", { defaultValue: "Cancel" })}
						</SheetClose>
						<button
							type="button"
							onClick={() => void handleConfirmImport()}
							disabled={
								isImporting ||
								(pendingImport.useTableFilter ? pendingImport.selectedTables.size === 0 : pendingImport.selected.size === 0)
							}
							className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-[var(--accent)] bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--accent-contrast)] transition hover:brightness-110 disabled:opacity-60"
						>
							{isImporting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
							<span>{t("data_backup.import_confirm", { defaultValue: "Restore / Combine" })}</span>
						</button>
					</div>
				</BottomSheet>
			)}

			{showDbBrowser && (
				<BottomSheet
					onClose={() => setShowDbBrowser(false)}
					isDesktop={isDesktop}
					panelClassName="max-h-[86dvh]"
				>
					<div className="flex items-center justify-between px-4 pb-3">
						<p className="text-sm font-semibold text-[var(--text)]">Poll & Browse Local Databases</p>
						<SheetClose className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text)]">
							<X className="h-4 w-4" />
						</SheetClose>
					</div>
					<div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4" data-lenis-prevent>
						<div className="flex items-center justify-between gap-2">
							<span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
								Local SQLite Files ({localDbs.length})
							</span>
							<button
								type="button"
								onClick={() => void openDbBrowser()}
								disabled={isLoadingLocalDbs}
								className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent)] hover:underline disabled:opacity-50"
							>
								<RefreshCw className={`h-3 w-3 ${isLoadingLocalDbs ? "animate-spin" : ""}`} />
								<span>Refresh</span>
							</button>
						</div>

						<div className="space-y-1.5">
							{localDbs.map((db) => {
								const activeFile = chatDb.getActiveChatDbFileName();
								const isSelected = browsedDbPath === db.path || (browsedDbPath == null && db.fileName === activeFile);
								const isSameActive = db.fileName === activeFile;
								return (
									<div
										key={db.path}
										className={`flex items-center gap-2 rounded-xl border px-3 py-2 ${
											isSelected
												? "border-[var(--accent)] bg-[var(--accent)]/10"
												: "border-[var(--border)] bg-[var(--surface-2)]/50"
										}`}
									>
										<button
											type="button"
											onClick={() => void pollBrowserDb(db.path)}
											className="min-w-0 flex-1 text-left"
										>
											<div className="flex items-center gap-1.5">
												<span className="truncate font-mono text-xs font-semibold text-[var(--text)]">
													{db.fileName}
												</span>
												{isSameActive && (
													<span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
														active
													</span>
												)}
											</div>
											<p className="text-[11px] text-[var(--text-muted)]">
												{formatBytes(db.sizeBytes)} · {db.kind}
												{db.ownerUserId != null ? ` · #${db.ownerUserId}` : ""}
											</p>
										</button>
										{!isSameActive && (
											<button
												type="button"
												onClick={() => {
													setShowDbBrowser(false);
													void inspectPathsIntoPendingImport([
														{ path: db.path, fileName: db.fileName, isTemp: false },
													]);
												}}
												className="shrink-0 rounded-lg border border-[var(--accent)]/50 bg-[var(--accent)]/15 px-2.5 py-1 text-xs font-semibold text-[var(--accent)] hover:bg-[var(--accent)]/25"
											>
												Merge…
											</button>
										)}
									</div>
								);
							})}
						</div>

						<div className="pt-1">
							<div className="mb-2 flex items-center justify-between">
								<span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
									{browsedPoll ? `Tables in ${browsedPoll.sourceName} (${browsedPoll.tables.length})` : "Tables"}
								</span>
								{isPollingBrowser ? <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" /> : null}
							</div>
							{browsedPoll && (
								<div className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
									{browsedPoll.tables.map((tbl) => (
										<div key={tbl.name} className="flex items-center justify-between gap-2 px-3 py-2">
											<div className="min-w-0 flex-1">
												<div className="flex items-center gap-1.5">
													<span className="truncate font-mono text-xs font-semibold text-[var(--text)]">
														{tbl.name}
													</span>
													{!tbl.knownExportTable && (
														<span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
															extra
														</span>
													)}
												</div>
												<p className="truncate text-[11px] text-[var(--text-muted)]">
													{tbl.rowCount.toLocaleString()} rows · cols: {tbl.columns.join(", ")}
												</p>
											</div>
											<button
												type="button"
												onClick={() =>
													void openTablePreview({
														sourcePath: browsedDbPath ?? undefined,
														dbFileName: browsedDbPath ? undefined : chatDb.getActiveChatDbFileName(),
														sourceLabel: browsedPoll.sourceName,
														tableName: tbl.name,
													})
												}
												className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-[var(--border)] px-2 py-1 text-xs font-medium text-[var(--text)] hover:border-[var(--accent)]"
											>
												<Eye className="h-3 w-3" />
												<span>View</span>
											</button>
										</div>
									))}
								</div>
							)}
						</div>
					</div>
				</BottomSheet>
			)}

			{tablePreview && (
				<BottomSheet
					onClose={() => setTablePreview(null)}
					isDesktop={isDesktop}
					panelClassName="max-h-[88dvh]"
				>
					<div className="flex items-center justify-between px-4 pb-3">
						<div className="min-w-0 flex-1 pr-2">
							<p className="truncate font-mono text-sm font-semibold text-[var(--text)]">
								{tablePreview.tableName}
							</p>
							<p className="truncate text-xs text-[var(--text-muted)]">
								{tablePreview.sourceLabel}
								{tablePreview.data ? ` · ${tablePreview.data.totalRows.toLocaleString()} total rows` : ""}
							</p>
						</div>
						<SheetClose className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text)]">
							<X className="h-4 w-4" />
						</SheetClose>
					</div>
					<div className="min-h-0 flex-1 overflow-auto px-4 pb-4" data-lenis-prevent>
						{tablePreview.loading ? (
							<div className="flex items-center justify-center py-12 text-xs text-[var(--text-muted)]">
								<Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading rows…
							</div>
						) : !tablePreview.data || tablePreview.data.rows.length === 0 ? (
							<p className="py-8 text-center text-xs text-[var(--text-muted)]">No rows in this table.</p>
						) : (
							<div className="overflow-x-auto rounded-xl border border-[var(--border)]">
								<table className="w-full border-collapse text-left text-[11px]">
									<thead className="bg-[var(--surface-2)] text-[var(--text-muted)]">
										<tr>
											{tablePreview.data.columns.map((col) => (
												<th key={col} className="whitespace-nowrap border-b border-[var(--border)] px-2.5 py-1.5 font-mono font-semibold">
													{col}
												</th>
											))}
										</tr>
									</thead>
									<tbody className="divide-y divide-[var(--border)]">
										{tablePreview.data.rows.map((row, idx) => (
											<tr key={idx} className="hover:bg-[var(--surface-2)]/40">
												{tablePreview.data!.columns.map((col) => {
													const raw = row[col];
													const text =
														raw == null
															? "NULL"
															: typeof raw === "object"
																? JSON.stringify(raw)
																: String(raw);
													return (
														<td
															key={col}
															className="max-w-[220px] truncate whitespace-nowrap px-2.5 py-1.5 font-mono text-[var(--text)]"
															title={text}
														>
															{text}
														</td>
													);
												})}
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</div>
					{tablePreview.data && tablePreview.data.totalRows > 50 && (
						<div className="flex items-center justify-between gap-2 border-t border-[var(--border)] px-4 py-3 text-xs">
							<button
								type="button"
								disabled={tablePreview.loading || tablePreview.offset === 0}
								onClick={() =>
									void openTablePreview(
										{
											sourcePath: tablePreview.sourcePath,
											dbFileName: tablePreview.dbFileName,
											sourceLabel: tablePreview.sourceLabel,
											tableName: tablePreview.tableName,
										},
										Math.max(0, tablePreview.offset - 50),
									)
								}
								className="rounded-lg border border-[var(--border)] px-3 py-1.5 font-medium text-[var(--text)] disabled:opacity-40"
							>
								Previous 50
							</button>
							<span className="text-[var(--text-muted)]">
								Rows {tablePreview.offset + 1}–{Math.min(tablePreview.offset + 50, tablePreview.data.totalRows)} of{" "}
								{tablePreview.data.totalRows.toLocaleString()}
							</span>
							<button
								type="button"
								disabled={tablePreview.loading || tablePreview.offset + 50 >= tablePreview.data.totalRows}
								onClick={() =>
									void openTablePreview(
										{
											sourcePath: tablePreview.sourcePath,
											dbFileName: tablePreview.dbFileName,
											sourceLabel: tablePreview.sourceLabel,
											tableName: tablePreview.tableName,
										},
										tablePreview.offset + 50,
									)
								}
								className="rounded-lg border border-[var(--border)] px-3 py-1.5 font-medium text-[var(--text)] disabled:opacity-40"
							>
								Next 50
							</button>
						</div>
					)}
				</BottomSheet>
			)}
		</section>
	);
}
