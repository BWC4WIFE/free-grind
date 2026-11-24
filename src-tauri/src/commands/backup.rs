//! Native backup/restore for the local chat database.
//!
//! Replaces the old all-JS export (one giant JSON file with photos/videos
//! base64-embedded inline in the rows) with a zip archive built directly in
//! Rust: SQL reads, base64 decode, and compression all happen natively
//! instead of crossing the JS<->WebView IPC bridge as multi-hundred-MB text.
//!
//! Archive layout (version 2):
//!   manifest.json        - { version, exportedAt, ownerUserId, categories }
//!   tables/<name>.jsonl   - one JSON object per row, ORDER BY the table's primary key
//!                           (only present for tables whose category was selected)
//!   media/<n>.bin         - raw bytes for each blob column, referenced from its
//!                           row as { "$mediaRef": "media/<n>.bin" } instead of
//!                           inlining base64 text
//!
//! `categories` lets the caller include/exclude whole groups of tables
//! (chat messages, media/albums, saved phrases, saved locations, settings,
//! sexual health - see `BACKUP_CATEGORY_IDS` in `src/services/backupRestore.ts`)
//! instead of always doing a full all-or-nothing export/import.
//!
//! Blob columns (data_base64 etc.) are stored as base64 TEXT in the sqlite
//! schema itself, so export decodes them once here and stores raw bytes
//! (Stored, uncompressed - photos/video are already compressed); import
//! re-encodes them back to base64 text to match the existing column type.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::{
    STANDARD as BASE64, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD,
};
use base64::Engine as _;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager};
use zip::result::ZipError;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::error::AppError;

const BACKUP_VERSION: i64 = 2;
const EXPORT_PROGRESS_EVENT: &str = "backup-export-progress";
const IMPORT_PROGRESS_EVENT: &str = "backup-import-progress";
const PROGRESS_EVERY_N_ROWS: u64 = 200;
const SQLITE_HEADER: &[u8; 16] = b"SQLite format 3\0";

struct TableSpec {
    name: &'static str,
    primary_key: &'static str,
    /// One of the user-facing backup categories (see `BACKUP_CATEGORIES` in
    /// `src/services/backupRestore.ts`) - lets export/import include or skip
    /// whole groups of tables together instead of always doing all-or-nothing.
    category: &'static str,
    columns: &'static [&'static str],
    blob_columns: &'static [&'static str],
}

