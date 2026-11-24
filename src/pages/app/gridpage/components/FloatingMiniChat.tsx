import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRightLeft, ExternalLink, Loader2, MessageCircle, SendHorizontal, Star, X } from "lucide-react";
import { Avatar } from "../../../../components/ui/avatar";
import {
	readAccountConversationMessages,
	type MiniChatMessage,
	type ProfileCrossAccountProvenance,
} from "../../../../services/backupRestore";
import type { FormattedAccountLabel } from "../../../../utils/accountLabels";
import { formatRelativeTime } from "../../../../utils/relativeTime";
import { cn } from "../../../../utils/cn";

interface FloatingMiniChatProps {
	isOpen: boolean;
	targetProfileId: string;
	targetDisplayName: string;
	targetPhotoUrl?: string | null;
	initialAccountId?: string | null;
	activeUserId: number | null;
	provenance?: ProfileCrossAccountProvenance | null;
	accountMetaMap: Record<string, FormattedAccountLabel>;
	onClose: () => void;
	onOpenProfile: (profileId: string) => void;
	onOpenFullChat: (profileId: string) => void;
	onSwitchAccount: (accountId: string) => Promise<void>;
	onSendQuickMessage: (profileId: string, text: string) => Promise<boolean>;
}

export function FloatingMiniChat({
	isOpen,
	targetProfileId,
	targetDisplayName,
	targetPhotoUrl,
	initialAccountId,
	activeUserId,
	provenance,
	accountMetaMap,
	onClose,
	onOpenProfile,
	onOpenFullChat,
	onSwitchAccount,
	onSendQuickMessage,
}: FloatingMiniChatProps) {
	const activeIdStr = activeUserId != null ? String(activeUserId) : null;

	// Build ordered tab list: conversation accounts first, then any favorite-only accounts, plus active account.
	const accountTabs = useMemo(() => {
		const seen = new Set<string>();
		const list: Array<{
			accountId: string;
			conversationId: string | null;
			unreadCount: number;
			isFavorite: boolean;
			hasChat: boolean;
		}> = [];
		const favSet = new Set(provenance?.favoriteAccountIds ?? []);
		const convByAccount = new Map(
			(provenance?.conversations ?? []).map((c) => [c.accountId, c]),
		);

		const addAccount = (accountId: string) => {
			if (!accountId || seen.has(accountId)) return;
			seen.add(accountId);
			const conv = convByAccount.get(accountId);
			list.push({
				accountId,
				conversationId: conv?.conversationId ?? null,
				unreadCount: conv?.unreadCount ?? 0,
				isFavorite: favSet.has(accountId),
				hasChat: Boolean(conv),
			});
		};

		if (initialAccountId) {
			addAccount(initialAccountId);
		}
		for (const conv of provenance?.conversations ?? []) {
			addAccount(conv.accountId);
		}
		for (const favAcc of provenance?.favoriteAccountIds ?? []) {
			addAccount(favAcc);
		}
		if (activeIdStr) {
			addAccount(activeIdStr);
		}
		return list;
	}, [provenance, initialAccountId, activeIdStr]);

	const [selectedAccountId, setSelectedAccountId] = useState<string>("");
	const [messages, setMessages] = useState<MiniChatMessage[]>([]);
	const [isLoadingMessages, setIsLoadingMessages] = useState(false);
	const [draft, setDraft] = useState("");
	const [isSending, setIsSending] = useState(false);
	const [isSwitchingAccount, setIsSwitchingAccount] = useState(false);
	const listEndRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!isOpen) return;
		if (initialAccountId && accountTabs.some((t) => t.accountId === initialAccountId)) {
			setSelectedAccountId(initialAccountId);
		} else if (accountTabs.length > 0) {
			setSelectedAccountId(accountTabs[0].accountId);
		} else if (activeIdStr) {
			setSelectedAccountId(activeIdStr);
		}
	}, [isOpen, targetProfileId, initialAccountId, activeIdStr, accountTabs]);

	const activeTab = useMemo(
		() => accountTabs.find((t) => t.accountId === selectedAccountId) ?? accountTabs[0] ?? null,
		[accountTabs, selectedAccountId],
	);

	useEffect(() => {
		if (!isOpen || !activeTab?.accountId || !activeTab.conversationId) {
			setMessages([]);
			return;
		}
		let cancelled = false;
		setIsLoadingMessages(true);
		void readAccountConversationMessages(activeTab.accountId, activeTab.conversationId, 40)
			.then((rows) => {
				if (!cancelled) {
					setMessages(rows);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setMessages([]);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setIsLoadingMessages(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [isOpen, activeTab?.accountId, activeTab?.conversationId]);

	useEffect(() => {
		if (!isOpen) return;
		listEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [isOpen, messages.length]);

	useEffect(() => {
		if (!isOpen) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [isOpen, onClose]);

	if (!isOpen) return null;

	const currentTabAccountId = activeTab?.accountId ?? activeIdStr ?? "";
	const isCurrentUserAccount = activeIdStr != null && currentTabAccountId === activeIdStr;
	const currentAccountMeta = accountMetaMap[currentTabAccountId];
	const currentAccountLabel = currentAccountMeta?.label || currentTabAccountId || "Account";

	const handleSend = async () => {
		const trimmed = draft.trim();
		if (!trimmed || !isCurrentUserAccount || isSending) return;
		setIsSending(true);
		try {
			const ok = await onSendQuickMessage(targetProfileId, trimmed);
			if (ok) {
				setDraft("");
				setMessages((prev) => [
					...prev,
					{
						messageId: `local-${Date.now()}`,
						conversationId: activeTab?.conversationId ?? `${activeIdStr}:${targetProfileId}`,
						senderId: activeUserId ?? 0,
						timestamp: Date.now(),
						msgType: "text",
						text: trimmed,
						unsent: false,
					},
				]);
			}
		} finally {
			setIsSending(false);
		}
	};

	const handleSwitch = async () => {
		if (!currentTabAccountId || isSwitchingAccount) return;
		setIsSwitchingAccount(true);
		try {
			await onSwitchAccount(currentTabAccountId);
		} finally {
			setIsSwitchingAccount(false);
		}
	};

	return (
		<div
			role="dialog"
			aria-label={`Mini chat with ${targetDisplayName}`}
			className="fixed bottom-20 right-4 z-[65] flex h-[26rem] max-h-[calc(100dvh-7rem)] w-[22.5rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] shadow-2xl animate-in fade-in slide-in-from-bottom-4 duration-150 sm:bottom-6"
		>
			{/* Header */}
			<div className="flex items-center gap-2.5 border-b border-[var(--border)] bg-[var(--surface-2)]/60 px-3 py-2.5">
				<button
					type="button"
					onClick={() => onOpenProfile(targetProfileId)}
					className="flex min-w-0 flex-1 items-center gap-2.5 text-left hover:opacity-90"
					title="View profile details"
				>
					<Avatar src={targetPhotoUrl ?? null} alt={targetDisplayName} className="h-9 w-9 shrink-0 rounded-full" />
					<div className="min-w-0 flex-1">
						<p className="truncate text-sm font-bold leading-tight">{targetDisplayName}</p>
						<p className="truncate text-[11px] text-[var(--text-muted)]">
							{isCurrentUserAccount ? `Active: ${currentAccountLabel}` : `History: ${currentAccountLabel}`}
						</p>
					</div>
				</button>
				{isCurrentUserAccount && (
					<button
						type="button"
						onClick={() => onOpenFullChat(targetProfileId)}
						title="Open full chat"
						aria-label="Open full chat"
						className="rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
					>
						<ExternalLink className="h-4 w-4" />
					</button>
				)}
				<button
					type="button"
					onClick={onClose}
					title="Close mini-chat"
					aria-label="Close mini-chat"
					className="rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
				>
					<X className="h-4 w-4" />
				</button>
			</div>

			{/* Account Switcher Tabs (shows Favorite / Chat accounts for this profile) */}
			{accountTabs.length > 0 && (
				<div className="flex items-center gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5">
					{accountTabs.map((tab) => {
						const meta = accountMetaMap[tab.accountId];
						const selected = tab.accountId === currentTabAccountId;
						const labelText = meta?.label || tab.accountId;
						return (
							<button
								key={tab.accountId}
								type="button"
								onClick={() => setSelectedAccountId(tab.accountId)}
								title={meta?.fullLocation ? `${labelText} (${meta.fullLocation})` : labelText}
								className={cn(
									"inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
									selected
										? "border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--text)]"
										: "border-[var(--border)] bg-[var(--surface-2)]/60 text-[var(--text-muted)] hover:text-[var(--text)]",
								)}
							>
								<Avatar src={meta?.avatarUrl ?? null} alt="" className="h-4 w-4 shrink-0 rounded-full border-0" />
								<span className="max-w-[8.5rem] truncate">{labelText}</span>
								{tab.isFavorite && <Star className="h-3 w-3 shrink-0 fill-yellow-500 text-yellow-500" />}
								{tab.unreadCount > 0 ? (
									<span className="rounded-full bg-[var(--accent)] px-1.5 text-[10px] font-bold text-[var(--accent-contrast)]">
										{tab.unreadCount}
									</span>
								) : tab.hasChat ? (
									<MessageCircle className="h-3 w-3 shrink-0 opacity-75" />
								) : null}
							</button>
						);
					})}
				</div>
			)}

			{/* Message History */}
			<div className="flex-1 overflow-y-auto px-3 py-2.5 space-y-2">
				{isLoadingMessages ? (
					<div className="flex h-full items-center justify-center text-xs text-[var(--text-muted)]">
						<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						Loading local history...
					</div>
				) : messages.length === 0 ? (
					<div className="flex h-full flex-col items-center justify-center px-4 text-center text-xs text-[var(--text-muted)]">
						<MessageCircle className="mb-1.5 h-5 w-5 opacity-50" />
						<p>No local messages cached for {currentAccountLabel}.</p>
					</div>
				) : (
					messages.map((msg) => {
						const isOutgoing = String(msg.senderId) === currentTabAccountId;
						return (
							<div
								key={msg.messageId}
								className={cn("flex flex-col", isOutgoing ? "items-end" : "items-start")}
							>
								<div
									className={cn(
										"max-w-[85%] rounded-2xl px-3 py-1.5 text-xs leading-relaxed break-words",
										isOutgoing
											? "bg-[var(--accent)] text-[var(--accent-contrast)]"
											: "bg-[var(--surface-2)] text-[var(--text)]",
										msg.unsent && "italic opacity-65",
									)}
								>
									{msg.unsent ? "(Unsent)" : msg.text || `[${msg.msgType || "Message"}]`}
								</div>
								<span className="mt-0.5 px-1 text-[10px] text-[var(--text-muted)]">
									{formatRelativeTime(msg.timestamp)}
								</span>
							</div>
						);
					})
				)}
				<div ref={listEndRef} />
			</div>

			{/* Footer: Live reply if active account, or 1-click Switch Account if another account */}
			<div className="border-t border-[var(--border)] bg-[var(--surface-2)]/40 p-2.5">
				{isCurrentUserAccount ? (
					<form
						onSubmit={(e) => {
							e.preventDefault();
							void handleSend();
						}}
						className="flex items-center gap-1.5"
					>
						<input
							type="text"
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							maxLength={1000}
							disabled={isSending}
							placeholder={`Reply as ${currentAccountLabel}...`}
							className="h-9 min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-xs text-[var(--text)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent)]"
						/>
						<button
							type="submit"
							disabled={!draft.trim() || isSending}
							aria-label="Send message"
							className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--accent)] text-[var(--accent-contrast)] transition hover:brightness-110 disabled:opacity-50"
						>
							{isSending ? (
								<Loader2 className="h-4 w-4 animate-spin" />
							) : (
								<SendHorizontal className="h-4 w-4" />
							)}
						</button>
					</form>
				) : (
					<div className="flex flex-col gap-1.5">
						<p className="text-center text-[11px] text-[var(--text-muted)]">
							Read-only local history for {currentAccountLabel}
						</p>
						<button
							type="button"
							onClick={() => void handleSwitch()}
							disabled={isSwitchingAccount}
							className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-xl bg-[var(--accent)] px-3 text-xs font-semibold text-[var(--accent-contrast)] transition hover:brightness-110 disabled:opacity-60"
						>
							{isSwitchingAccount ? (
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
							) : (
								<ArrowRightLeft className="h-3.5 w-3.5" />
							)}
							Switch to {currentAccountLabel} to reply
						</button>
					</div>
				)}
			</div>
		</div>
	);
}
