import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Album, Loader2, MapPin, MessageCircle, Search, StickyNote, User, X } from "lucide-react";
import { globalSearchMaster, type GlobalSearchResultItem } from "../services/backupRestore";
import { formatRelativeTime } from "../utils/relativeTime";

interface GlobalSearchModalProps {
	isOpen: boolean;
	onClose: () => void;
}

export function GlobalSearchModal({ isOpen, onClose }: GlobalSearchModalProps) {
	const navigate = useNavigate();
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<GlobalSearchResultItem[]>([]);
	const [isSearching, setIsSearching] = useState(false);
	const inputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		if (!isOpen) return;
		setTimeout(() => inputRef.current?.focus(), 20);
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [isOpen, onClose]);

	useEffect(() => {
		if (!isOpen) return;
		const trimmed = query.trim();
		if (trimmed.length < 2) {
			setResults([]);
			setIsSearching(false);
			return;
		}
		let cancelled = false;
		setIsSearching(true);
		const timer = window.setTimeout(() => {
			void globalSearchMaster(trimmed, 30)
				.then((rows) => {
					if (!cancelled) {
						setResults(rows);
					}
				})
				.catch(() => {
					if (!cancelled) {
						setResults([]);
					}
				})
				.finally(() => {
					if (!cancelled) {
						setIsSearching(false);
					}
				});
		}, 180);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [isOpen, query]);

	if (!isOpen) return null;

	const handleSelect = (item: GlobalSearchResultItem) => {
		onClose();
		if (item.kind === "profile" || item.kind === "note") {
			if (item.profileId) {
				navigate(`/profile/${item.profileId}`);
			}
			return;
		}
		if (item.kind === "conversation" || item.kind === "message") {
			if (item.profileId) {
				navigate(`/chat?targetProfileId=${encodeURIComponent(item.profileId)}`);
			} else if (item.conversationId) {
				navigate(`/chat/${encodeURIComponent(item.conversationId)}`);
			}
			return;
		}
		if (item.kind === "album") {
			navigate("/chat/albums");
			return;
		}
		if (item.kind === "location") {
			navigate("/");
		}
	};

	const renderIcon = (kind: GlobalSearchResultItem["kind"]) => {
		switch (kind) {
			case "profile":
				return <User className="h-4 w-4 text-sky-400" />;
			case "conversation":
			case "message":
				return <MessageCircle className="h-4 w-4 text-[var(--accent)]" />;
			case "note":
				return <StickyNote className="h-4 w-4 text-yellow-400" />;
			case "location":
				return <MapPin className="h-4 w-4 text-emerald-400" />;
			case "album":
				return <Album className="h-4 w-4 text-pink-400" />;
		}
	};

	return (
		<div
			className="fixed inset-0 z-[95] flex items-start justify-center bg-black/60 p-4 pt-16 backdrop-blur-xs"
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Global search"
				className="w-full max-w-lg overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] shadow-2xl"
			>
				<div className="flex items-center gap-2 border-b border-[var(--border)] px-3.5 py-2.5">
					<Search className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
					<input
						ref={inputRef}
						type="text"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search profiles, messages, notes, locations, albums..."
						className="h-8 min-w-0 flex-1 bg-transparent text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] outline-none"
					/>
					{isSearching && <Loader2 className="h-4 w-4 animate-spin text-[var(--accent)]" />}
					<button
						type="button"
						onClick={onClose}
						aria-label="Close global search"
						className="rounded-lg p-1 text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
					>
						<X className="h-4 w-4" />
					</button>
				</div>

				<div className="max-h-[60dvh] overflow-y-auto divide-y divide-[var(--border)]">
					{query.trim().length < 2 ? (
						<p className="px-4 py-8 text-center text-xs text-[var(--text-muted)]">
							Type at least 2 characters to search across all accounts in master.sqlite3. (Shortcut: Ctrl+K)
						</p>
					) : results.length === 0 && !isSearching ? (
						<p className="px-4 py-8 text-center text-xs text-[var(--text-muted)]">
							No matches found for "{query.trim()}".
						</p>
					) : (
						results.map((item, idx) => (
							<button
								key={`${item.kind}-${item.profileId ?? item.conversationId ?? idx}-${idx}`}
								type="button"
								onClick={() => handleSelect(item)}
								className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[var(--surface-2)]"
							>
								<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-2)]">
									{renderIcon(item.kind)}
								</div>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<p className="truncate text-sm font-semibold text-[var(--text)]">{item.title}</p>
										<span className="shrink-0 rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-medium uppercase text-[var(--text-muted)]">
											{item.kind}
										</span>
									</div>
									{item.subtitle && (
										<p className="truncate text-xs text-[var(--text-muted)]">{item.subtitle}</p>
									)}
								</div>
								{item.timestamp ? (
									<span className="shrink-0 text-[11px] text-[var(--text-muted)]">
										{formatRelativeTime(item.timestamp)}
									</span>
								) : null}
							</button>
						))
					)}
				</div>
			</div>
		</div>
	);
}