/// Mirrors `FULL_EXPORT_TABLES` in `src/services/chatDb.ts` plus provenance &
/// diagnostic capture tables (`profile_snapshots`, `block_events`,
/// `hidden_profiles`, `downloaded_media`, `drawer_media_usage`, `data_pull_log`),
/// while preserving omission of `album_media.position`.
const EXPORT_TABLES: &[TableSpec] = &[
    TableSpec {
        name: "conversations",
        primary_key: "conversation_id",
        category: "chat_messages",
        columns: &[
            "conversation_id",
            "other_profile_id",
            "name",
            "participants_json",
            "last_activity_timestamp",
            "unread_count",
            "pinned",
            "muted",
            "favorite",
            "preview_json",
            "archived",
            "archived_reason",
            "archived_at",
            "hidden",
            "last_seen_in_inbox_at",
            "source_owner_id",
            "created_at",
            "updated_at",
        ],
        blob_columns: &[],
    },
    TableSpec {
        name: "conversation_meta",
        primary_key: "conversation_id",
        category: "chat_messages",
        columns: &["conversation_id", "last_read_timestamp"],
        blob_columns: &[],
    },
    TableSpec {
        name: "messages",
        primary_key: "message_id",
        category: "chat_messages",
        columns: &[
            "message_id",
            "conversation_id",
            "sender_id",
            "timestamp",
            "type",
            "chat1_type",
            "body_json",
            "unsent",
            "local_history",
            "reply_to_message_id",
            "reply_preview_json",
            "reactions_json",
            "source_owner_id",
            "created_at",
            "updated_at",
        ],
        blob_columns: &[],
    },
    TableSpec {
        name: "media_files",
        primary_key: "media_key",
        category: "media_albums",
        columns: &[
            "media_key",
            "conversation_id",
            "message_id",
            "kind",
            "mime_type",
            "data_base64",
            "view_once",
            "size_bytes",
            "fetch_status",
            "fetched_at",
        ],
        blob_columns: &["data_base64"],
    },
    TableSpec {
        name: "albums",
        primary_key: "album_id",
        category: "media_albums",
        columns: &[
            "album_id",
            "owner_profile_id",
            "album_name",
            "conversation_id",
            "shared_via_message_id",
            "preview_cover_base64",
            "preview_cover_mime_type",
            "created_at",
            "updated_at",
        ],
        blob_columns: &["preview_cover_base64"],
    },
    TableSpec {
        name: "album_media",
        primary_key: "content_id",
        category: "media_albums",
        columns: &[
            "content_id",
            "album_id",
            "content_type",
            "data_base64",
            "thumb_data_base64",
            "remaining_views",
            "is_viewable",
            "fetched_at",
        ],
        blob_columns: &["data_base64", "thumb_data_base64"],
    },
    TableSpec {
        name: "avatars",
        primary_key: "media_hash",
        category: "media_albums",
        columns: &["media_hash", "data_base64", "mime_type", "fetched_at"],
        blob_columns: &["data_base64"],
    },
    TableSpec {
        name: "settings",
        primary_key: "key",
        category: "settings",
        columns: &["key", "value"],
        blob_columns: &[],
    },
    TableSpec {
        name: "saved_phrases",
        primary_key: "phrase",
        category: "saved_phrases",
        columns: &["phrase", "created_at"],
        blob_columns: &[],
    },
    TableSpec {
        name: "saved_locations",
        primary_key: "id",
        category: "saved_locations",
        columns: &["id", "name", "geohash", "lat", "lon", "created_at"],
        blob_columns: &[],
    },
    TableSpec {
        name: "sexual_health_prep_doses",
        primary_key: "id",
        category: "sexual_health",
        columns: &["id", "taken_at", "scheme", "dose_role", "note", "created_at"],
        blob_columns: &[],
    },
    TableSpec {
        name: "sexual_health_encounters",
        primary_key: "id",
        category: "sexual_health",
        columns: &[
            "id",
            "occurred_at",
            "profile_id",
            "display_name",
            "tags_json",
            "note",
            "conversation_id",
            "created_at",
        ],
        blob_columns: &[],
    },
    TableSpec {
        name: "sexual_health_appointments",
        primary_key: "id",
        category: "sexual_health",
        columns: &[
            "id",
            "title",
            "scheduled_at",
            "kind",
            "location",
            "note",
            "completed_at",
            "created_at",
        ],
        blob_columns: &[],
    },
    TableSpec {
        name: "sexual_health_sti_tests",
        primary_key: "id",
        category: "sexual_health",
        columns: &["id", "tested_at", "test_type", "result", "note", "created_at"],
        blob_columns: &[],
    },
    TableSpec {
        name: "known_profiles",
        primary_key: "profile_id",
        category: "chat_messages",
        columns: &[
            "profile_id",
            "display_name",
            "primary_image_hash",
            "is_favorite",
            "source_profile_id",
            "updated_at",
        ],
        blob_columns: &[],
    },
    TableSpec {
        name: "profile_photo_history",
        primary_key: "id",
        category: "media_albums",
        columns: &[
            "id",
            "profile_id",
            "image_hash",
            "first_seen_at",
            "last_seen_at",
            "source_profile_id",
        ],
        blob_columns: &[],
    },
    TableSpec {
        name: "profile_snapshots",
        primary_key: "profile_id",
        category: "chat_messages",
        columns: &["profile_id", "data", "updated_at"],
        blob_columns: &[],
    },
    TableSpec {
        name: "block_events",
        primary_key: "id",
        category: "chat_messages",
        columns: &[
            "id",
            "profile_id",
            "conversation_id",
            "event_type",
            "timestamp",
            "display_name",
            "avatar_media_hash",
            "created_at",
        ],
        blob_columns: &[],
    },
    TableSpec {
        name: "hidden_profiles",
        primary_key: "profile_id",
        category: "chat_messages",
        columns: &["profile_id", "display_name", "avatar_media_hash", "hidden_at"],
        blob_columns: &[],
    },
    TableSpec {
        name: "downloaded_media",
        primary_key: "identifier",
        category: "media_albums",
        columns: &[
            "identifier",
            "platform",
            "album_id",
            "byte_size",
            "mime_type",
            "kind",
            "saved_at",
        ],
        blob_columns: &[],
    },
    TableSpec {
        name: "drawer_media_usage",
        primary_key: "media_id",
        category: "media_albums",
        columns: &["media_id", "send_count", "updated_at"],
        blob_columns: &[],
    },
    TableSpec {
        name: "data_pull_log",
        primary_key: "id",
        category: "chat_messages",
        columns: &[
            "id",
            "source_owner_id",
            "target_owner_id",
            "source_format",
            "source_label",
            "categories_json",
            "tables_json",
            "rows_imported",
            "pulled_at",
        ],
        blob_columns: &[],
    },
    TableSpec {
        name: "favorite_notes",
        primary_key: "profile_id",
        category: "chat_messages",
        columns: &[
            "profile_id",
            "notes",
            "phone_number",
            "source_account_id",
            "updated_at",
        ],
        blob_columns: &[],
    },
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportProgress<'a> {
    table: &'a str,
    table_index: usize,
    table_count: usize,
    rows_done: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportProgress<'a> {
    table: std::borrow::Cow<'a, str>,
    table_index: usize,
    table_count: usize,
    rows_done: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    rows_imported: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInspection {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    categories: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tables: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exported_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    owner_user_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_different_owner: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolledTableInfo {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    primary_key: Option<String>,
    row_count: u64,
    columns: Vec<String>,
    known_export_table: bool,
    has_blobs: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabasePollResult {
    ok: bool,
    source_kind: String,
    source_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    owner_user_id: Option<i64>,
    tables: Vec<PolledTableInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDatabaseEntry {
    file_name: String,
    path: String,
    size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    modified_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    owner_user_id: Option<i64>,
    kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TablePreviewResult {
    ok: bool,
    table: String,
    columns: Vec<String>,
    total_rows: u64,
    rows: Vec<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSearchResultItem {
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    conversation_id: Option<String>,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    subtitle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    timestamp: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountLocationEntry {
    profile_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    location_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    short_location_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    geohash: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileAccountConversation {
    account_id: String,
    conversation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_activity_timestamp: Option<i64>,
    unread_count: i64,
    message_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_message_preview: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProfileCrossAccountProvenance {
    favorite_account_ids: Vec<String>,
    conversations: Vec<ProfileAccountConversation>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniChatMessage {
    message_id: String,
    conversation_id: String,
    sender_id: i64,
    timestamp: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    msg_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    unsent: bool,
}

/// Falls back to this if an archive's manifest predates the `categories`
/// field (shouldn't happen in practice - export always writes it now - but
/// costs nothing to handle gracefully rather than hide every table).
const ALL_CATEGORY_IDS: &[&str] =
    &["chat_messages", "media_albums", "saved_phrases", "saved_locations", "settings", "sexual_health"];

enum ManifestCheck {
    Valid {
        categories: Vec<String>,
        exported_at: i64,
        manifest_owner: i64,
    },
    Invalid(&'static str),
}

/// Shared by `inspect_backup_file` and `import_backup_from_file` so the
/// version validation rules can't drift between the two. Cross-account
/// backups are accepted here so users can combine backups across accounts.
fn read_and_validate_manifest(
    archive: &mut ZipArchive<BufReader<File>>,
) -> Result<ManifestCheck, AppError> {
    let manifest: Value = {
        let mut manifest_file = archive
            .by_name("manifest.json")
            .map_err(|_| AppError::Backup("archive is missing manifest.json".into()))?;
        let mut text = String::new();
        manifest_file.read_to_string(&mut text)?;
        match serde_json::from_str(&text) {
            Ok(value) => value,
            Err(_) => return Ok(ManifestCheck::Invalid("invalid_format")),
        }
    };

    let version = manifest.get("version").and_then(Value::as_i64);
    if version != Some(BACKUP_VERSION) {
        return Ok(ManifestCheck::Invalid("invalid_format"));
    }
    let Some(manifest_owner) = manifest.get("ownerUserId").and_then(Value::as_i64) else {
        return Ok(ManifestCheck::Invalid("invalid_format"));
    };

    let exported_at = manifest.get("exportedAt").and_then(Value::as_i64).unwrap_or(0);
    let categories = manifest
        .get("categories")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_else(|| ALL_CATEGORY_IDS.iter().map(|s| s.to_string()).collect());

    Ok(ManifestCheck::Valid { categories, exported_at, manifest_owner })
}

fn resolve_db_path(app: &AppHandle, db_file_name: &str) -> Result<std::path::PathBuf, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Backup(format!("failed to resolve app data dir: {e}")))?;
    Ok(dir.join(db_file_name))
}

fn sql_value_to_json(row: &rusqlite::Row, idx: usize) -> Result<Value, AppError> {
    use rusqlite::types::ValueRef;
    let value_ref = row.get_ref(idx)?;
    Ok(match value_ref {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Value::String(BASE64.encode(b)),
    })
}

fn json_to_rusqlite(value: &Value) -> Result<rusqlite::types::Value, AppError> {
    Ok(match value {
        Value::Null => rusqlite::types::Value::Null,
        Value::Bool(b) => rusqlite::types::Value::Integer(if *b { 1 } else { 0 }),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                rusqlite::types::Value::Integer(i)
            } else if let Some(u) = n.as_u64() {
                rusqlite::types::Value::Integer(u as i64)
            } else if let Some(f) = n.as_f64() {
                rusqlite::types::Value::Real(f)
            } else {
                return Err(AppError::Backup("unsupported number value in row".into()));
            }
        }
        Value::String(s) => rusqlite::types::Value::Text(s.clone()),
        Value::Array(_) | Value::Object(_) => {
            return Err(AppError::Backup("unsupported nested value in row".into()));
        }
    })
}

fn build_upsert_sql(table: &TableSpec) -> String {
    let cols_csv = table.columns.join(", ");
    let placeholders = (1..=table.columns.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    let t = table.name;
    let update_set = table
        .columns
        .iter()
        .copied()
        .filter(|&c| c != table.primary_key)
        .map(|c| match (t, c) {
            ("conversations", "other_profile_id" | "name") => {
                format!("{c} = COALESCE({t}.{c}, excluded.{c})")
            }
            ("conversations", "unread_count" | "pinned" | "muted" | "favorite" | "updated_at") => {
                format!("{c} = MAX({t}.{c}, excluded.{c})")
            }
            ("conversations", "created_at") => {
                "created_at = MIN(conversations.created_at, excluded.created_at)".to_owned()
            }
            ("conversations", "last_activity_timestamp" | "last_seen_in_inbox_at") => format!(
                "{c} = CASE WHEN {t}.{c} IS NULL THEN excluded.{c} WHEN excluded.{c} IS NULL THEN {t}.{c} ELSE MAX({t}.{c}, excluded.{c}) END"
            ),
            ("conversations", "preview_json") => {
                "preview_json = CASE WHEN COALESCE(excluded.last_activity_timestamp, 0) >= COALESCE(conversations.last_activity_timestamp, 0) THEN COALESCE(excluded.preview_json, conversations.preview_json) ELSE conversations.preview_json END".to_owned()
            }
            (
                "conversations",
                "participants_json" | "archived" | "archived_reason" | "archived_at" | "hidden",
            ) => format!(
                "{c} = CASE WHEN COALESCE(excluded.last_activity_timestamp, 0) >= COALESCE(conversations.last_activity_timestamp, 0) THEN excluded.{c} ELSE conversations.{c} END"
            ),
            ("conversation_meta", "last_read_timestamp") => {
                "last_read_timestamp = CASE WHEN conversation_meta.last_read_timestamp IS NULL THEN excluded.last_read_timestamp WHEN excluded.last_read_timestamp IS NULL THEN conversation_meta.last_read_timestamp ELSE MAX(conversation_meta.last_read_timestamp, excluded.last_read_timestamp) END".to_owned()
            }
            ("saved_phrases", "created_at") => {
                "created_at = MIN(saved_phrases.created_at, excluded.created_at)".to_owned()
            }
            ("media_files", "fetch_status") => {
                "fetch_status = CASE WHEN excluded.fetch_status = 'ready' OR media_files.fetch_status != 'ready' THEN excluded.fetch_status ELSE media_files.fetch_status END".to_owned()
            }
            ("known_profiles", "display_name" | "primary_image_hash") => {
                format!("{c} = COALESCE(NULLIF(excluded.{c}, ''), known_profiles.{c})")
            }
            ("known_profiles", "is_favorite" | "updated_at") => {
                format!("{c} = MAX(known_profiles.{c}, excluded.{c})")
            }
            ("known_profiles", "source_profile_id") => {
                "source_profile_id = COALESCE(NULLIF(known_profiles.source_profile_id, ''), excluded.source_profile_id)".to_owned()
            }
            ("profile_photo_history", "first_seen_at") => {
                "first_seen_at = MIN(profile_photo_history.first_seen_at, excluded.first_seen_at)".to_owned()
            }
            ("profile_photo_history", "last_seen_at") => {
                "last_seen_at = MAX(profile_photo_history.last_seen_at, excluded.last_seen_at)".to_owned()
            }
            ("profile_photo_history", "source_profile_id") => {
                "source_profile_id = COALESCE(NULLIF(profile_photo_history.source_profile_id, ''), excluded.source_profile_id)".to_owned()
            }
            ("conversations", "source_owner_id") | ("messages", "source_owner_id") => {
                format!("{c} = COALESCE(NULLIF({t}.{c}, ''), excluded.{c})")
            }
            ("profile_snapshots", "data") => {
                "data = CASE WHEN excluded.updated_at >= profile_snapshots.updated_at THEN excluded.data ELSE profile_snapshots.data END".to_owned()
            }
            ("profile_snapshots", "updated_at") => {
                "updated_at = MAX(profile_snapshots.updated_at, excluded.updated_at)".to_owned()
            }
            ("block_events", "display_name" | "avatar_media_hash") => {
                format!("{c} = COALESCE(NULLIF(excluded.{c}, ''), block_events.{c})")
            }
            ("hidden_profiles", "display_name" | "avatar_media_hash") => {
                format!("{c} = COALESCE(NULLIF(excluded.{c}, ''), hidden_profiles.{c})")
            }
            ("hidden_profiles", "hidden_at") => {
                "hidden_at = MAX(hidden_profiles.hidden_at, excluded.hidden_at)".to_owned()
            }
            ("drawer_media_usage", "send_count" | "updated_at") => {
                format!("{c} = MAX(drawer_media_usage.{c}, excluded.{c})")
            }
            ("downloaded_media", "saved_at") => {
                "saved_at = MAX(downloaded_media.saved_at, excluded.saved_at)".to_owned()
            }
            ("settings", "value") => {
                "value = CASE WHEN settings.key = 'locationPreferences' AND settings.value IS NOT NULL AND settings.value != '' THEN settings.value ELSE excluded.value END".to_owned()
            }
            (_, col) if table.blob_columns.contains(&col) => {
                format!("{col} = COALESCE(NULLIF(excluded.{col}, ''), {t}.{col})")
            }
            _ => format!("{c} = excluded.{c}"),
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "INSERT INTO {t} ({cols_csv}) VALUES ({placeholders}) ON CONFLICT({}) DO UPDATE SET {update_set}",
        table.primary_key
    )
}

fn remap_conversation_id(
    old_conv_id: &str,
    partner_to_conv_id: &HashMap<String, String>,
    explicit_other: Option<&str>,
    old_owner: i64,
    new_owner: i64,
) -> String {
    if old_owner == new_owner {
        return old_conv_id.to_owned();
    }
    if let Some(other) = explicit_other.filter(|s| !s.is_empty()) {
        if let Some(existing) = partner_to_conv_id.get(other) {
            return existing.clone();
        }
    }

    let old_owner_str = old_owner.to_string();
    let new_owner_str = new_owner.to_string();
    let mut parts = old_conv_id.split(':');
    if let (Some(p1), Some(p2), None) = (parts.next(), parts.next(), parts.next()) {
        let partner = if p1 == old_owner_str {
            Some(p2)
        } else if p2 == old_owner_str {
            Some(p1)
        } else {
            None
        };
        if let Some(partner_str) = partner {
            if let Some(existing) = partner_to_conv_id.get(partner_str) {
                return existing.clone();
            }
            if let (Ok(partner_num), Ok(owner_num)) =
                (partner_str.parse::<u64>(), new_owner_str.parse::<u64>())
            {
                let (lo, hi) = if owner_num <= partner_num {
                    (owner_num, partner_num)
                } else {
                    (partner_num, owner_num)
                };
                return format!("{lo}:{hi}");
            }
            return if p1 == old_owner_str {
                format!("{new_owner_str}:{partner_str}")
            } else {
                format!("{partner_str}:{new_owner_str}")
            };
        }
    }

    old_conv_id.to_owned()
}

fn remap_json_value(
    value: &mut Value,
    old_owner: i64,
    new_owner: i64,
    old_conv_id: Option<&str>,
    new_conv_id: Option<&str>,
) {
    match value {
        Value::Array(items) => {
            for item in items {
                remap_json_value(item, old_owner, new_owner, old_conv_id, new_conv_id);
            }
        }
        Value::Object(map) => {
            let old_owner_str = old_owner.to_string();
            let new_owner_str = new_owner.to_string();
            for (key, val) in map.iter_mut() {
                match key.as_str() {
                    "profileId" | "senderId" => {
                        if val.as_i64() == Some(old_owner) {
                            *val = json!(new_owner);
                        } else if val.as_str() == Some(old_owner_str.as_str()) {
                            *val = Value::String(new_owner_str.clone());
                        }
                    }
                    "conversationId" => {
                        if let (Some(old_c), Some(new_c)) = (old_conv_id, new_conv_id) {
                            if val.as_str() == Some(old_c) {
                                *val = Value::String(new_c.to_owned());
                            }
                        }
                    }
                    _ => remap_json_value(val, old_owner, new_owner, old_conv_id, new_conv_id),
                }
            }
        }
        _ => {}
    }
}

fn remap_json_string_field(
    row_map: &mut Map<String, Value>,
    field: &str,
    old_owner: i64,
    new_owner: i64,
    old_conv_id: Option<&str>,
    new_conv_id: Option<&str>,
) {
    let Some(Value::String(raw)) = row_map.get(field) else {
        return;
    };
    let Ok(mut parsed) = serde_json::from_str::<Value>(raw) else {
        return;
    };
    remap_json_value(&mut parsed, old_owner, new_owner, old_conv_id, new_conv_id);
    row_map.insert(field.to_string(), Value::String(parsed.to_string()));
}

fn remap_row_for_combine(
    table_name: &str,
    row_map: &mut Map<String, Value>,
    manifest_owner: i64,
    owner_user_id: i64,
    conv_id_map: &mut HashMap<String, String>,
    partner_to_conv_id: &HashMap<String, String>,
) {
    if manifest_owner == owner_user_id {
        return;
    }

    let old_conv = row_map
        .get("conversation_id")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let resolve_conv = |old_c: &str, explicit_other: Option<&str>| -> String {
        conv_id_map.get(old_c).cloned().unwrap_or_else(|| {
            remap_conversation_id(
                old_c,
                partner_to_conv_id,
                explicit_other,
                manifest_owner,
                owner_user_id,
            )
        })
    };

    match table_name {
        "conversations" => {
            if let Some(ref old_c) = old_conv {
                let explicit_other = row_map
                    .get("other_profile_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let new_c = resolve_conv(old_c, explicit_other.as_deref());
                conv_id_map.insert(old_c.clone(), new_c.clone());
                row_map.insert("conversation_id".to_string(), Value::String(new_c.clone()));
                remap_json_string_field(
                    row_map,
                    "participants_json",
                    manifest_owner,
                    owner_user_id,
                    Some(old_c),
                    Some(&new_c),
                );
                remap_json_string_field(
                    row_map,
                    "preview_json",
                    manifest_owner,
                    owner_user_id,
                    Some(old_c),
                    Some(&new_c),
                );
            }
        }
        "conversation_meta" | "media_files" | "sexual_health_encounters" | "block_events" => {
            if let Some(ref old_c) = old_conv {
                let new_c = resolve_conv(old_c, None);
                row_map.insert("conversation_id".to_string(), Value::String(new_c));
            }
        }
        "messages" => {
            let new_c = old_conv.as_deref().map(|old_c| {
                let mapped = resolve_conv(old_c, None);
                row_map.insert("conversation_id".to_string(), Value::String(mapped.clone()));
                mapped
            });

            if let Some(sender_val) = row_map.get("sender_id") {
                if sender_val.as_i64() == Some(manifest_owner) {
                    row_map.insert("sender_id".to_string(), json!(owner_user_id));
                } else if sender_val.as_str() == Some(manifest_owner.to_string().as_str()) {
                    row_map.insert(
                        "sender_id".to_string(),
                        Value::String(owner_user_id.to_string()),
                    );
                }
            }

            if let (Some(old_c), Some(new_c_str)) = (old_conv.as_deref(), new_c.as_deref()) {
                if new_c_str != old_c {
                    if let Some(Value::String(msg_id)) = row_map.get("message_id") {
                        if msg_id.starts_with("local-system:") && msg_id.contains(old_c) {
                            let updated_id = msg_id.replace(old_c, new_c_str);
                            row_map.insert("message_id".to_string(), Value::String(updated_id));
                        }
                    }
                }
            }

            remap_json_string_field(
                row_map,
                "body_json",
                manifest_owner,
                owner_user_id,
                old_conv.as_deref(),
                new_c.as_deref(),
            );
            remap_json_string_field(
                row_map,
                "reply_preview_json",
                manifest_owner,
                owner_user_id,
                old_conv.as_deref(),
                new_c.as_deref(),
            );
        }
        "albums" => {
            let old_owner_str = manifest_owner.to_string();
            let new_owner_str = owner_user_id.to_string();
            if let Some(owner_val) = row_map.get("owner_profile_id") {
                if owner_val.as_str() == Some(old_owner_str.as_str())
                    || owner_val.as_i64() == Some(manifest_owner)
                {
                    row_map.insert(
                        "owner_profile_id".to_string(),
                        Value::String(new_owner_str),
                    );
                }
            }
            if let Some(ref old_c) = old_conv {
                let new_c = resolve_conv(old_c, None);
                row_map.insert("conversation_id".to_string(), Value::String(new_c));
            }
        }
        _ => {}
    }
}

fn load_existing_partner_map(conn: &Connection) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Ok(mut stmt) = conn.prepare(
        "SELECT other_profile_id, conversation_id FROM conversations WHERE other_profile_id IS NOT NULL",
    ) else {
        return map;
    };
    let Ok(mut rows) = stmt.query([]) else {
        return map;
    };
    while let Ok(Some(row)) = rows.next() {
        if let (Ok(other_id), Ok(conv_id)) = (row.get::<_, String>(0), row.get::<_, String>(1)) {
            if !other_id.is_empty() && !conv_id.is_empty() {
                map.insert(other_id, conv_id);
            }
        }
    }
    map
}

fn table_exists(conn: &Connection, table_name: &str) -> Result<bool, AppError> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table_name],
        |r| r.get(0),
    )?;
    Ok(count > 0)
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn validate_table_name(conn: &Connection, table_name: &str) -> Result<String, AppError> {
    let exact: Option<String> = conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table_name],
            |r| r.get(0),
        )
        .ok();
    exact.ok_or_else(|| AppError::Backup(format!("table '{table_name}' does not exist")))
}

fn table_columns(conn: &Connection, table_name: &str) -> Result<Vec<String>, AppError> {
    let sql = format!("PRAGMA table_info({})", quote_ident(table_name));
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query([])?;
    let mut cols = Vec::new();
    while let Some(row) = rows.next()? {
        let col_name: String = row.get(1)?;
        cols.push(col_name);
    }
    Ok(cols)
}

fn add_column_if_missing(
    conn: &Connection,
    table_name: &str,
    column_name: &str,
    column_def: &str,
) -> Result<(), AppError> {
    if !table_exists(conn, table_name)? {
        return Ok(());
    }
    let cols = table_columns(conn, table_name)?;
    if cols.iter().any(|c| c == column_name) {
        return Ok(());
    }
    let sql = format!(
        "ALTER TABLE {} ADD COLUMN {} {column_def}",
        quote_ident(table_name),
        quote_ident(column_name)
    );
    conn.execute_batch(&sql)?;
    Ok(())
}

fn ensure_optional_directory_tables(conn: &Connection) -> Result<(), AppError> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS known_profiles (
            profile_id TEXT PRIMARY KEY,
            display_name TEXT,
            primary_image_hash TEXT,
            is_favorite INTEGER NOT NULL DEFAULT 0,
            source_profile_id TEXT,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS profile_photo_history (
            id TEXT PRIMARY KEY,
            profile_id TEXT NOT NULL,
            image_hash TEXT NOT NULL,
            first_seen_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL,
            source_profile_id TEXT
        );
        CREATE TABLE IF NOT EXISTS profile_snapshots (
            profile_id TEXT PRIMARY KEY,
            data TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS block_events (
            id TEXT PRIMARY KEY,
            profile_id TEXT,
            conversation_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            display_name TEXT,
            avatar_media_hash TEXT,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS hidden_profiles (
            profile_id TEXT PRIMARY KEY,
            display_name TEXT,
            avatar_media_hash TEXT,
            hidden_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS downloaded_media (
            identifier TEXT PRIMARY KEY,
            platform TEXT NOT NULL,
            album_id TEXT,
            byte_size INTEGER NOT NULL,
            mime_type TEXT,
            kind TEXT,
            saved_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS drawer_media_usage (
            media_id INTEGER PRIMARY KEY,
            send_count INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS data_pull_log (
            id TEXT PRIMARY KEY,
            source_owner_id TEXT,
            target_owner_id TEXT,
            source_format TEXT NOT NULL,
            source_label TEXT,
            categories_json TEXT NOT NULL,
            tables_json TEXT NOT NULL,
            rows_imported INTEGER NOT NULL,
            pulled_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS account_profile_favorites (
            account_id TEXT NOT NULL,
            profile_id TEXT NOT NULL,
            updated_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (account_id, profile_id)
        );
        CREATE INDEX IF NOT EXISTS idx_account_profile_favorites_profile
            ON account_profile_favorites(profile_id);
        "#,
    )?;
    add_column_if_missing(conn, "conversations", "source_owner_id", "TEXT")?;
    add_column_if_missing(conn, "messages", "source_owner_id", "TEXT")?;
    add_column_if_missing(conn, "known_profiles", "source_profile_id", "TEXT")?;
    add_column_if_missing(conn, "profile_photo_history", "source_profile_id", "TEXT")?;
    Ok(())
}

fn stamp_provenance_for_row(table_name: &str, row_map: &mut Map<String, Value>, source_owner: i64) {
    let source_str = source_owner.to_string();
    let col = match table_name {
        "conversations" | "messages" => "source_owner_id",
        "known_profiles" | "profile_photo_history" => "source_profile_id",
        _ => return,
    };
    let is_empty = match row_map.get(col) {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => s.trim().is_empty(),
        _ => false,
    };
    if is_empty {
        row_map.insert(col.to_string(), Value::String(source_str));
    }
}

fn is_sqlite_file(path: &Path) -> bool {
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let mut header = [0u8; 16];
    let Ok(read) = file.read(&mut header) else {
        return false;
    };
    read == 16 && &header == SQLITE_HEADER
}

fn parse_owner_from_file_name(path: &Path) -> Option<i64> {
    let stem = path.file_stem()?.to_str()?;
    let rest = stem.strip_prefix("chat-")?;
    if rest.is_empty() || !rest.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    rest.parse::<i64>().ok()
}

fn infer_sqlite_owner(conn: &Connection, path: &Path) -> Option<i64> {
    if let Some(id) = parse_owner_from_file_name(path) {
        return Some(id);
    }
    if table_exists(conn, "conversations").unwrap_or(false) {
        if let Ok(mut stmt) = conn.prepare(
            "SELECT conversation_id, other_profile_id FROM conversations WHERE other_profile_id IS NOT NULL LIMIT 25",
        ) {
            if let Ok(mut rows) = stmt.query([]) {
                while let Ok(Some(row)) = rows.next() {
                    let conv: String = row.get(0).unwrap_or_default();
                    let other: String = row.get(1).unwrap_or_default();
                    if let Some((a, b)) = conv.split_once(':') {
                        if a == other && b != other {
                            if let Ok(parsed) = b.parse::<i64>() {
                                return Some(parsed);
                            }
                        } else if b == other && a != other {
                            if let Ok(parsed) = a.parse::<i64>() {
                                return Some(parsed);
                            }
                        }
                    }
                }
            }
        }
        let cols = table_columns(conn, "conversations").unwrap_or_default();
        if cols.iter().any(|c| c == "source_owner_id") {
            if let Ok(Some(raw)) = conn.query_row(
                "SELECT source_owner_id FROM conversations WHERE source_owner_id IS NOT NULL AND source_owner_id != '' LIMIT 1",
                [],
                |r| r.get::<_, Option<String>>(0),
            ) {
                if let Ok(parsed) = raw.trim().parse::<i64>() {
                    return Some(parsed);
                }
            }
        }
    }
    if table_exists(conn, "albums").unwrap_or(false) {
        if let Ok(Some(raw)) = conn.query_row(
            "SELECT owner_profile_id FROM albums WHERE owner_profile_id IS NOT NULL AND owner_profile_id != '' LIMIT 1",
            [],
            |r| r.get::<_, Option<String>>(0),
        ) {
            if let Ok(parsed) = raw.trim().parse::<i64>() {
                return Some(parsed);
            }
        }
    }
    if table_exists(conn, "known_profiles").unwrap_or(false) {
        let cols = table_columns(conn, "known_profiles").unwrap_or_default();
        if cols.iter().any(|c| c == "source_profile_id") {
            if let Ok(Some(raw)) = conn.query_row(
                "SELECT source_profile_id FROM known_profiles WHERE source_profile_id IS NOT NULL AND source_profile_id != '' LIMIT 1",
                [],
                |r| r.get::<_, Option<String>>(0),
            ) {
                if let Ok(parsed) = raw.trim().parse::<i64>() {
                    return Some(parsed);
                }
            }
        }
    }
    None
}

fn select_tables_for_operation(
    categories: &[String],
    tables: Option<&[String]>,
) -> Vec<&'static TableSpec> {
    if let Some(explicit) = tables {
        let set: HashSet<&str> = explicit.iter().map(String::as_str).collect();
        EXPORT_TABLES
            .iter()
            .filter(|t| set.contains(t.name))
            .collect()
    } else {
        EXPORT_TABLES
            .iter()
            .filter(|t| categories.iter().any(|c| c == t.category))
            .collect()
    }
}

fn record_pull_log(
    tx: &rusqlite::Transaction<'_>,
    target_owner_id: i64,
    source_owner_id: Option<i64>,
    source_format: &str,
    source_name: &str,
    categories: &[String],
    imported_tables: &[String],
    rows_imported: u64,
) -> Result<(), AppError> {
    let pulled_at = chrono::Utc::now().timestamp_millis();
    let unique_nanos = chrono::Utc::now()
        .timestamp_nanos_opt()
        .unwrap_or(pulled_at * 1_000_000);
    let id = format!(
        "pull-{unique_nanos}-{}",
        source_owner_id.map_or_else(|| "shared".to_owned(), |v| v.to_string())
    );
    let tables_json = serde_json::to_string(imported_tables)?;
    let categories_json = serde_json::to_string(categories)?;
    tx.execute(
        "INSERT OR REPLACE INTO data_pull_log (id, source_owner_id, target_owner_id, source_format, source_label, categories_json, tables_json, rows_imported, pulled_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![
            id,
            source_owner_id.map(|v| v.to_string()),
            target_owner_id.to_string(),
            source_format,
            source_name,
            categories_json,
            tables_json,
            rows_imported as i64,
            pulled_at,
        ],
    )?;
    Ok(())
}

fn decode_blob_base64(raw: &str) -> Result<Vec<u8>, base64::DecodeError> {
    let without_prefix = raw
        .trim()
        .strip_prefix("data:")
        .and_then(|rest| rest.split_once(";base64,").map(|(_, body)| body))
        .unwrap_or(raw);
    let cleaned: String = without_prefix
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect();
    BASE64
        .decode(cleaned.as_bytes())
        .or_else(|_| STANDARD_NO_PAD.decode(cleaned.as_bytes()))
        .or_else(|_| URL_SAFE.decode(cleaned.as_bytes()))
        .or_else(|_| URL_SAFE_NO_PAD.decode(cleaned.as_bytes()))
}

fn export_backup_to_path<F>(
    db_path: &Path,
    owner_user_id: i64,
    dest_path: &Path,
    categories: &[String],
    on_progress: F,
) -> Result<(), AppError>
where
    F: FnMut(ExportProgress<'_>),
{
    export_backup_to_path_with_options(db_path, owner_user_id, dest_path, categories, None, on_progress)
}

fn export_backup_to_path_with_options<F>(
    db_path: &Path,
    owner_user_id: i64,
    dest_path: &Path,
    categories: &[String],
    tables: Option<&[String]>,
    mut on_progress: F,
) -> Result<(), AppError>
where
    F: FnMut(ExportProgress<'_>),
{
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let _ = conn.execute_batch("PRAGMA busy_timeout = 5000;");

    if let Some(parent) = dest_path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }

    let selected_tables = select_tables_for_operation(categories, tables);
    let mut manifest_categories: Vec<String> = Vec::new();
    for table in &selected_tables {
        if !manifest_categories.iter().any(|c| c == table.category) {
            manifest_categories.push(table.category.to_owned());
        }
    }
    if manifest_categories.is_empty() {
        manifest_categories = categories.to_vec();
    }
    let selected_table_names: Vec<&str> = selected_tables.iter().map(|t| t.name).collect();

    let file = File::create(dest_path)?;
    let mut zip = ZipWriter::new(BufWriter::new(file));
    let text_options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let blob_options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);

    zip.start_file("manifest.json", text_options)?;
    let manifest = json!({
        "version": BACKUP_VERSION,
        "exportedAt": chrono::Utc::now().timestamp_millis(),
        "ownerUserId": owner_user_id,
        "categories": manifest_categories,
        "tables": selected_table_names,
    });
    zip.write_all(manifest.to_string().as_bytes())?;

    let mut media_counter: u64 = 0;
    let table_count = selected_tables.len();

    for (table_index, table) in selected_tables.into_iter().enumerate() {
        let entry_name = format!("tables/{}.jsonl", table.name);
        zip.start_file(&entry_name, text_options)?;

        if !table_exists(&conn, table.name)? {
            on_progress(ExportProgress { table: table.name, table_index, table_count, rows_done: 0 });
            continue;
        }

        let existing_cols: HashSet<String> = table_columns(&conn, table.name)?.into_iter().collect();
        let select_cols_csv = table
            .columns
            .iter()
            .map(|c| {
                if existing_cols.contains(*c) {
                    quote_ident(c)
                } else {
                    format!("NULL AS {}", quote_ident(c))
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        let order_col = if existing_cols.contains(table.primary_key) {
            quote_ident(table.primary_key)
        } else {
            "rowid".to_owned()
        };
        let select_sql = format!(
            "SELECT {select_cols_csv} FROM {} ORDER BY {order_col}",
            quote_ident(table.name)
        );
        let mut stmt = conn
            .prepare(&select_sql)
            .map_err(|e| AppError::Backup(format!("failed to query {}: {e}", table.name)))?;
        let mut rows = stmt
            .query([])
            .map_err(|e| AppError::Backup(format!("failed to query {}: {e}", table.name)))?;

        let mut rows_done: u64 = 0;
        while let Some(row) = rows
            .next()
            .map_err(|e| AppError::Backup(format!("failed to read row from {}: {e}", table.name)))?
        {
            let mut obj = Map::new();
            for (col_index, col) in table.columns.iter().copied().enumerate() {
                let is_blob = table.blob_columns.contains(&col);
                if is_blob {
                    let value: Option<String> = row
                        .get(col_index)
                        .map_err(|e| AppError::Backup(format!("failed to read {}.{col}: {e}", table.name)))?;
                    match value {
                        Some(b64_text) => {
                            let bytes = decode_blob_base64(&b64_text).map_err(|e| {
                                AppError::Backup(format!("invalid base64 in {}.{col}: {e}", table.name))
                            })?;
                            let media_path = format!("media/{media_counter}.bin");
                            media_counter += 1;
                            zip.start_file(&media_path, blob_options)?;
                            zip.write_all(&bytes)?;
                            obj.insert(col.to_string(), json!({ "$mediaRef": media_path }));
                        }
                        None => {
                            obj.insert(col.to_string(), Value::Null);
                        }
                    }
                } else {
                    obj.insert(col.to_string(), sql_value_to_json(row, col_index)?);
                }
            }

            if owner_user_id > 0 {
                stamp_provenance_for_row(table.name, &mut obj, owner_user_id);
            }

            zip.write_all(Value::Object(obj).to_string().as_bytes())?;
            zip.write_all(b"\n")?;

            rows_done += 1;
            if rows_done % PROGRESS_EVERY_N_ROWS == 0 {
                on_progress(ExportProgress { table: table.name, table_index, table_count, rows_done });
            }
        }

        on_progress(ExportProgress { table: table.name, table_index, table_count, rows_done });
    }

    zip.finish()?;
    Ok(())
}

fn export_sqlite_db_to_path(
    db_path: &Path,
    owner_user_id: i64,
    dest_path: &Path,
    categories: Option<&[String]>,
    tables: Option<&[String]>,
) -> Result<(), AppError> {
    if let Some(parent) = dest_path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    if dest_path.exists() {
        std::fs::remove_file(dest_path)?;
    }

    // Open source RW briefly only to flush WAL consistently during VACUUM INTO,
    // without modifying any data in the live database.
    let src_conn = Connection::open(db_path)?;
    src_conn.execute_batch("PRAGMA busy_timeout = 5000;")?;
    let dest_str = dest_path
        .to_str()
        .ok_or_else(|| AppError::Backup("destination path is not valid UTF-8".to_owned()))?;
    src_conn
        .execute("VACUUM INTO ?1", [dest_str])
        .map_err(|e| AppError::Backup(format!("failed to snapshot sqlite database: {e}")))?;

    let snap_conn = Connection::open(dest_path)?;
    snap_conn.execute_batch("PRAGMA busy_timeout = 5000;")?;

    if owner_user_id > 0 {
        let owner_str = owner_user_id.to_string();
        for (tbl, col) in [
            ("conversations", "source_owner_id"),
            ("messages", "source_owner_id"),
            ("known_profiles", "source_profile_id"),
            ("profile_photo_history", "source_profile_id"),
        ] {
            if table_exists(&snap_conn, tbl)? {
                add_column_if_missing(&snap_conn, tbl, col, "TEXT")?;
                let sql = format!(
                    "UPDATE {} SET {} = ?1 WHERE {} IS NULL OR {} = ''",
                    quote_ident(tbl),
                    quote_ident(col),
                    quote_ident(col),
                    quote_ident(col)
                );
                let _ = snap_conn.execute(&sql, [&owner_str]);
            }
        }
    }

    let filter_set: Option<HashSet<String>> = if let Some(explicit) = tables {
        Some(explicit.iter().cloned().collect())
    } else if let Some(cats) = categories {
        let all_cats_selected = ALL_CATEGORY_IDS
            .iter()
            .all(|cat| cats.iter().any(|c| c == cat));
        if all_cats_selected {
            None
        } else {
            Some(
                EXPORT_TABLES
                    .iter()
                    .filter(|t| cats.iter().any(|c| c == t.category))
                    .map(|t| t.name.to_owned())
                    .collect(),
            )
        }
    } else {
        None
    };

    if let Some(allowed) = filter_set {
        let mut stmt = snap_conn.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )?;
        let table_names: Vec<String> = stmt
            .query_map([], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);
        for name in table_names {
            if !allowed.contains(&name) {
                let sql = format!("DROP TABLE IF EXISTS {}", quote_ident(&name));
                snap_conn.execute_batch(&sql)?;
            }
        }
        snap_conn.execute_batch("VACUUM;")?;
    }

    Ok(())
}

fn resolve_export_dest_path(app: &AppHandle, dest_path: &str) -> Result<PathBuf, AppError> {
    let candidate = Path::new(dest_path);
    if candidate.is_absolute() {
        return Ok(candidate.to_path_buf());
    }
    let base_dir = if cfg!(target_os = "ios") {
        app.path()
            .document_dir()
            .map_err(|e| AppError::Backup(format!("failed to resolve documents dir: {e}")))?
    } else {
        app.path()
            .download_dir()
            .map_err(|e| AppError::Backup(format!("failed to resolve downloads dir: {e}")))?
    };
    Ok(base_dir.join(candidate))
}

#[tauri::command]
pub fn export_backup_to_file(
    app: AppHandle,
    db_file_name: String,
    owner_user_id: i64,
    dest_path: String,
    categories: Vec<String>,
    tables: Option<Vec<String>>,
) -> Result<(), AppError> {
    let db_path = resolve_db_path(&app, &db_file_name)?;
    let resolved_dest = resolve_export_dest_path(&app, &dest_path)?;
    export_backup_to_path_with_options(
        &db_path,
        owner_user_id,
        &resolved_dest,
        &categories,
        tables.as_deref(),
        |progress| {
            let _ = app.emit(EXPORT_PROGRESS_EVENT, progress);
        },
    )
}

#[tauri::command]
pub fn export_sqlite_db_to_file(
    app: AppHandle,
    db_file_name: String,
    owner_user_id: i64,
    dest_path: String,
    categories: Option<Vec<String>>,
    tables: Option<Vec<String>>,
) -> Result<String, AppError> {
    let db_path = resolve_db_path(&app, &db_file_name)?;
    let resolved_dest = resolve_export_dest_path(&app, &dest_path)?;
    export_sqlite_db_to_path(
        &db_path,
        owner_user_id,
        &resolved_dest,
        categories.as_deref(),
        tables.as_deref(),
    )?;
    Ok(resolved_dest.to_string_lossy().into_owned())
}

fn poll_sqlite_connection(conn: &Connection) -> Result<Vec<PolledTableInfo>, AppError> {
    let mut stmt = conn.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )?;
    let table_names: Vec<String> = stmt
        .query_map([], |r| r.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);

    let mut tables = Vec::with_capacity(table_names.len());
    for name in table_names {
        let count_sql = format!("SELECT COUNT(*) FROM {}", quote_ident(&name));
        let row_count: i64 = conn.query_row(&count_sql, [], |r| r.get(0)).unwrap_or(0);
        let columns = table_columns(conn, &name)?;
        let spec = EXPORT_TABLES.iter().find(|t| t.name == name);
        tables.push(PolledTableInfo {
            name,
            category: spec.map(|s| s.category.to_owned()),
            primary_key: spec.map(|s| s.primary_key.to_owned()),
            row_count: row_count.max(0) as u64,
            columns,
            known_export_table: spec.is_some(),
            has_blobs: spec.map(|s| !s.blob_columns.is_empty()).unwrap_or(false),
        });
    }
    Ok(tables)
}

fn poll_sqlite_at_path(src_path: &Path) -> Result<DatabasePollResult, AppError> {
    let conn = Connection::open_with_flags(src_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let _ = conn.execute_batch("PRAGMA busy_timeout = 5000;");
    let tables = poll_sqlite_connection(&conn)?;
    let owner_user_id = infer_sqlite_owner(&conn, src_path);
    let source_name = src_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("database.sqlite3")
        .to_owned();
    Ok(DatabasePollResult {
        ok: true,
        source_kind: "sqlite".to_owned(),
        source_name,
        owner_user_id,
        tables,
        error: None,
    })
}

fn poll_zip_at_path(src_path: &Path) -> Result<DatabasePollResult, AppError> {
    let file = File::open(src_path)?;
    let mut archive = ZipArchive::new(BufReader::new(file))?;
    let source_name = src_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("backup.zip")
        .to_owned();

    let manifest_owner = match read_and_validate_manifest(&mut archive)? {
        ManifestCheck::Invalid(err) => {
            return Ok(DatabasePollResult {
                ok: false,
                source_kind: "zip".to_owned(),
                source_name,
                owner_user_id: None,
                tables: Vec::new(),
                error: Some(err.to_owned()),
            });
        }
        ManifestCheck::Valid { manifest_owner, .. } => Some(manifest_owner),
    };

    let mut entry_names: Vec<String> = Vec::new();
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index(i) {
            let name = entry.name().to_owned();
            if name.starts_with("tables/") && name.ends_with(".jsonl") {
                entry_names.push(name);
            }
        }
    }
    entry_names.sort();

    let mut tables = Vec::new();
    for entry_name in entry_names {
        let table_name = entry_name
            .trim_start_matches("tables/")
            .trim_end_matches(".jsonl")
            .to_owned();
        let mut row_count: u64 = 0;
        let mut first_row_cols: Vec<String> = Vec::new();
        if let Ok(entry) = archive.by_name(&entry_name) {
            for line_res in BufReader::new(entry).lines() {
                if let Ok(line) = line_res {
                    if line.trim().is_empty() {
                        continue;
                    }
                    row_count += 1;
                    if first_row_cols.is_empty() {
                        if let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(&line) {
                            first_row_cols = obj.keys().cloned().collect();
                        }
                    }
                }
            }
        }
        let spec = EXPORT_TABLES.iter().find(|t| t.name == table_name);
        let columns = if !first_row_cols.is_empty() {
            first_row_cols
        } else if let Some(s) = spec {
            s.columns.iter().map(|c| (*c).to_owned()).collect()
        } else {
            Vec::new()
        };
        tables.push(PolledTableInfo {
            name: table_name,
            category: spec.map(|s| s.category.to_owned()),
            primary_key: spec.map(|s| s.primary_key.to_owned()),
            row_count,
            columns,
            known_export_table: spec.is_some(),
            has_blobs: spec.map(|s| !s.blob_columns.is_empty()).unwrap_or(false),
        });
    }

    Ok(DatabasePollResult {
        ok: true,
        source_kind: "zip".to_owned(),
        source_name,
        owner_user_id: manifest_owner,
        tables,
        error: None,
    })
}

#[tauri::command]
pub fn poll_database_tables(
    app: AppHandle,
    db_file_name: Option<String>,
    src_path: Option<String>,
) -> Result<DatabasePollResult, AppError> {
    if let Some(raw_path) = src_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let path = Path::new(raw_path);
        if is_sqlite_file(path) {
            return poll_sqlite_at_path(path);
        }
        return poll_zip_at_path(path);
    }
    let db_name = db_file_name.unwrap_or_else(|| "chat.sqlite3".to_owned());
    let db_path = resolve_db_path(&app, &db_name)?;
    poll_sqlite_at_path(&db_path)
}

#[tauri::command]
pub fn list_local_databases(app: AppHandle) -> Result<Vec<LocalDatabaseEntry>, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Backup(format!("failed to resolve app data dir: {e}")))?;
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    for item in std::fs::read_dir(&dir)? {
        let Ok(entry) = item else {
            continue;
        };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(file_name) = path.file_name().and_then(|s| s.to_str()).map(str::to_owned) else {
            continue;
        };
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        if !matches!(ext.as_str(), "sqlite" | "sqlite3" | "db") {
            continue;
        }
        let meta = std::fs::metadata(&path)?;
        let modified_at = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64);
        let owner_user_id = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .ok()
            .and_then(|conn| infer_sqlite_owner(&conn, &path));
        let kind = if file_name == "master.sqlite3" {
            "master".to_owned()
        } else if file_name.starts_with("chat-") && owner_user_id.is_some() {
            "account".to_owned()
        } else if file_name == "chat.sqlite3" {
            "default".to_owned()
        } else {
            "shared".to_owned()
        };
        entries.push(LocalDatabaseEntry {
            file_name,
            path: path.to_string_lossy().into_owned(),
            size_bytes: meta.len(),
            modified_at,
            owner_user_id,
            kind,
        });
    }

    entries.sort_by(|a, b| a.file_name.cmp(&b.file_name));
    Ok(entries)
}

fn sanitize_preview_value(val: Value) -> Value {
    match val {
        Value::String(s) if s.len() > 260 => {
            let preview: String = s.chars().take(120).collect();
            Value::String(format!("{preview}... [{} chars]", s.len()))
        }
        other => other,
    }
}

fn preview_sqlite_table_at_path(
    src_path: &Path,
    table_name: &str,
    limit: u32,
    offset: u32,
) -> Result<TablePreviewResult, AppError> {
    let conn = Connection::open_with_flags(src_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let _ = conn.execute_batch("PRAGMA busy_timeout = 5000;");
    let validated = validate_table_name(&conn, table_name)?;
    let columns = table_columns(&conn, &validated)?;
    let quoted_tbl = quote_ident(&validated);
    let total_rows: i64 = conn
        .query_row(&format!("SELECT COUNT(*) FROM {quoted_tbl}"), [], |r| r.get(0))
        .unwrap_or(0);
    let select_cols = columns
        .iter()
        .map(|c| quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    let query_sql = format!(
        "SELECT {select_cols} FROM {quoted_tbl} ORDER BY rowid DESC LIMIT ?1 OFFSET ?2"
    );
    let mut stmt = conn.prepare(&query_sql)?;
    let mut query_rows = stmt.query(rusqlite::params![limit as i64, offset as i64])?;
    let mut rows = Vec::new();
    while let Some(row) = query_rows.next()? {
        let mut obj = Map::new();
        for (idx, col) in columns.iter().enumerate() {
            let v = sanitize_preview_value(sql_value_to_json(row, idx)?);
            obj.insert(col.clone(), v);
        }
        rows.push(obj);
    }
    Ok(TablePreviewResult {
        ok: true,
        table: validated,
        columns,
        total_rows: total_rows.max(0) as u64,
        rows,
        error: None,
    })
}

fn preview_zip_table_at_path(
    src_path: &Path,
    table_name: &str,
    limit: u32,
    offset: u32,
) -> Result<TablePreviewResult, AppError> {
    let file = File::open(src_path)?;
    let mut archive = ZipArchive::new(BufReader::new(file))?;
    let entry_name = format!("tables/{table_name}.jsonl");
    let entry = archive
        .by_name(&entry_name)
        .map_err(|e| AppError::Backup(format!("table '{table_name}' not found in archive: {e}")))?;

    let mut total_rows: u64 = 0;
    let mut rows: Vec<Map<String, Value>> = Vec::new();
    let mut columns: Vec<String> = Vec::new();
    let start = offset as u64;
    let end = start + limit as u64;

    for line_res in BufReader::new(entry).lines() {
        let line = line_res?;
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(&line) {
            if columns.is_empty() {
                columns = obj.keys().cloned().collect();
            }
            if total_rows >= start && total_rows < end {
                let sanitized = obj
                    .into_iter()
                    .map(|(k, v)| (k, sanitize_preview_value(v)))
                    .collect();
                rows.push(sanitized);
            }
            total_rows += 1;
        }
    }

    Ok(TablePreviewResult {
        ok: true,
        table: table_name.to_owned(),
        columns,
        total_rows,
        rows,
        error: None,
    })
}

#[tauri::command]
pub fn preview_table_rows(
    app: AppHandle,
    db_file_name: Option<String>,
    src_path: Option<String>,
    table_name: String,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<TablePreviewResult, AppError> {
    let clamped_limit = limit.unwrap_or(50).clamp(1, 200);
    let safe_offset = offset.unwrap_or(0);
    if let Some(raw_path) = src_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let path = Path::new(raw_path);
        if is_sqlite_file(path) {
            return preview_sqlite_table_at_path(path, &table_name, clamped_limit, safe_offset);
        }
        return preview_zip_table_at_path(path, &table_name, clamped_limit, safe_offset);
    }
    let db_name = db_file_name.unwrap_or_else(|| "chat.sqlite3".to_owned());
    let db_path = resolve_db_path(&app, &db_name)?;
    preview_sqlite_table_at_path(&db_path, &table_name, clamped_limit, safe_offset)
}

fn inspect_backup_at_path(src_path: &Path, owner_user_id: i64) -> Result<BackupInspection, AppError> {
    if is_sqlite_file(src_path) {
        let polled = poll_sqlite_at_path(src_path)?;
        let mut categories: Vec<String> = Vec::new();
        let mut tables: Vec<String> = Vec::new();
        for tbl in &polled.tables {
            if tbl.row_count > 0 || tbl.known_export_table {
                tables.push(tbl.name.clone());
            }
            if let Some(ref cat) = tbl.category {
                if tbl.row_count > 0 && !categories.iter().any(|c| c == cat) {
                    categories.push(cat.clone());
                }
            }
        }
        if categories.is_empty() {
            categories = ALL_CATEGORY_IDS.iter().map(|s| (*s).to_owned()).collect();
        }
        let modified_at = std::fs::metadata(src_path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64);
        let is_different = polled.owner_user_id.map(|o| o != owner_user_id);
        return Ok(BackupInspection {
            ok: true,
            categories: Some(categories),
            tables: Some(tables),
            source_format: Some("sqlite".to_owned()),
            exported_at: modified_at,
            owner_user_id: polled.owner_user_id,
            is_different_owner: is_different,
            error: None,
        });
    }

    let file = File::open(src_path)?;
    let mut archive = ZipArchive::new(BufReader::new(file))?;

    let mut tables = Vec::new();
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index(i) {
            let name = entry.name();
            if name.starts_with("tables/") && name.ends_with(".jsonl") {
                tables.push(
                    name.trim_start_matches("tables/")
                        .trim_end_matches(".jsonl")
                        .to_owned(),
                );
            }
        }
    }
    tables.sort();

    Ok(match read_and_validate_manifest(&mut archive)? {
        ManifestCheck::Invalid(error) => BackupInspection {
            ok: false,
            categories: None,
            tables: None,
            source_format: Some("zip".to_owned()),
            exported_at: None,
            owner_user_id: None,
            is_different_owner: None,
            error: Some(error),
        },
        ManifestCheck::Valid { categories, exported_at, manifest_owner } => BackupInspection {
            ok: true,
            categories: Some(categories),
            tables: Some(tables),
            source_format: Some("zip".to_owned()),
            exported_at: Some(exported_at),
            owner_user_id: Some(manifest_owner),
            is_different_owner: Some(manifest_owner != owner_user_id),
            error: None,
        },
    })
}

#[tauri::command]
pub fn inspect_backup_file(src_path: String, owner_user_id: i64) -> Result<BackupInspection, AppError> {
    inspect_backup_at_path(Path::new(&src_path), owner_user_id)
}

fn copy_generic_sqlite_table<F>(
    src_conn: &Connection,
    tx: &rusqlite::Transaction<'_>,
    table_name: &str,
    table_index: usize,
    table_count: usize,
    on_progress: &mut F,
) -> Result<u64, AppError>
where
    F: FnMut(ImportProgress<'_>),
{
    if !table_exists(src_conn, table_name)? {
        return Ok(0);
    }

    // Create destination table from source DDL when the user explicitly selects
    // an auxiliary table (such as chat_local_profile_meta) that doesn't yet exist.
    let target_exists: i64 = tx.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table_name],
        |r| r.get(0),
    )?;
    if target_exists == 0 {
        let ddl: Option<String> = src_conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table_name],
                |r| r.get(0),
            )
            .ok();
        if let Some(create_sql) = ddl {
            tx.execute_batch(&create_sql)?;
        } else {
            return Ok(0);
        }
    }

    let src_cols: HashSet<String> = table_columns(src_conn, table_name)?.into_iter().collect();
    let dst_cols: Vec<String> = {
        let sql = format!("PRAGMA table_info({})", quote_ident(table_name));
        let mut stmt = tx.prepare(&sql)?;
        let mut rows = stmt.query([])?;
        let mut cols = Vec::new();
        while let Some(row) = rows.next()? {
            cols.push(row.get::<_, String>(1)?);
        }
        cols
    };

    let shared_cols: Vec<String> = dst_cols
        .into_iter()
        .filter(|c| src_cols.contains(c))
        .collect();
    if shared_cols.is_empty() {
        return Ok(0);
    }

    let cols_csv = shared_cols
        .iter()
        .map(|c| quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    let placeholders = (1..=shared_cols.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    let insert_sql = format!(
        "INSERT OR IGNORE INTO {} ({cols_csv}) VALUES ({placeholders})",
        quote_ident(table_name)
    );
    let select_sql = format!("SELECT {cols_csv} FROM {}", quote_ident(table_name));
    let mut stmt = src_conn.prepare(&select_sql)?;
    let mut rows = stmt.query([])?;

    let mut rows_done: u64 = 0;
    while let Some(row) = rows.next()? {
        let mut params = Vec::with_capacity(shared_cols.len());
        for idx in 0..shared_cols.len() {
            let val = sql_value_to_json(row, idx)?;
            params.push(json_to_rusqlite(&val)?);
        }
        tx.execute(&insert_sql, rusqlite::params_from_iter(params.iter()))?;
        rows_done += 1;
        if rows_done % PROGRESS_EVERY_N_ROWS == 0 {
            on_progress(ImportProgress {
                table: std::borrow::Cow::Borrowed(table_name),
                table_index,
                table_count,
                rows_done,
            });
        }
    }
    Ok(rows_done)
}

fn import_sqlite_from_path<F>(
    db_path: &Path,
    owner_user_id: i64,
    src_path: &Path,
    categories: &[String],
    tables: Option<&[String]>,
    source_label: Option<&str>,
    mut on_progress: F,
) -> Result<ImportOutcome, AppError>
where
    F: FnMut(ImportProgress<'_>),
{
    let src_conn = Connection::open_with_flags(src_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    src_conn.execute_batch("PRAGMA busy_timeout = 5000;")?;

    let detected_owner = infer_sqlite_owner(&src_conn, src_path);
    let manifest_owner = detected_owner.unwrap_or(owner_user_id);

    let selected_specs = select_tables_for_operation(categories, tables);
    let selected_spec_names: HashSet<&str> = selected_specs.iter().map(|t| t.name).collect();
    let extra_tables: Vec<String> = tables
        .map(|list| {
            list.iter()
                .filter(|name| !selected_spec_names.contains(name.as_str()))
                .cloned()
                .collect()
        })
        .unwrap_or_default();

    let mut dst_conn = Connection::open(db_path)?;
    dst_conn.execute_batch("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF;")?;
    ensure_optional_directory_tables(&dst_conn)?;
    let partner_to_conv_id = if manifest_owner != owner_user_id {
        load_existing_partner_map(&dst_conn)
    } else {
        HashMap::new()
    };
    let mut conv_id_map: HashMap<String, String> = HashMap::new();

    let tx = dst_conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

    let mut total_rows_imported: u64 = 0;
    let table_count = selected_specs.len() + extra_tables.len();
    let mut imported_table_names: Vec<String> = Vec::new();

    for (table_index, table) in selected_specs.into_iter().enumerate() {
        if !table_exists(&src_conn, table.name)? {
            on_progress(ImportProgress {
                table: std::borrow::Cow::Borrowed(table.name),
                table_index,
                table_count,
                rows_done: 0,
            });
            continue;
        }

        let existing_cols: HashSet<String> =
            table_columns(&src_conn, table.name)?.into_iter().collect();
        let select_cols_csv = table
            .columns
            .iter()
            .map(|c| {
                if existing_cols.contains(*c) {
                    quote_ident(c)
                } else {
                    format!("NULL AS {}", quote_ident(c))
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        let order_col = if existing_cols.contains(table.primary_key) {
            quote_ident(table.primary_key)
        } else {
            "rowid".to_owned()
        };
        let select_sql = format!(
            "SELECT {select_cols_csv} FROM {} ORDER BY {order_col}",
            quote_ident(table.name)
        );
        let mut stmt = src_conn.prepare(&select_sql)?;
        let mut rows = stmt.query([])?;

        let upsert_sql = build_upsert_sql(table);
        let mut rows_done: u64 = 0;

        while let Some(row) = rows.next()? {
            let mut row_map = Map::new();
            for (col_idx, col) in table.columns.iter().copied().enumerate() {
                row_map.insert(col.to_string(), sql_value_to_json(row, col_idx)?);
            }

            if let Some(src_id) = detected_owner {
                stamp_provenance_for_row(table.name, &mut row_map, src_id);
            }

            remap_row_for_combine(
                table.name,
                &mut row_map,
                manifest_owner,
                owner_user_id,
                &mut conv_id_map,
                &partner_to_conv_id,
            );

            let pk_present = row_map.get(table.primary_key).map(|v| !v.is_null()).unwrap_or(false);
            if !pk_present {
                continue;
            }

            let params = table
                .columns
                .iter()
                .copied()
                .map(|c| json_to_rusqlite(row_map.get(c).unwrap_or(&Value::Null)))
                .collect::<Result<Vec<_>, AppError>>()?;

            tx.execute(&upsert_sql, rusqlite::params_from_iter(params.iter()))?;

            rows_done += 1;
            total_rows_imported += 1;
            if rows_done % PROGRESS_EVERY_N_ROWS == 0 {
                on_progress(ImportProgress {
                    table: std::borrow::Cow::Borrowed(table.name),
                    table_index,
                    table_count,
                    rows_done,
                });
            }
        }

        if rows_done > 0 {
            imported_table_names.push(table.name.to_owned());
        }
        on_progress(ImportProgress {
            table: std::borrow::Cow::Borrowed(table.name),
            table_index,
            table_count,
            rows_done,
        });
    }

    let spec_len = table_count - extra_tables.len();
    for (offset_idx, extra_name) in extra_tables.into_iter().enumerate() {
        let imported = copy_generic_sqlite_table(
            &src_conn,
            &tx,
            &extra_name,
            spec_len + offset_idx,
            table_count,
            &mut on_progress,
        )?;
        if imported > 0 {
            imported_table_names.push(extra_name);
            total_rows_imported += imported;
        }
    }

    let source_name = source_label
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            src_path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("sqlite-db")
                .to_owned()
        });
    record_pull_log(
        &tx,
        owner_user_id,
        detected_owner,
        "sqlite",
        &source_name,
        categories,
        &imported_table_names,
        total_rows_imported,
    )?;

    tx.commit()?;
    Ok(ImportOutcome { ok: true, rows_imported: Some(total_rows_imported), error: None })
}

fn import_backup_from_path<F>(
    db_path: &Path,
    owner_user_id: i64,
    src_path: &Path,
    categories: &[String],
    on_progress: F,
) -> Result<ImportOutcome, AppError>
where
    F: FnMut(ImportProgress<'_>),
{
    import_backup_from_path_with_options(
        db_path,
        owner_user_id,
        src_path,
        categories,
        None,
        None,
        on_progress,
    )
}

fn import_backup_from_path_with_options<F>(
    db_path: &Path,
    owner_user_id: i64,
    src_path: &Path,
    categories: &[String],
    tables: Option<&[String]>,
    source_label: Option<&str>,
    mut on_progress: F,
) -> Result<ImportOutcome, AppError>
where
    F: FnMut(ImportProgress<'_>),
{
    if is_sqlite_file(src_path) {
        return import_sqlite_from_path(
            db_path,
            owner_user_id,
            src_path,
            categories,
            tables,
            source_label,
            on_progress,
        );
    }

    let file = File::open(src_path)?;
    let mut archive = ZipArchive::new(BufReader::new(file))?;

    let manifest_owner = match read_and_validate_manifest(&mut archive)? {
        ManifestCheck::Invalid(error) => {
            return Ok(ImportOutcome { ok: false, rows_imported: None, error: Some(error) });
        }
        ManifestCheck::Valid { manifest_owner, .. } => manifest_owner,
    };

    let selected_tables = select_tables_for_operation(categories, tables);

    let mut conn = Connection::open(db_path)?;
    conn.execute_batch("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF;")?;
    ensure_optional_directory_tables(&conn)?;
    let partner_to_conv_id = if manifest_owner != owner_user_id {
        load_existing_partner_map(&conn)
    } else {
        HashMap::new()
    };
    let mut conv_id_map: HashMap<String, String> = HashMap::new();

    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

    let mut total_rows_imported: u64 = 0;
    let table_count = selected_tables.len();
    let mut imported_table_names: Vec<String> = Vec::new();

    for (table_index, table) in selected_tables.into_iter().enumerate() {
        let entry_name = format!("tables/{}.jsonl", table.name);
        let lines: Vec<String> = match archive.by_name(&entry_name) {
            Ok(entry) => BufReader::new(entry).lines().collect::<std::io::Result<Vec<_>>>()?,
            Err(ZipError::FileNotFound) => Vec::new(),
            Err(e) => return Err(e.into()),
        };

        let upsert_sql = build_upsert_sql(table);
        let mut rows_done: u64 = 0;

        for line in lines {
            if line.trim().is_empty() {
                continue;
            }
            let row_value: Value = serde_json::from_str(&line)
                .map_err(|e| AppError::Backup(format!("corrupt row in {}: {e}", table.name)))?;
            let Value::Object(mut row_map) = row_value else {
                continue;
            };

            stamp_provenance_for_row(table.name, &mut row_map, manifest_owner);

            remap_row_for_combine(
                table.name,
                &mut row_map,
                manifest_owner,
                owner_user_id,
                &mut conv_id_map,
                &partner_to_conv_id,
            );

            let pk_present = row_map.get(table.primary_key).map(|v| !v.is_null()).unwrap_or(false);
            if !pk_present {
                continue;
            }

            for blob_col in table.blob_columns.iter().copied() {
                let resolved = match row_map.get(blob_col) {
                    Some(Value::Object(ref_obj)) => {
                        let media_path = ref_obj.get("$mediaRef").and_then(Value::as_str).ok_or_else(|| {
                            AppError::Backup(format!("missing $mediaRef in {}.{blob_col}", table.name))
                        })?;
                        let mut media_file = archive.by_name(media_path)?;
                        let mut bytes = Vec::new();
                        media_file.read_to_end(&mut bytes)?;
                        Value::String(BASE64.encode(bytes))
                    }
                    Some(Value::Null) | None => Value::Null,
                    Some(_) => {
                        return Err(AppError::Backup(format!(
                            "unexpected value for blob column {}.{blob_col}",
                            table.name
                        )));
                    }
                };
                row_map.insert(blob_col.to_string(), resolved);
            }

            let params = table
                .columns
                .iter()
                .copied()
                .map(|c| json_to_rusqlite(row_map.get(c).unwrap_or(&Value::Null)))
                .collect::<Result<Vec<_>, AppError>>()?;

            tx.execute(&upsert_sql, rusqlite::params_from_iter(params.iter()))?;

            rows_done += 1;
            total_rows_imported += 1;
            if rows_done % PROGRESS_EVERY_N_ROWS == 0 {
                on_progress(ImportProgress {
                    table: std::borrow::Cow::Borrowed(table.name),
                    table_index,
                    table_count,
                    rows_done,
                });
            }
        }

        if rows_done > 0 {
            imported_table_names.push(table.name.to_owned());
        }
        on_progress(ImportProgress {
            table: std::borrow::Cow::Borrowed(table.name),
            table_index,
            table_count,
            rows_done,
        });
    }

    let source_name = source_label
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            src_path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("backup.zip")
                .to_owned()
        });
    record_pull_log(
        &tx,
        owner_user_id,
        Some(manifest_owner),
        "zip",
        &source_name,
        categories,
        &imported_table_names,
        total_rows_imported,
    )?;

    tx.commit()?;

    Ok(ImportOutcome { ok: true, rows_imported: Some(total_rows_imported), error: None })
}

#[tauri::command]
pub fn import_backup_from_file(
    app: AppHandle,
    db_file_name: String,
    owner_user_id: i64,
    src_path: String,
    categories: Vec<String>,
    tables: Option<Vec<String>>,
    source_label: Option<String>,
) -> Result<ImportOutcome, AppError> {
    let db_path = resolve_db_path(&app, &db_file_name)?;
    import_backup_from_path_with_options(
        &db_path,
        owner_user_id,
        Path::new(&src_path),
        &categories,
        tables.as_deref(),
        source_label.as_deref(),
        |progress| {
            let _ = app.emit(IMPORT_PROGRESS_EVENT, progress);
        },
    )
}

fn ensure_master_schema(conn: &Connection) -> Result<(), AppError> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS conversations (
            conversation_id TEXT PRIMARY KEY,
            other_profile_id TEXT,
            name TEXT,
            participants_json TEXT NOT NULL,
            last_activity_timestamp INTEGER,
            unread_count INTEGER NOT NULL DEFAULT 0,
            pinned INTEGER NOT NULL DEFAULT 0,
            muted INTEGER NOT NULL DEFAULT 0,
            favorite INTEGER NOT NULL DEFAULT 0,
            preview_json TEXT,
            archived INTEGER NOT NULL DEFAULT 0,
            archived_reason TEXT,
            archived_at INTEGER,
            hidden INTEGER NOT NULL DEFAULT 0,
            last_seen_in_inbox_at INTEGER,
            source_owner_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS conversation_meta (
            conversation_id TEXT PRIMARY KEY,
            last_read_timestamp INTEGER
        );
        CREATE TABLE IF NOT EXISTS messages (
            message_id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            sender_id INTEGER NOT NULL,
            timestamp INTEGER NOT NULL,
            type TEXT,
            chat1_type TEXT,
            body_json TEXT,
            unsent INTEGER NOT NULL DEFAULT 0,
            local_history INTEGER NOT NULL DEFAULT 0,
            reply_to_message_id TEXT,
            reply_preview_json TEXT,
            reactions_json TEXT,
            source_owner_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS media_files (
            media_key TEXT PRIMARY KEY,
            conversation_id TEXT,
            message_id TEXT,
            kind TEXT NOT NULL,
            mime_type TEXT,
            data_base64 TEXT NOT NULL,
            view_once INTEGER NOT NULL DEFAULT 0,
            size_bytes INTEGER,
            fetch_status TEXT NOT NULL DEFAULT 'ok',
            fetched_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS albums (
            album_id TEXT PRIMARY KEY,
            owner_profile_id TEXT,
            album_name TEXT,
            conversation_id TEXT,
            shared_via_message_id TEXT,
            preview_cover_base64 TEXT,
            preview_cover_mime_type TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS album_media (
            content_id TEXT PRIMARY KEY,
            album_id TEXT NOT NULL,
            content_type TEXT,
            data_base64 TEXT,
            thumb_data_base64 TEXT,
            remaining_views INTEGER,
            is_viewable INTEGER,
            fetched_at INTEGER,
            position INTEGER
        );
        CREATE TABLE IF NOT EXISTS avatars (
            media_hash TEXT PRIMARY KEY,
            data_base64 TEXT NOT NULL,
            mime_type TEXT,
            fetched_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS saved_phrases (
            phrase TEXT PRIMARY KEY,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS saved_locations (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            geohash TEXT NOT NULL,
            lat REAL NOT NULL,
            lon REAL NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sexual_health_prep_doses (
            id TEXT PRIMARY KEY,
            taken_at INTEGER NOT NULL,
            scheme TEXT NOT NULL,
            dose_role TEXT,
            note TEXT,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sexual_health_encounters (
            id TEXT PRIMARY KEY,
            occurred_at INTEGER NOT NULL,
            profile_id TEXT,
            display_name TEXT,
            tags_json TEXT NOT NULL DEFAULT '[]',
            note TEXT,
            conversation_id TEXT,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sexual_health_appointments (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            scheduled_at INTEGER NOT NULL,
            kind TEXT NOT NULL,
            location TEXT,
            note TEXT,
            completed_at INTEGER,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sexual_health_sti_tests (
            id TEXT PRIMARY KEY,
            tested_at INTEGER NOT NULL,
            test_type TEXT NOT NULL,
            result TEXT NOT NULL,
            note TEXT,
            created_at INTEGER NOT NULL
        );
        "#,
    )?;
    ensure_optional_directory_tables(conn)?;
    Ok(())
}

fn sync_master_database_in_dir(dir: &Path) -> Result<ImportOutcome, AppError> {
    let master_path = dir.join("master.sqlite3");
    {
        let master_conn = Connection::open(&master_path)?;
        master_conn.execute_batch("PRAGMA busy_timeout = 5000;")?;
        ensure_master_schema(&master_conn)?;
    }

    let mut source_files: Vec<PathBuf> = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let Ok(item) = entry else {
            continue;
        };
        let path = item.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if (name.starts_with("chat-") || name == "chat.sqlite3") && name.ends_with(".sqlite3") {
            source_files.push(path);
        }
    }
    source_files.sort();

    let master_tables: Vec<String> = vec![
        "conversations".to_owned(),
        "conversation_meta".to_owned(),
        "messages".to_owned(),
        "media_files".to_owned(),
        "albums".to_owned(),
        "album_media".to_owned(),
        "avatars".to_owned(),
        "saved_phrases".to_owned(),
        "saved_locations".to_owned(),
        "block_events".to_owned(),
        "hidden_profiles".to_owned(),
        "profile_snapshots".to_owned(),
        "known_profiles".to_owned(),
        "profile_photo_history".to_owned(),
    ];
    let cats: Vec<String> = vec!["chat_messages".to_owned(), "media_albums".to_owned()];

    let mut total_rows: u64 = 0;
    for src_path in source_files {
        let owner_id = Connection::open_with_flags(&src_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .ok()
            .and_then(|conn| infer_sqlite_owner(&conn, &src_path))
            .unwrap_or(0);
        let outcome = import_sqlite_from_path(
            &master_path,
            owner_id,
            &src_path,
            &cats,
            Some(&master_tables),
            None,
            |_| {},
        )?;
        total_rows += outcome.rows_imported.unwrap_or(0);

        if owner_id > 0 {
            let _ = backfill_account_favorites_if_empty(&master_path, &src_path, owner_id);
        }
    }

    Ok(ImportOutcome {
        ok: true,
        rows_imported: Some(total_rows),
        error: None,
    })
}

fn backfill_account_favorites_if_empty(
    master_path: &Path,
    src_path: &Path,
    owner_id: i64,
) -> Result<(), AppError> {
    let owner_str = owner_id.to_string();
    let master_conn = Connection::open(master_path)?;
    master_conn.execute_batch("PRAGMA busy_timeout = 5000;")?;
    let already_tracked: bool = master_conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM account_profile_favorites WHERE account_id = ?1 LIMIT 1)",
            [&owner_str],
            |r| r.get(0),
        )
        .unwrap_or(false);
    if already_tracked {
        return Ok(());
    }

    let src_conn = Connection::open_with_flags(src_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    src_conn.execute_batch("PRAGMA busy_timeout = 5000;")?;
    let mut favs: Vec<(String, i64)> = Vec::new();
    if table_exists(&src_conn, "known_profiles").unwrap_or(false) {
        let kp_sql = if table_columns(&src_conn, "known_profiles")
            .unwrap_or_default()
            .iter()
            .any(|c| c == "source_profile_id")
        {
            "SELECT profile_id, COALESCE(updated_at, 0) FROM known_profiles WHERE is_favorite = 1 AND profile_id IS NOT NULL AND (source_profile_id IS NULL OR TRIM(source_profile_id) = '' OR source_profile_id = ?1)"
        } else {
            "SELECT profile_id, COALESCE(updated_at, 0) FROM known_profiles WHERE is_favorite = 1 AND profile_id IS NOT NULL"
        };
        if let Ok(mut stmt) = src_conn.prepare(kp_sql) {
            let rows_res = if kp_sql.contains("?1") {
                stmt.query([&owner_str])
            } else {
                stmt.query([])
            };
            if let Ok(mut rows) = rows_res {
                while let Ok(Some(r)) = rows.next() {
                    if let (Ok(pid), Ok(ts)) = (r.get::<_, String>(0), r.get::<_, i64>(1)) {
                        let clean = pid.trim();
                        if !clean.is_empty() {
                            favs.push((clean.to_owned(), ts));
                        }
                    }
                }
            }
        }
    }
    if table_exists(&src_conn, "conversations").unwrap_or(false) {
        let conv_sql = if table_columns(&src_conn, "conversations")
            .unwrap_or_default()
            .iter()
            .any(|c| c == "source_owner_id")
        {
            "SELECT other_profile_id, COALESCE(updated_at, 0) FROM conversations WHERE favorite = 1 AND other_profile_id IS NOT NULL AND (source_owner_id IS NULL OR TRIM(source_owner_id) = '' OR source_owner_id = ?1)"
        } else {
            "SELECT other_profile_id, COALESCE(updated_at, 0) FROM conversations WHERE favorite = 1 AND other_profile_id IS NOT NULL"
        };
        if let Ok(mut stmt) = src_conn.prepare(conv_sql) {
            let rows_res = if conv_sql.contains("?1") {
                stmt.query([&owner_str])
            } else {
                stmt.query([])
            };
            if let Ok(mut rows) = rows_res {
                while let Ok(Some(r)) = rows.next() {
                    if let (Ok(pid), Ok(ts)) = (r.get::<_, String>(0), r.get::<_, i64>(1)) {
                        let clean = pid.trim();
                        if !clean.is_empty() {
                            favs.push((clean.to_owned(), ts));
                        }
                    }
                }
            }
        }
    }
    if favs.is_empty() {
        return Ok(());
    }
    let tx = master_conn.unchecked_transaction()?;
    {
        let mut insert_stmt = tx.prepare(
            "INSERT OR IGNORE INTO account_profile_favorites (account_id, profile_id, updated_at) VALUES (?1, ?2, ?3)",
        )?;
        for (pid, ts) in favs {
            insert_stmt.execute(rusqlite::params![&owner_str, pid, ts])?;
        }
    }
    tx.commit()?;
    Ok(())
}

fn shorten_location_label(raw: Option<&str>) -> Option<String> {
    let trimmed = raw?.trim();
    if trimmed.is_empty() {
        return None;
    }
    let candidate = if !trimmed.contains(',') {
        trimmed
    } else {
        let parts: Vec<&str> = trimmed
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        if parts.is_empty() {
            return None;
        }
        let first_looks_like_street = parts[0].chars().any(|c| c.is_ascii_digit()) || parts[0].chars().count() > 24;
        if first_looks_like_street && parts.len() >= 2 {
            parts[1]
        } else {
            parts[0]
        }
    };
    let mut chars = candidate.chars();
    let short: String = chars.by_ref().take(21).collect();
    if chars.next().is_some() {
        Some(format!("{}…", short.trim_end()))
    } else {
        Some(short)
    }
}

fn extract_readable_message_text(json_str: Option<&str>, msg_type: Option<&str>) -> Option<String> {
    if let Some(raw) = json_str.map(str::trim).filter(|s| !s.is_empty()) {
        if let Ok(val) = serde_json::from_str::<Value>(raw) {
            for key in ["text", "message", "body", "caption"] {
                if let Some(s) = val.get(key).and_then(Value::as_str) {
                    let clean = s.trim();
                    if !clean.is_empty() {
                        return Some(clean.to_owned());
                    }
                }
            }
            if let Some(s) = val.get("body").and_then(|b| b.get("text")).and_then(Value::as_str) {
                let clean = s.trim();
                if !clean.is_empty() {
                    return Some(clean.to_owned());
                }
            }
        }
    }
    match msg_type.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "image" | "photo" => Some("[Photo]".to_owned()),
        "video" => Some("[Video]".to_owned()),
        "audio" | "voice" => Some("[Audio]".to_owned()),
        "album" => Some("[Album]".to_owned()),
        "location" => Some("[Location]".to_owned()),
        "profilephotoreply" | "profile_photo_reply" => Some("[Photo reply]".to_owned()),
        "tap" => Some("[Tap]".to_owned()),
        other if !other.is_empty() => Some(format!("[{other}]")),
        _ => None,
    }
}

fn list_account_db_paths_in_dir(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut result = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return result;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(owner_id) = parse_owner_from_file_name(&path) else {
            continue;
        };
        if path.extension().and_then(|e| e.to_str()) != Some("sqlite3") {
            continue;
        }
        result.push((owner_id.to_string(), path));
    }
    result.sort_by(|a, b| a.0.cmp(&b.0));
    result
}

fn list_account_locations_in_dir(dir: &Path) -> Result<Vec<AccountLocationEntry>, AppError> {
    let mut entries = Vec::new();
    for (profile_id, path) in list_account_db_paths_in_dir(dir) {
        let Ok(conn) = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
            continue;
        };
        let _ = conn.execute_batch("PRAGMA busy_timeout = 3000;");
        let mut geohash: Option<String> = None;
        let mut location_name: Option<String> = None;
        if table_exists(&conn, "settings").unwrap_or(false) {
            if let Ok(raw) = conn.query_row(
                "SELECT value FROM settings WHERE key = 'locationPreferences'",
                [],
                |r| r.get::<_, String>(0),
            ) {
                if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
                    geohash = parsed
                        .get("geohash")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned);
                    location_name = parsed
                        .get("locationName")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned);
                }
            }
        }

        let mut short_location_name: Option<String> = None;
        if let Some(ref gh) = geohash {
            if table_exists(&conn, "saved_locations").unwrap_or(false) {
                if let Ok(saved_name) = conn.query_row(
                    "SELECT name FROM saved_locations WHERE geohash = ?1 AND TRIM(name) != '' ORDER BY created_at DESC LIMIT 1",
                    [gh],
                    |r| r.get::<_, String>(0),
                ) {
                    let clean = saved_name.trim();
                    if !clean.is_empty() {
                        short_location_name = Some(clean.to_owned());
                    }
                }
            }
        }
        if short_location_name.is_none() {
            short_location_name = shorten_location_label(location_name.as_deref());
        }

        entries.push(AccountLocationEntry {
            profile_id,
            location_name,
            short_location_name,
            geohash,
        });
    }
    Ok(entries)
}

#[tauri::command]
pub fn list_account_locations(app: AppHandle) -> Result<Vec<AccountLocationEntry>, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Backup(format!("failed to resolve app data dir: {e}")))?;
    list_account_locations_in_dir(&dir)
}

#[tauri::command]
pub fn global_search_master(
    app: AppHandle,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<GlobalSearchResultItem>, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Backup(format!("failed to resolve app data dir: {e}")))?;

    let master_path = dir.join("master.sqlite3");
    let target_path = if master_path.is_file() {
        master_path
    } else {
        let mut found: Option<PathBuf> = None;
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() {
                    if let Some(name) = p.file_name().and_then(|s| s.to_str()) {
                        if name.starts_with("chat-") && name.ends_with(".sqlite3") {
                            found = Some(p);
                            break;
                        }
                    }
                }
            }
        }
        match found {
            Some(p) => p,
            None => return Ok(Vec::new()),
        }
    };

    let conn = Connection::open_with_flags(&target_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let _ = conn.execute_batch("PRAGMA busy_timeout = 3000;");
    let max_items = limit.unwrap_or(30).clamp(1, 100) as usize;
    let pattern = format!("%{}%", query.trim());
    let mut items: Vec<GlobalSearchResultItem> = Vec::new();

    // 1. known_profiles
    if table_exists(&conn, "known_profiles").unwrap_or(false) {
        let sql = "SELECT profile_id, display_name, updated_at FROM known_profiles WHERE display_name LIKE ?1 OR profile_id LIKE ?1 ORDER BY updated_at DESC LIMIT ?2";
        if let Ok(mut stmt) = conn.prepare(sql) {
            if let Ok(mut rows) = stmt.query(rusqlite::params![pattern, max_items as i64]) {
                while let Ok(Some(r)) = rows.next() {
                    if let (Ok(pid), Ok(name), Ok(ts)) = (
                        r.get::<_, String>(0),
                        r.get::<_, Option<String>>(1),
                        r.get::<_, Option<i64>>(2),
                    ) {
                        items.push(GlobalSearchResultItem {
                            kind: "profile".to_owned(),
                            profile_id: Some(pid.clone()),
                            conversation_id: None,
                            title: name.unwrap_or_else(|| "Unknown Profile".to_owned()),
                            subtitle: Some(format!("Profile ID: {}", pid)),
                            timestamp: ts,
                        });
                    }
                }
            }
        }
    }

    // 2. conversations
    if items.len() < max_items && table_exists(&conn, "conversations").unwrap_or(false) {
        let sql = "SELECT conversation_id, other_profile_id, name, updated_at FROM conversations WHERE name LIKE ?1 OR conversation_id LIKE ?1 OR other_profile_id LIKE ?1 ORDER BY updated_at DESC LIMIT ?2";
        if let Ok(mut stmt) = conn.prepare(sql) {
            let rem = (max_items - items.len()) as i64;
            if let Ok(mut rows) = stmt.query(rusqlite::params![pattern, rem]) {
                while let Ok(Some(r)) = rows.next() {
                    if let (Ok(cid), Ok(other), Ok(name), Ok(ts)) = (
                        r.get::<_, String>(0),
                        r.get::<_, Option<String>>(1),
                        r.get::<_, Option<String>>(2),
                        r.get::<_, Option<i64>>(3),
                    ) {
                        items.push(GlobalSearchResultItem {
                            kind: "conversation".to_owned(),
                            profile_id: other,
                            conversation_id: Some(cid),
                            title: name.unwrap_or_else(|| "Conversation".to_owned()),
                            subtitle: None,
                            timestamp: ts,
                        });
                    }
                }
            }
        }
    }

    // 3. messages
    if items.len() < max_items && table_exists(&conn, "messages").unwrap_or(false) {
        let sql = "SELECT message_id, conversation_id, body_json, timestamp FROM messages WHERE body_json LIKE ?1 ORDER BY timestamp DESC LIMIT ?2";
        if let Ok(mut stmt) = conn.prepare(sql) {
            let rem = (max_items - items.len()) as i64;
            if let Ok(mut rows) = stmt.query(rusqlite::params![pattern, rem]) {
                while let Ok(Some(r)) = rows.next() {
                    if let (Ok(_mid), Ok(cid), Ok(body), Ok(ts)) = (
                        r.get::<_, String>(0),
                        r.get::<_, String>(1),
                        r.get::<_, Option<String>>(2),
                        r.get::<_, i64>(3),
                    ) {
                        let text = extract_readable_message_text(body.as_deref(), None)
                            .unwrap_or_else(|| "Message".to_owned());
                        items.push(GlobalSearchResultItem {
                            kind: "message".to_owned(),
                            profile_id: None,
                            conversation_id: Some(cid),
                            title: text,
                            subtitle: None,
                            timestamp: Some(ts),
                        });
                    }
                }
            }
        }
    }

    // 4. favorite_notes / restored_favorite_profiles
    for tname in ["favorite_notes", "restored_favorite_profiles"] {
        if items.len() < max_items && table_exists(&conn, tname).unwrap_or(false) {
            let sql = format!("SELECT profile_id, notes, updated_at FROM {} WHERE notes LIKE ?1 OR profile_id LIKE ?1 ORDER BY updated_at DESC LIMIT ?2", tname);
            if let Ok(mut stmt) = conn.prepare(&sql) {
                let rem = (max_items - items.len()) as i64;
                if let Ok(mut rows) = stmt.query(rusqlite::params![pattern, rem]) {
                    while let Ok(Some(r)) = rows.next() {
                        if let (Ok(pid), Ok(notes), Ok(ts)) = (
                            r.get::<_, String>(0),
                            r.get::<_, Option<String>>(1),
                            r.get::<_, Option<i64>>(2),
                        ) {
                            items.push(GlobalSearchResultItem {
                                kind: "note".to_owned(),
                                profile_id: Some(pid.clone()),
                                conversation_id: None,
                                title: notes.unwrap_or_else(|| "Note".to_owned()),
                                subtitle: None,
                                timestamp: ts,
                            });
                        }
                    }
                }
            }
        }
    }

    // 5. saved_locations
    if items.len() < max_items && table_exists(&conn, "saved_locations").unwrap_or(false) {
        let sql = "SELECT id, name, geohash, created_at FROM saved_locations WHERE name LIKE ?1 OR geohash LIKE ?1 ORDER BY created_at DESC LIMIT ?2";
        if let Ok(mut stmt) = conn.prepare(sql) {
            let rem = (max_items - items.len()) as i64;
            if let Ok(mut rows) = stmt.query(rusqlite::params![pattern, rem]) {
                while let Ok(Some(r)) = rows.next() {
                    if let (Ok(_id), Ok(name), Ok(gh), Ok(ts)) = (
                        r.get::<_, String>(0),
                        r.get::<_, Option<String>>(1),
                        r.get::<_, Option<String>>(2),
                        r.get::<_, i64>(3),
                    ) {
                        items.push(GlobalSearchResultItem {
                            kind: "location".to_owned(),
                            profile_id: None,
                            conversation_id: None,
                            title: name.unwrap_or_else(|| "Saved Location".to_owned()),
                            subtitle: gh,
                            timestamp: Some(ts),
                        });
                    }
                }
            }
        }
    }

    // 6. albums
    if items.len() < max_items && table_exists(&conn, "albums").unwrap_or(false) {
        let sql = "SELECT album_id, album_name, conversation_id, created_at FROM albums WHERE album_name LIKE ?1 ORDER BY created_at DESC LIMIT ?2";
        if let Ok(mut stmt) = conn.prepare(sql) {
            let rem = (max_items - items.len()) as i64;
            if let Ok(mut rows) = stmt.query(rusqlite::params![pattern, rem]) {
                while let Ok(Some(r)) = rows.next() {
                    if let (Ok(_aid), Ok(aname), Ok(cid), Ok(ts)) = (
                        r.get::<_, String>(0),
                        r.get::<_, Option<String>>(1),
                        r.get::<_, Option<String>>(2),
                        r.get::<_, i64>(3),
                    ) {
                        items.push(GlobalSearchResultItem {
                            kind: "album".to_owned(),
                            profile_id: None,
                            conversation_id: cid,
                            title: aname.unwrap_or_else(|| "Album".to_owned()),
                            subtitle: None,
                            timestamp: Some(ts),
                        });
                    }
                }
            }
        }
    }

    Ok(items)
}

fn get_cross_account_profile_provenance_in_dir(
    dir: &Path,
    profile_ids: &[String],
) -> Result<HashMap<String, ProfileCrossAccountProvenance>, AppError> {
    let clean_ids: Vec<String> = profile_ids
        .iter()
        .map(|id| id.trim())
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let mut out: HashMap<String, ProfileCrossAccountProvenance> = HashMap::new();
    if clean_ids.is_empty() {
        return Ok(out);
    }
    let id_set: HashSet<&str> = clean_ids.iter().map(String::as_str).collect();
    let placeholders = std::iter::repeat("?")
        .take(clean_ids.len())
        .collect::<Vec<_>>()
        .join(",");

    let mut fav_sets: HashMap<String, HashSet<String>> = HashMap::new();
    let mut seeded_accounts: HashSet<String> = HashSet::new();

    let master_path = dir.join("master.sqlite3");
    if master_path.is_file() {
        if let Ok(mconn) = Connection::open_with_flags(&master_path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
            let _ = mconn.execute_batch("PRAGMA busy_timeout = 3000;");
            if table_exists(&mconn, "account_profile_favorites").unwrap_or(false) {
                if let Ok(mut stmt) = mconn.prepare("SELECT DISTINCT account_id FROM account_profile_favorites") {
                    if let Ok(mut rows) = stmt.query([]) {
                        while let Ok(Some(r)) = rows.next() {
                            if let Ok(acc) = r.get::<_, String>(0) {
                                seeded_accounts.insert(acc);
                            }
                        }
                    }
                }
                let q = format!(
                    "SELECT account_id, profile_id FROM account_profile_favorites WHERE profile_id IN ({placeholders})"
                );
                if let Ok(mut stmt) = mconn.prepare(&q) {
                    let params = rusqlite::params_from_iter(clean_ids.iter());
                    if let Ok(mut rows) = stmt.query(params) {
                        while let Ok(Some(r)) = rows.next() {
                            if let (Ok(acc), Ok(pid)) = (r.get::<_, String>(0), r.get::<_, String>(1)) {
                                fav_sets.entry(pid).or_default().insert(acc);
                            }
                        }
                    }
                }
            }
        }
    }

    let mut conv_by_profile: HashMap<String, HashMap<String, ProfileAccountConversation>> = HashMap::new();

    for (account_id, path) in list_account_db_paths_in_dir(dir) {
        let Ok(conn) = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
            continue;
        };
        let _ = conn.execute_batch("PRAGMA busy_timeout = 3000;");

        if !seeded_accounts.contains(&account_id) && table_exists(&conn, "known_profiles").unwrap_or(false) {
            let kp_cols = table_columns(&conn, "known_profiles").unwrap_or_default();
            let q = if kp_cols.iter().any(|c| c == "source_profile_id") {
                format!(
                    "SELECT profile_id FROM known_profiles WHERE is_favorite = 1 AND (source_profile_id IS NULL OR TRIM(source_profile_id) = '' OR source_profile_id = '{account_id}') AND profile_id IN ({placeholders})"
                )
            } else {
                format!(
                    "SELECT profile_id FROM known_profiles WHERE is_favorite = 1 AND profile_id IN ({placeholders})"
                )
            };
            if let Ok(mut stmt) = conn.prepare(&q) {
                let params = rusqlite::params_from_iter(clean_ids.iter());
                if let Ok(mut rows) = stmt.query(params) {
                    while let Ok(Some(r)) = rows.next() {
                        if let Ok(pid) = r.get::<_, String>(0) {
                            fav_sets.entry(pid).or_default().insert(account_id.clone());
                        }
                    }
                }
            }
        }

        if table_exists(&conn, "conversations").unwrap_or(false) {
            let has_messages = table_exists(&conn, "messages").unwrap_or(false);
            let conv_cols = table_columns(&conn, "conversations").unwrap_or_default();
            let owner_filter = if conv_cols.iter().any(|c| c == "source_owner_id") {
                format!(
                    " AND (source_owner_id IS NULL OR TRIM(source_owner_id) = '' OR source_owner_id = '{account_id}')"
                )
            } else {
                String::new()
            };
            let q = format!(
                "SELECT conversation_id, other_profile_id, last_activity_timestamp, COALESCE(unread_count, 0), preview_json, COALESCE(favorite, 0)
                 FROM conversations
                 WHERE other_profile_id IN ({placeholders}){owner_filter}"
            );
            if let Ok(mut stmt) = conn.prepare(&q) {
                let params = rusqlite::params_from_iter(clean_ids.iter());
                if let Ok(mut rows) = stmt.query(params) {
                    while let Ok(Some(r)) = rows.next() {
                        let Ok(conv_id) = r.get::<_, String>(0) else { continue };
                        let Ok(other_id) = r.get::<_, String>(1) else { continue };
                        if !id_set.contains(other_id.as_str()) {
                            continue;
                        }
                        let last_ts: Option<i64> = r.get(2).ok().flatten();
                        let unread_count: i64 = r.get(3).unwrap_or(0);
                        let preview_json: Option<String> = r.get(4).ok().flatten();
                        let conv_fav: i64 = r.get(5).unwrap_or(0);
                        if conv_fav != 0 && !seeded_accounts.contains(&account_id) {
                            fav_sets.entry(other_id.clone()).or_default().insert(account_id.clone());
                        }
                        let msg_count: i64 = if has_messages {
                            conn.query_row(
                                "SELECT COUNT(*) FROM messages WHERE conversation_id = ?1",
                                [&conv_id],
                                |mr| mr.get(0),
                            )
                            .unwrap_or(0)
                        } else {
                            0
                        };
                        let preview = extract_readable_message_text(preview_json.as_deref(), None);
                        conv_by_profile
                            .entry(other_id)
                            .or_default()
                            .insert(
                                account_id.clone(),
                                ProfileAccountConversation {
                                    account_id: account_id.clone(),
                                    conversation_id: conv_id,
                                    last_activity_timestamp: last_ts,
                                    unread_count,
                                    message_count: msg_count,
                                    last_message_preview: preview,
                                },
                            );
                    }
                }
            }
        }
    }

    for pid in clean_ids {
        let mut fav_accounts: Vec<String> = fav_sets
            .remove(&pid)
            .map(|s| s.into_iter().collect())
            .unwrap_or_default();
        fav_accounts.sort();
        let mut conversations: Vec<ProfileAccountConversation> = conv_by_profile
            .remove(&pid)
            .map(|m| m.into_values().collect())
            .unwrap_or_default();
        conversations.sort_by(|a, b| {
            b.last_activity_timestamp
                .unwrap_or(0)
                .cmp(&a.last_activity_timestamp.unwrap_or(0))
                .then_with(|| a.account_id.cmp(&b.account_id))
        });
        if !fav_accounts.is_empty() || !conversations.is_empty() {
            out.insert(
                pid,
                ProfileCrossAccountProvenance {
                    favorite_account_ids: fav_accounts,
                    conversations,
                },
            );
        }
    }

    Ok(out)
}

#[tauri::command]
pub fn get_cross_account_profile_provenance(
    app: AppHandle,
    profile_ids: Vec<String>,
) -> Result<HashMap<String, ProfileCrossAccountProvenance>, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Backup(format!("failed to resolve app data dir: {e}")))?;
    get_cross_account_profile_provenance_in_dir(&dir, &profile_ids)
}

fn read_account_conversation_messages_in_dir(
    dir: &Path,
    account_id: &str,
    conversation_id: &str,
    limit: u32,
) -> Result<Vec<MiniChatMessage>, AppError> {
    let clean_acc = account_id.trim();
    if clean_acc.is_empty() || !clean_acc.chars().all(|c| c.is_ascii_digit()) {
        return Err(AppError::Backup("invalid account_id".to_owned()));
    }
    let clean_conv = conversation_id.trim();
    if clean_conv.is_empty() {
        return Ok(Vec::new());
    }
    let clamped_limit = limit.clamp(1, 100) as i64;

    let account_path = dir.join(format!("chat-{clean_acc}.sqlite3"));
    let master_path = dir.join("master.sqlite3");
    let target_path = if account_path.is_file() {
        account_path
    } else if master_path.is_file() {
        master_path
    } else {
        return Ok(Vec::new());
    };

    let conn = Connection::open_with_flags(&target_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let _ = conn.execute_batch("PRAGMA busy_timeout = 3000;");
    if !table_exists(&conn, "messages").unwrap_or(false) {
        return Ok(Vec::new());
    }

    let mut stmt = conn.prepare(
        "SELECT message_id, conversation_id, sender_id, timestamp, COALESCE(chat1_type, type), body_json, COALESCE(unsent, 0)
         FROM messages
         WHERE conversation_id = ?1
         ORDER BY timestamp DESC
         LIMIT ?2",
    )?;
    let mut rows = stmt.query(rusqlite::params![clean_conv, clamped_limit])?;
    let mut msgs = Vec::new();
    while let Some(r) = rows.next()? {
        let message_id: String = r.get(0)?;
        let conv_id: String = r.get(1)?;
        let sender_id: i64 = r.get(2)?;
        let timestamp: i64 = r.get(3)?;
        let msg_type: Option<String> = r.get(4).ok().flatten();
        let body_json: Option<String> = r.get(5).ok().flatten();
        let unsent: bool = r.get::<_, i64>(6).unwrap_or(0) != 0;
        let text = if unsent {
            None
        } else {
            extract_readable_message_text(body_json.as_deref(), msg_type.as_deref())
        };
        msgs.push(MiniChatMessage {
            message_id,
            conversation_id: conv_id,
            sender_id,
            timestamp,
            msg_type,
            text,
            unsent,
        });
    }
    msgs.reverse();
    Ok(msgs)
}

#[tauri::command]
pub fn read_account_conversation_messages(
    app: AppHandle,
    account_id: String,
    conversation_id: String,
    limit: Option<u32>,
) -> Result<Vec<MiniChatMessage>, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Backup(format!("failed to resolve app data dir: {e}")))?;
    read_account_conversation_messages_in_dir(
        &dir,
        &account_id,
        &conversation_id,
        limit.unwrap_or(40),
    )
}

#[tauri::command]
pub fn sync_master_database(app: AppHandle) -> Result<ImportOutcome, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Backup(format!("failed to resolve app data dir: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    sync_master_database_in_dir(&dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDir(std::path::PathBuf);

    impl TestDir {
        fn new(label: &str) -> Self {
            let unique = format!(
                "fg-backup-test-{label}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            );
            let path = std::env::temp_dir().join(unique);
            std::fs::create_dir_all(&path).expect("create test temp dir");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn init_backup_test_schema(conn: &Connection) {
        conn.execute_batch(
            r#"
            CREATE TABLE conversations (
                conversation_id TEXT PRIMARY KEY,
                other_profile_id TEXT,
                name TEXT,
                participants_json TEXT NOT NULL,
                last_activity_timestamp INTEGER,
                unread_count INTEGER NOT NULL DEFAULT 0,
                pinned INTEGER NOT NULL DEFAULT 0,
                muted INTEGER NOT NULL DEFAULT 0,
                favorite INTEGER NOT NULL DEFAULT 0,
                preview_json TEXT,
                archived INTEGER NOT NULL DEFAULT 0,
                archived_reason TEXT,
                archived_at INTEGER,
                hidden INTEGER NOT NULL DEFAULT 0,
                last_seen_in_inbox_at INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE conversation_meta (
                conversation_id TEXT PRIMARY KEY,
                last_read_timestamp INTEGER
            );
            CREATE TABLE messages (
                message_id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                sender_id INTEGER NOT NULL,
                timestamp INTEGER NOT NULL,
                type TEXT,
                chat1_type TEXT,
                body_json TEXT,
                unsent INTEGER NOT NULL DEFAULT 0,
                local_history INTEGER NOT NULL DEFAULT 0,
                reply_to_message_id TEXT,
                reply_preview_json TEXT,
                reactions_json TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE media_files (
                media_key TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                mime_type TEXT,
                data_base64 TEXT NOT NULL,
                view_once INTEGER NOT NULL DEFAULT 0,
                size_bytes INTEGER NOT NULL DEFAULT 0,
                fetch_status TEXT NOT NULL DEFAULT 'ready',
                fetched_at INTEGER
            );
            CREATE TABLE albums (
                album_id TEXT PRIMARY KEY,
                owner_profile_id TEXT,
                album_name TEXT,
                conversation_id TEXT,
                shared_via_message_id TEXT,
                preview_cover_base64 TEXT,
                preview_cover_mime_type TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE album_media (
                content_id TEXT PRIMARY KEY,
                album_id TEXT NOT NULL,
                content_type TEXT NOT NULL,
                data_base64 TEXT,
                thumb_data_base64 TEXT,
                remaining_views INTEGER,
                is_viewable INTEGER NOT NULL DEFAULT 1,
                fetched_at INTEGER NOT NULL
            );
            CREATE TABLE avatars (
                media_hash TEXT PRIMARY KEY,
                data_base64 TEXT NOT NULL,
                mime_type TEXT,
                fetched_at INTEGER NOT NULL
            );
            CREATE TABLE settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE saved_phrases (
                phrase TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE saved_locations (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                geohash TEXT NOT NULL,
                lat REAL NOT NULL,
                lon REAL NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE sexual_health_prep_doses (
                id TEXT PRIMARY KEY,
                taken_at INTEGER NOT NULL,
                scheme TEXT NOT NULL,
                dose_role TEXT,
                note TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE sexual_health_encounters (
                id TEXT PRIMARY KEY,
                occurred_at INTEGER NOT NULL,
                profile_id TEXT,
                display_name TEXT,
                tags_json TEXT NOT NULL,
                note TEXT,
                conversation_id TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE sexual_health_appointments (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                scheduled_at INTEGER NOT NULL,
                kind TEXT NOT NULL,
                location TEXT,
                note TEXT,
                completed_at INTEGER,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE sexual_health_sti_tests (
                id TEXT PRIMARY KEY,
                tested_at INTEGER NOT NULL,
                test_type TEXT NOT NULL,
                result TEXT NOT NULL,
                note TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE known_profiles (
                profile_id TEXT PRIMARY KEY,
                display_name TEXT,
                primary_image_hash TEXT,
                is_favorite INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE profile_photo_history (
                id TEXT PRIMARY KEY,
                profile_id TEXT NOT NULL,
                image_hash TEXT NOT NULL,
                first_seen_at INTEGER NOT NULL,
                last_seen_at INTEGER NOT NULL
            );
            "#,
        )
        .expect("init test schema");
    }

    #[test]
    fn selective_restore_imports_only_chosen_categories() {
        let dir = TestDir::new("selective");
        let src_db = dir.path().join("src.db");
        let dst_db = dir.path().join("dst.db");
        let zip_path = dir.path().join("backup.zip");

        let src = Connection::open(&src_db).unwrap();
        init_backup_test_schema(&src);
        src.execute(
            "INSERT INTO saved_phrases (phrase, created_at) VALUES ('Hey there', 100)",
            [],
        )
        .unwrap();
        src.execute(
            "INSERT INTO saved_locations (id, name, geohash, lat, lon, created_at) VALUES ('loc1', 'Home', 'u4pruydqqvj', 1.0, 2.0, 100)",
            [],
        )
        .unwrap();
        src.execute(
            "INSERT INTO settings (key, value) VALUES ('theme', '\"dark\"')",
            [],
        )
        .unwrap();

        let all: Vec<String> = ALL_CATEGORY_IDS.iter().map(|s| (*s).to_owned()).collect();
        export_backup_to_path(&src_db, 100, &zip_path, &all, |_| {}).unwrap();

        let dst = Connection::open(&dst_db).unwrap();
        init_backup_test_schema(&dst);
        dst.execute(
            "INSERT INTO settings (key, value) VALUES ('theme', '\"light\"')",
            [],
        )
        .unwrap();

        let outcome = import_backup_from_path(
            &dst_db,
            100,
            &zip_path,
            &["saved_phrases".to_owned()],
            |_| {},
        )
        .unwrap();
        assert!(outcome.ok);
        assert_eq!(outcome.rows_imported, Some(1));

        let phrase_count: i64 = dst
            .query_row("SELECT COUNT(*) FROM saved_phrases", [], |r| r.get(0))
            .unwrap();
        let loc_count: i64 = dst
            .query_row("SELECT COUNT(*) FROM saved_locations", [], |r| r.get(0))
            .unwrap();
        let theme: String = dst
            .query_row("SELECT value FROM settings WHERE key = 'theme'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(phrase_count, 1);
        assert_eq!(loc_count, 0);
        assert_eq!(theme, "\"light\"");
    }

    #[test]
    fn combine_same_account_preserves_newer_metadata_and_merges_rows() {
        let dir = TestDir::new("same-combine");
        let src_db = dir.path().join("src.db");
        let dst_db = dir.path().join("dst.db");
        let zip_path = dir.path().join("older.zip");

        let src = Connection::open(&src_db).unwrap();
        init_backup_test_schema(&src);
        src.execute(
            "INSERT INTO conversations (conversation_id, other_profile_id, name, participants_json, last_activity_timestamp, unread_count, pinned, muted, favorite, preview_json, created_at, updated_at) VALUES ('100:200', '200', 'Alex', '[]', 1000, 0, 0, 0, 1, '{\"text\":\"old\"}', 500, 1000)",
            [],
        )
        .unwrap();
        src.execute(
            "INSERT INTO conversations (conversation_id, other_profile_id, name, participants_json, last_activity_timestamp, unread_count, pinned, muted, favorite, preview_json, created_at, updated_at) VALUES ('100:300', '300', 'Sam', '[]', 900, 1, 0, 0, 0, '{\"text\":\"hi sam\"}', 600, 900)",
            [],
        )
        .unwrap();
        src.execute(
            "INSERT INTO messages (message_id, conversation_id, sender_id, timestamp, created_at, updated_at) VALUES ('m-old', '100:200', 200, 1000, 1000, 1000)",
            [],
        )
        .unwrap();
        src.execute(
            "INSERT INTO saved_phrases (phrase, created_at) VALUES ('Phrase A', 100), ('Phrase B', 200)",
            [],
        )
        .unwrap();

        export_backup_to_path(
            &src_db,
            100,
            &zip_path,
            &["chat_messages".to_owned(), "saved_phrases".to_owned()],
            |_| {},
        )
        .unwrap();

        let dst = Connection::open(&dst_db).unwrap();
        init_backup_test_schema(&dst);
        dst.execute(
            "INSERT INTO conversations (conversation_id, other_profile_id, name, participants_json, last_activity_timestamp, unread_count, pinned, muted, favorite, preview_json, created_at, updated_at) VALUES ('100:200', '200', 'Alex', '[]', 2000, 2, 1, 0, 0, '{\"text\":\"newest\"}', 800, 2000)",
            [],
        )
        .unwrap();
        dst.execute(
            "INSERT INTO messages (message_id, conversation_id, sender_id, timestamp, created_at, updated_at) VALUES ('m-new', '100:200', 100, 2000, 2000, 2000)",
            [],
        )
        .unwrap();
        dst.execute(
            "INSERT INTO saved_phrases (phrase, created_at) VALUES ('Phrase C', 300)",
            [],
        )
        .unwrap();

        let outcome = import_backup_from_path(
            &dst_db,
            100,
            &zip_path,
            &["chat_messages".to_owned(), "saved_phrases".to_owned()],
            |_| {},
        )
        .unwrap();
        assert!(outcome.ok);

        let (last_ts, pinned, favorite, preview, created_at): (i64, i64, i64, String, i64) = dst
            .query_row(
                "SELECT last_activity_timestamp, pinned, favorite, preview_json, created_at FROM conversations WHERE conversation_id = '100:200'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(last_ts, 2000);
        assert_eq!(pinned, 1);
        assert_eq!(favorite, 1);
        assert_eq!(preview, "{\"text\":\"newest\"}");
        assert_eq!(created_at, 500);

        let conv_count: i64 = dst
            .query_row("SELECT COUNT(*) FROM conversations", [], |r| r.get(0))
            .unwrap();
        let msg_count: i64 = dst
            .query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))
            .unwrap();
        let phrase_count: i64 = dst
            .query_row("SELECT COUNT(*) FROM saved_phrases", [], |r| r.get(0))
            .unwrap();
        assert_eq!(conv_count, 2);
        assert_eq!(msg_count, 2);
        assert_eq!(phrase_count, 3);
    }

    #[test]
    fn combine_cross_account_remaps_owner_and_conversations() {
        let dir = TestDir::new("cross-combine");
        let src_db = dir.path().join("src100.db");
        let dst_db = dir.path().join("dst200.db");
        let zip_path = dir.path().join("acct100.zip");

        let src = Connection::open(&src_db).unwrap();
        init_backup_test_schema(&src);
        src.execute(
            "INSERT INTO conversations (conversation_id, other_profile_id, name, participants_json, last_activity_timestamp, preview_json, created_at, updated_at) VALUES ('100:300', '300', 'Sam', '[{\"profileId\":100},{\"profileId\":300}]', 1500, '{\"conversationId\":\"100:300\",\"senderId\":100}', 500, 1500)",
            [],
        )
        .unwrap();
        src.execute(
            "INSERT INTO conversations (conversation_id, other_profile_id, name, participants_json, last_activity_timestamp, preview_json, created_at, updated_at) VALUES ('100:400', '400', 'Pat', '[{\"profileId\":100},{\"profileId\":400}]', 1600, NULL, 600, 1600)",
            [],
        )
        .unwrap();
        src.execute(
            "INSERT INTO messages (message_id, conversation_id, sender_id, timestamp, created_at, updated_at) VALUES ('m-100-out', '100:300', 100, 1400, 1400, 1400), ('m-300-in', '100:300', 300, 1500, 1500, 1500)",
            [],
        )
        .unwrap();
        src.execute(
            "INSERT INTO albums (album_id, owner_profile_id, album_name, conversation_id, created_at, updated_at) VALUES ('alb-1', '100', 'My Pix', '100:300', 100, 100)",
            [],
        )
        .unwrap();

        export_backup_to_path(
            &src_db,
            100,
            &zip_path,
            &["chat_messages".to_owned(), "media_albums".to_owned()],
            |_| {},
        )
        .unwrap();

        let inspection = inspect_backup_at_path(&zip_path, 200).unwrap();
        assert!(inspection.ok);
        assert_eq!(inspection.owner_user_id, Some(100));
        assert_eq!(inspection.is_different_owner, Some(true));

        let dst = Connection::open(&dst_db).unwrap();
        init_backup_test_schema(&dst);
        dst.execute(
            "INSERT INTO conversations (conversation_id, other_profile_id, name, participants_json, last_activity_timestamp, created_at, updated_at) VALUES ('200:300', '300', 'Sam', '[{\"profileId\":200},{\"profileId\":300}]', 1200, 400, 1200)",
            [],
        )
        .unwrap();
        dst.execute(
            "INSERT INTO messages (message_id, conversation_id, sender_id, timestamp, created_at, updated_at) VALUES ('m-existing', '200:300', 200, 1200, 1200, 1200)",
            [],
        )
        .unwrap();

        let outcome = import_backup_from_path(
            &dst_db,
            200,
            &zip_path,
            &["chat_messages".to_owned(), "media_albums".to_owned()],
            |_| {},
        )
        .unwrap();
        assert!(outcome.ok);

        let sam_msgs: i64 = dst
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE conversation_id = '200:300'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let remapped_sender: i64 = dst
            .query_row(
                "SELECT sender_id FROM messages WHERE message_id = 'm-100-out'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let kept_partner_sender: i64 = dst
            .query_row(
                "SELECT sender_id FROM messages WHERE message_id = 'm-300-in'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let pat_conv_exists: i64 = dst
            .query_row(
                "SELECT COUNT(*) FROM conversations WHERE conversation_id = '200:400'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let (album_owner, album_conv): (String, String) = dst
            .query_row(
                "SELECT owner_profile_id, conversation_id FROM albums WHERE album_id = 'alb-1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();

        assert_eq!(sam_msgs, 3);
        assert_eq!(remapped_sender, 200);
        assert_eq!(kept_partner_sender, 300);
        assert_eq!(pat_conv_exists, 1);
        assert_eq!(album_owner, "200");
        assert_eq!(album_conv, "200:300");
    }

    #[test]
    fn combine_merges_known_profiles_and_photo_history() {
        let dir = TestDir::new("known-profiles");
        let src_db = dir.path().join("src.db");
        let dst_db = dir.path().join("dst.db");
        let zip_path = dir.path().join("profiles.zip");

        let src = Connection::open(&src_db).unwrap();
        init_backup_test_schema(&src);
        src.execute(
            "INSERT INTO known_profiles (profile_id, display_name, primary_image_hash, is_favorite, updated_at) VALUES ('555', 'Jordan', 'hash_new', 1, 2000)",
            [],
        )
        .unwrap();
        src.execute(
            "INSERT INTO profile_photo_history (id, profile_id, image_hash, first_seen_at, last_seen_at) VALUES ('555:hash_old', '555', 'hash_old', 500, 1000), ('555:hash_new', '555', 'hash_new', 2000, 2000)",
            [],
        )
        .unwrap();

        export_backup_to_path(
            &src_db,
            100,
            &zip_path,
            &["chat_messages".to_owned(), "media_albums".to_owned()],
            |_| {},
        )
        .unwrap();

        let dst = Connection::open(&dst_db).unwrap();
        init_backup_test_schema(&dst);
        dst.execute(
            "INSERT INTO known_profiles (profile_id, display_name, primary_image_hash, is_favorite, updated_at) VALUES ('555', NULL, 'hash_old', 0, 1000)",
            [],
        )
        .unwrap();
        dst.execute(
            "INSERT INTO profile_photo_history (id, profile_id, image_hash, first_seen_at, last_seen_at) VALUES ('555:hash_old', '555', 'hash_old', 800, 1200)",
            [],
        )
        .unwrap();

        let outcome = import_backup_from_path(
            &dst_db,
            200,
            &zip_path,
            &["chat_messages".to_owned(), "media_albums".to_owned()],
            |_| {},
        )
        .unwrap();
        assert!(outcome.ok);

        let (name, hash, is_fav): (Option<String>, Option<String>, i64) = dst
            .query_row(
                "SELECT display_name, primary_image_hash, is_favorite FROM known_profiles WHERE profile_id = '555'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        let (first_seen, last_seen): (i64, i64) = dst
            .query_row(
                "SELECT first_seen_at, last_seen_at FROM profile_photo_history WHERE id = '555:hash_old'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        let history_count: i64 = dst
            .query_row(
                "SELECT COUNT(*) FROM profile_photo_history WHERE profile_id = '555'",
                [],
                |r| r.get(0),
            )
            .unwrap();

        assert_eq!(name.as_deref(), Some("Jordan"));
        assert_eq!(hash.as_deref(), Some("hash_new"));
        assert_eq!(is_fav, 1);
        assert_eq!(first_seen, 500);
        assert_eq!(last_seen, 1200);
        assert_eq!(history_count, 2);
    }

    #[test]
    fn sqlite_export_poll_preview_and_cross_account_combine_with_provenance() {
        let dir = TestDir::new("sqlite-poll-combine");
        let src_db = dir.path().join("chat-100.sqlite3");
        let snap_db = dir.path().join("snapshot.sqlite3");
        let filtered_db = dir.path().join("filtered.sqlite3");
        let dst_db = dir.path().join("chat-200.sqlite3");

        let src = Connection::open(&src_db).unwrap();
        init_backup_test_schema(&src);
        ensure_optional_directory_tables(&src).unwrap();
        src.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS chat_local_profile_meta (
                profile_id TEXT PRIMARY KEY,
                local_nickname TEXT,
                updated_at INTEGER NOT NULL
            );
            INSERT INTO chat_local_profile_meta (profile_id, local_nickname, updated_at)
            VALUES ('555', 'Gym Buddy', 1700);
            INSERT INTO conversations (
                conversation_id, other_profile_id, name, participants_json,
                last_activity_timestamp, unread_count, pinned, muted, favorite,
                preview_json, archived, archived_reason, archived_at, hidden,
                last_seen_in_inbox_at, created_at, updated_at
            ) VALUES (
                '100:555', '555', 'Jordan', '["100","555"]',
                2000, 0, 0, 0, 1, '{"text":"hey"}', 0, NULL, NULL, 0,
                NULL, 1000, 2000
            );
            INSERT INTO messages (
                message_id, conversation_id, sender_id, timestamp, type,
                chat1_type, body_json, unsent, local_history, reply_to_message_id,
                reply_preview_json, reactions_json, created_at, updated_at
            ) VALUES (
                'msg-sqlite-1', '100:555', 100, 2000, 'text',
                'text', '{"text":"hello from 100"}', 0, 0, NULL,
                NULL, NULL, 2000, 2000
            );
            INSERT INTO known_profiles (profile_id, display_name, primary_image_hash, is_favorite, updated_at)
            VALUES ('555', 'Jordan', 'hash_jordan', 1, 2000);
            INSERT INTO profile_snapshots (profile_id, data, updated_at)
            VALUES ('555', '{"about":"hi"}', 2000);
            "#,
        )
        .unwrap();
        drop(src);

        // Export clean full SQLite snapshot via VACUUM INTO + provenance stamping
        export_sqlite_db_to_path(&src_db, 100, &snap_db, None, None).unwrap();
        assert!(is_sqlite_file(&snap_db));

        // Poll snapshot tables + owner inference
        let poll = poll_sqlite_at_path(&snap_db).unwrap();
        assert!(poll.ok);
        assert_eq!(poll.owner_user_id, Some(100));
        assert!(poll.tables.iter().any(|t| t.name == "profile_snapshots" && t.row_count == 1));
        assert!(poll
            .tables
            .iter()
            .any(|t| t.name == "chat_local_profile_meta" && !t.known_export_table && t.row_count == 1));

        // Preview rows from snapshot
        let preview = preview_sqlite_table_at_path(&snap_db, "known_profiles", 10, 0).unwrap();
        assert!(preview.ok);
        assert_eq!(preview.total_rows, 1);
        assert_eq!(
            preview.rows[0].get("source_profile_id").and_then(Value::as_str),
            Some("100")
        );

        // Export subset-only SQLite DB (only profile_snapshots)
        let subset = vec!["profile_snapshots".to_owned()];
        export_sqlite_db_to_path(&src_db, 100, &filtered_db, None, Some(&subset)).unwrap();
        let filtered_poll = poll_sqlite_at_path(&filtered_db).unwrap();
        assert_eq!(filtered_poll.tables.len(), 1);
        assert_eq!(filtered_poll.tables[0].name, "profile_snapshots");

        // Import & combine .sqlite3 snapshot + extra table into account 200 DB
        let dst = Connection::open(&dst_db).unwrap();
        init_backup_test_schema(&dst);
        drop(dst);

        let selected_import = vec![
            "conversations".to_owned(),
            "messages".to_owned(),
            "known_profiles".to_owned(),
            "profile_snapshots".to_owned(),
            "chat_local_profile_meta".to_owned(),
        ];
        let outcome = import_backup_from_path_with_options(
            &dst_db,
            200,
            &snap_db,
            &[],
            Some(&selected_import),
            Some("chat-100.sqlite3"),
            |_| {},
        )
        .unwrap();
        assert!(outcome.ok);
        assert!(outcome.rows_imported.unwrap_or(0) >= 5);

        let verify = Connection::open(&dst_db).unwrap();
        let (conv_id, conv_src): (String, Option<String>) = verify
            .query_row(
                "SELECT conversation_id, source_owner_id FROM conversations WHERE other_profile_id = '555'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        let (msg_sender, msg_src): (i64, Option<String>) = verify
            .query_row(
                "SELECT sender_id, source_owner_id FROM messages WHERE message_id = 'msg-sqlite-1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        let known_src: Option<String> = verify
            .query_row(
                "SELECT source_profile_id FROM known_profiles WHERE profile_id = '555'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let nick: String = verify
            .query_row(
                "SELECT local_nickname FROM chat_local_profile_meta WHERE profile_id = '555'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let log_count: i64 = verify
            .query_row("SELECT COUNT(*) FROM data_pull_log", [], |r| r.get(0))
            .unwrap();

        assert_eq!(conv_id, "200:555");
        assert_eq!(conv_src.as_deref(), Some("100"));
        assert_eq!(msg_sender, 200);
        assert_eq!(msg_src.as_deref(), Some("100"));
        assert_eq!(known_src.as_deref(), Some("100"));
        assert_eq!(nick, "Gym Buddy");
        assert_eq!(log_count, 1);
    }

    #[test]
    fn import_works_with_app_created_schemas_and_foreign_key_extra_tables() {
        let dir = TestDir::new("real-schema-fk");
        let src_db = dir.path().join("chat-100.sqlite3");
        let dst_db = dir.path().join("chat-200.sqlite3");
        let zip_path = dir.path().join("real.zip");

        let src = Connection::open(&src_db).unwrap();
        init_backup_test_schema(&src);
        ensure_optional_directory_tables(&src).unwrap();
        // Bundled SQLite enables FK enforcement by default; the fixture needs a
        // dangling reference to mimic an external DB with a foreign key.
        src.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
        src.execute_batch(
            r#"
            CREATE TABLE extra_fk (
                id INTEGER PRIMARY KEY,
                profile_ref INTEGER REFERENCES profile(id)
            );
            INSERT INTO extra_fk (id, profile_ref) VALUES (1, 42);
            INSERT INTO block_events (id, profile_id, conversation_id, event_type, timestamp, display_name, avatar_media_hash, created_at)
            VALUES ('b1', '555', '100:555', 'blocked', 3000, 'Jordan', 'h1', 3000);
            INSERT INTO downloaded_media (identifier, platform, album_id, byte_size, mime_type, kind, saved_at)
            VALUES ('d1', 'windows', NULL, 10, 'image/jpeg', 'photo', 3000);
            INSERT INTO drawer_media_usage (media_id, send_count, updated_at) VALUES (7, 3, 3000);
            INSERT INTO hidden_profiles (profile_id, display_name, avatar_media_hash, hidden_at)
            VALUES ('555', 'Jordan', 'h1', 3000);
            "#,
        )
        .unwrap();
        drop(src);

        // Destination mirrors the schema created by chatDb.ts, which uses
        // `source_label` / `categories_json` in data_pull_log.
        let dst = Connection::open(&dst_db).unwrap();
        init_backup_test_schema(&dst);
        dst.execute_batch(
            r#"
            CREATE TABLE data_pull_log (
                id TEXT PRIMARY KEY,
                source_owner_id TEXT,
                target_owner_id TEXT,
                source_format TEXT NOT NULL,
                source_label TEXT,
                categories_json TEXT NOT NULL,
                tables_json TEXT NOT NULL,
                rows_imported INTEGER NOT NULL,
                pulled_at INTEGER NOT NULL
            );
            CREATE TABLE block_events (
                id TEXT PRIMARY KEY,
                profile_id TEXT,
                conversation_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                display_name TEXT,
                avatar_media_hash TEXT,
                created_at INTEGER NOT NULL
            );
            "#,
        )
        .unwrap();
        drop(dst);

        let all: Vec<String> = ALL_CATEGORY_IDS.iter().map(|s| (*s).to_owned()).collect();

        // ZIP path
        export_backup_to_path(&src_db, 100, &zip_path, &all, |_| {}).unwrap();
        let zip_outcome = import_backup_from_path(&dst_db, 200, &zip_path, &all, |_| {}).unwrap();
        assert!(zip_outcome.ok);

        // SQLite path including a table with a dangling FOREIGN KEY
        let tables = vec!["block_events".to_owned(), "extra_fk".to_owned()];
        let sqlite_outcome = import_backup_from_path_with_options(
            &dst_db,
            200,
            &src_db,
            &all,
            Some(&tables),
            None,
            |_| {},
        )
        .unwrap();
        assert!(sqlite_outcome.ok);

        let verify = Connection::open(&dst_db).unwrap();
        let logs: i64 = verify
            .query_row("SELECT COUNT(*) FROM data_pull_log", [], |r| r.get(0))
            .unwrap();
        let blocks: i64 = verify
            .query_row("SELECT COUNT(*) FROM block_events", [], |r| r.get(0))
            .unwrap();
        let fk_rows: i64 = verify
            .query_row("SELECT COUNT(*) FROM extra_fk", [], |r| r.get(0))
            .unwrap();
        assert_eq!(logs, 2);
        assert_eq!(blocks, 1);
        assert_eq!(fk_rows, 1);
    }

    #[test]
    fn master_db_sync_and_location_preferences_protection() {
        let dir = TestDir::new("master-sync");
        let db1 = dir.path().join("chat-100.sqlite3");
        let db2 = dir.path().join("chat-200.sqlite3");

        let c1 = Connection::open(&db1).unwrap();
        init_backup_test_schema(&c1);
        ensure_optional_directory_tables(&c1).unwrap();
        c1.execute_batch(
            r#"
            INSERT INTO settings (key, value) VALUES ('locationPreferences', '{"geohash":"loc100"}');
            INSERT INTO conversations (
                conversation_id, other_profile_id, name, participants_json,
                last_activity_timestamp, unread_count, pinned, muted, favorite,
                preview_json, archived, archived_reason, archived_at, hidden,
                last_seen_in_inbox_at, created_at, updated_at
            ) VALUES ('100:555', '555', 'Sam', '["100","555"]', 1500, 0, 0, 0, 1, NULL, 0, NULL, NULL, 0, NULL, 1000, 1500);
            INSERT INTO known_profiles (profile_id, display_name, primary_image_hash, is_favorite, updated_at)
            VALUES ('555', 'Sam', 'h_sam', 1, 1500);
            "#,
        )
        .unwrap();
        drop(c1);

        let c2 = Connection::open(&db2).unwrap();
        init_backup_test_schema(&c2);
        ensure_optional_directory_tables(&c2).unwrap();
        c2.execute_batch(
            r#"
            INSERT INTO settings (key, value) VALUES ('locationPreferences', '{"geohash":"loc200"}');
            INSERT INTO conversations (
                conversation_id, other_profile_id, name, participants_json,
                last_activity_timestamp, unread_count, pinned, muted, favorite,
                preview_json, archived, archived_reason, archived_at, hidden,
                last_seen_in_inbox_at, created_at, updated_at
            ) VALUES ('200:555', '555', 'Sam', '["200","555"]', 2500, 0, 0, 0, 0, NULL, 0, NULL, NULL, 0, NULL, 2000, 2500);
            INSERT INTO known_profiles (profile_id, display_name, primary_image_hash, is_favorite, updated_at)
            VALUES ('777', 'Alex', 'h_alex', 0, 2500);
            INSERT INTO profile_snapshots (profile_id, data, updated_at)
            VALUES ('777', '{"about":"alex bio"}', 2500);
            "#,
        )
        .unwrap();
        drop(c2);

        // Cross-account import with settings category must preserve destination's locationPreferences.
        let settings_cat = vec!["settings".to_owned()];
        let outcome = import_backup_from_path_with_options(
            &db2,
            200,
            &db1,
            &settings_cat,
            None,
            None,
            |_| {},
        )
        .unwrap();
        assert!(outcome.ok);
        let verify2 = Connection::open(&db2).unwrap();
        let kept_loc: String = verify2
            .query_row(
                "SELECT value FROM settings WHERE key = 'locationPreferences'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(kept_loc, "{\"geohash\":\"loc200\"}");
        drop(verify2);

        // Master DB sync keeps conversations from both accounts distinct and consolidates profiles/snapshots.
        let master_outcome = sync_master_database_in_dir(dir.path()).unwrap();
        assert!(master_outcome.ok);
        let master = Connection::open(dir.path().join("master.sqlite3")).unwrap();
        let conv_count: i64 = master
            .query_row("SELECT COUNT(*) FROM conversations", [], |r| r.get(0))
            .unwrap();
        let known_count: i64 = master
            .query_row("SELECT COUNT(*) FROM known_profiles", [], |r| r.get(0))
            .unwrap();
        let snap_count: i64 = master
            .query_row("SELECT COUNT(*) FROM profile_snapshots", [], |r| r.get(0))
            .unwrap();
        assert_eq!(conv_count, 2);
        assert_eq!(known_count, 2);
        assert_eq!(snap_count, 1);
    }

    #[test]
    fn cross_account_locations_provenance_and_mini_chat_work() {
        let dir = TestDir::new("cross-account-provenance");
        let db1 = dir.path().join("chat-100.sqlite3");
        let db2 = dir.path().join("chat-200.sqlite3");
        let master_path = dir.path().join("master.sqlite3");

        let c1 = Connection::open(&db1).unwrap();
        init_backup_test_schema(&c1);
        c1.execute_batch(
            r#"
            INSERT INTO settings (key, value) VALUES ('locationPreferences', '{"geohash":"w4rw0","locationName":"123 Nana Rd, Bangkok, Thailand"}');
            INSERT INTO saved_locations (id, name, geohash, lat, lon, created_at) VALUES ('l1', 'Nana Plaza', 'w4rw0', 13.74, 100.55, 1000);
            INSERT INTO conversations (
                conversation_id, other_profile_id, name, participants_json,
                last_activity_timestamp, unread_count, pinned, muted, favorite,
                preview_json, archived, archived_reason, archived_at, hidden,
                last_seen_in_inbox_at, created_at, updated_at
            ) VALUES ('100:555', '555', 'Alex', '["100","555"]', 2500, 2, 0, 0, 0, '{"text":"hey there"}', 0, NULL, NULL, 0, NULL, 1000, 2500);
            INSERT INTO messages (
                message_id, conversation_id, sender_id, timestamp, type, chat1_type,
                body_json, unsent, local_history, created_at, updated_at
            ) VALUES ('m1', '100:555', 555, 2500, 'Text', 'text', '{"text":"hey there"}', 0, 0, 2500, 2500);
            "#,
        ).unwrap();
        drop(c1);

        let c2 = Connection::open(&db2).unwrap();
        init_backup_test_schema(&c2);
        c2.execute_batch(
            r#"
            INSERT INTO settings (key, value) VALUES ('locationPreferences', '{"geohash":"w4r9r","locationName":"Dongtan"}');
            "#,
        ).unwrap();
        drop(c2);

        let m = Connection::open(&master_path).unwrap();
        ensure_master_schema(&m).unwrap();
        m.execute_batch(
            r#"
            INSERT INTO account_profile_favorites (account_id, profile_id, updated_at) VALUES ('100', '555', 2500);
            INSERT INTO account_profile_favorites (account_id, profile_id, updated_at) VALUES ('200', '555', 2600);
            "#,
        ).unwrap();
        drop(m);

        let locs = list_account_locations_in_dir(dir.path()).unwrap();
        assert_eq!(locs.len(), 2);
        assert_eq!(locs[0].short_location_name.as_deref(), Some("Nana Plaza"));
        assert_eq!(locs[1].short_location_name.as_deref(), Some("Dongtan"));

        let prov = get_cross_account_profile_provenance_in_dir(dir.path(), &["555".to_owned()]).unwrap();
        let entry = prov.get("555").unwrap();
        assert_eq!(entry.favorite_account_ids, vec!["100".to_owned(), "200".to_owned()]);
        assert_eq!(entry.conversations.len(), 1);
        assert_eq!(entry.conversations[0].account_id, "100");
        assert_eq!(entry.conversations[0].unread_count, 2);
        assert_eq!(entry.conversations[0].message_count, 1);

        let msgs = read_account_conversation_messages_in_dir(dir.path(), "100", "100:555", 10).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].text.as_deref(), Some("hey there"));
    }
}
