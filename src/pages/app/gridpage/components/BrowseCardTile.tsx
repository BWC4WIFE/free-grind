import type { BrowseCard } from "../../GridPage.types";
import { useEffect, useRef, useState } from "react";
import { MapPin, MapPinOff, MessageCircle, Plane, Satellite, Star, Zap } from "lucide-react";
import { RightNowIcon } from "../../../../components/icons/RightNowIcon";
import { useTranslation } from "react-i18next";
import {
	formatDistance,
	getOnlineStatusMeta,
	getDisplayName,
} from "../utils";
import { cn } from "../../../../utils/cn";
import { ProfileImage } from "../../../../components/ui/profile-image";
import { Avatar } from "../../../../components/ui/avatar";
import { FreeGrindBadge } from "../../../../components/FreeGrindBadge";
import { usePresenceCheck } from "../../../../hooks/usePresenceCheck";
import { usePreferences } from "../../../../contexts/PreferencesContext";
import type { ChatContactIndexRecord } from "../../../../types/chat-contact-index";
import type { ProfileCrossAccountProvenance } from "../../../../services/backupRestore";
import type { FormattedAccountLabel } from "../../../../utils/accountLabels";
import { useRevealOnScroll } from "../../../../hooks/useRevealOnScroll";

type BrowseCardTileProps = {
	card: BrowseCard;
	chatContactStatus?: ChatContactIndexRecord | null;
	localNickname?: string;
	provenance?: ProfileCrossAccountProvenance | null;
	showProvenance?: boolean;
	enableMiniChat?: boolean;
	accountMetaMap?: Record<string, FormattedAccountLabel>;
	onSelectProfile: (profileId: string) => void;
	onMessageProfile: (profileId: string) => void;
	onOpenMiniChat?: (profileId: string, accountId?: string) => void;
	isDesktop?: boolean;
};

export function BrowseCardTile({
	card,
	chatContactStatus,
	localNickname,
	provenance,
	showProvenance = false,
	enableMiniChat = true,
	accountMetaMap = {},
	onSelectProfile,
	onMessageProfile,
	onOpenMiniChat,
	isDesktop = false,
}: BrowseCardTileProps) {
	const { t } = useTranslation();
	const { unitsPreset, showDebugInfo, blurGridProfilePictures } = usePreferences();
	const { ref, revealClass } = useRevealOnScroll();
	const [isHovered, setIsHovered] = useState(false);
	const hoverTimerRef = useRef<number | null>(null);
	useEffect(() => {
		return () => {
			if (hoverTimerRef.current !== null) {
				window.clearTimeout(hoverTimerRef.current);
			}
		};
	}, []);
	const name = localNickname?.trim() || getDisplayName(card);
	const onlineStatus = getOnlineStatusMeta(card.lastOnline, card.onlineUntil);
	const age = typeof card.age === "number" && card.age > 0 ? card.age : null;
	const usesFreegrind = usePresenceCheck(card.profileId);
	const isDemoCard = card.profileId.toString().startsWith("demo-");
	const isVisiting = card.isVisiting === true;
	const isRoaming = card.roaming === true;
	const isPopular = card.isPopular === true;
	const isRightNow = card.rightNow === "HOSTING" || card.rightNow === "NOT_HOSTING";
	const isBoosting = card.isBoosting === true;
	const databaseUnread = chatContactStatus?.unreadCount ?? 0;
	const apiUnread = card.unreadCount ?? 0;
	const crossUnread = provenance?.conversations.reduce((acc, c) => Math.max(acc, c.unreadCount), 0) ?? 0;
	const unreadCount = Math.max(databaseUnread, apiUnread, showProvenance ? crossUnread : 0);
	const hasCrossChat = showProvenance && (provenance?.conversations.length ?? 0) > 0;
	const hasChatted = Boolean(chatContactStatus?.hasChatted) || card.chatted === true || unreadCount > 0 || hasCrossChat;
	const hasCrossFav = showProvenance && (provenance?.favoriteAccountIds.length ?? 0) > 0;
	const isFavorite = card.favorite === true || hasCrossFav;
	const hasProvenanceData =
		isDesktop &&
		showProvenance &&
		!isDemoCard &&
		((provenance?.favoriteAccountIds.length ?? 0) > 0 || (provenance?.conversations.length ?? 0) > 0);
	const primaryChatAccountId = provenance?.conversations[0]?.accountId ?? provenance?.favoriteAccountIds[0];

	const handlePointerEnter = () => {
		if (!hasProvenanceData) return;
		if (hoverTimerRef.current !== null) {
			window.clearTimeout(hoverTimerRef.current);
			hoverTimerRef.current = null;
		}
		setIsHovered(true);
	};

	const handlePointerLeave = () => {
		if (hoverTimerRef.current !== null) {
			window.clearTimeout(hoverTimerRef.current);
		}
		hoverTimerRef.current = window.setTimeout(() => setIsHovered(false), 120);
	};

	const handleTriggerChat = (accountId?: string) => {
		if (isDemoCard) return;
		if (enableMiniChat && onOpenMiniChat) {
			onOpenMiniChat(card.profileId, accountId ?? primaryChatAccountId);
		} else {
			onMessageProfile(card.profileId);
		}
	};

	return (
		<div
			ref={ref}
			onMouseEnter={handlePointerEnter}
			onMouseLeave={handlePointerLeave}
			className={cn(
				"relative",
				!isDesktop && "bg-black rounded-[4px] overflow-hidden",
				isHovered && "z-30",
				revealClass,
			)}
		>
			<button
				type="button"
				key={card.profileId}
				onClick={() => !isDemoCard && onSelectProfile(card.profileId)}
				className={cn(
					"surface-card-grid overflow-hidden text-left transition-transform w-full block relative",
					!isDemoCard && "active:scale-95",
					isDesktop
						? "rounded-xl shadow-sm"
						: "rounded-[4px]",
					isBoosting ? "p-[2.5px] z-20" : isRightNow ? "p-[2px]" : "p-0",
					isDemoCard && "cursor-default"
				)}
			>
				{/* Animated Gradient Border Layer (Enhanced Glow) */}
				{isBoosting ? (
					<div
						className="absolute inset-[-100%] animate-[spin_5s_linear_infinite] z-0 blur-[15px] opacity-100"
						style={{
							background: 'conic-gradient(from 0deg, transparent 0deg, var(--accent) 180deg, transparent 360deg)'
						}}
					/>
				) : isRightNow ? (
					/* Static pulsing border signalling "available right now" — suppressed
						while boosting so the two glows don't compete for attention. */
					<div
						className="absolute inset-0 z-0 rounded-[inherit] animate-pulse"
						style={{
							background: 'var(--right-now)',
							boxShadow: '0 0 8px 1px var(--right-now)',
						}}
					/>
				) : null}

				{/*
					Replace "aspect-[5/5]" with "h-0 pb-[100%]", since "aspect-ratio" collapses tile height to ~0 on
                    pre-iOS-15 WebKit. This triggered an endless pagination loop
                    that crashed the WebView renderer. thank you flo
				*/}
				<div className="relative w-full h-0 pb-[100%] bg-[var(--surface-2)] z-10 rounded-[inherit] overflow-hidden ring-1 ring-inset ring-white/10">
					<div className="absolute inset-0">
					<ProfileImage
						src={card.primaryImageUrl}
						alt={t("browse_page.profile_photo_alt", { name })}
						className={cn(
							(isDemoCard || blurGridProfilePictures) && "blur-md scale-110"
						)}
					/>

					{/* Top vignette — fixed height so it reads as a soft light source
						rather than a flat band clipped to the header content's height */}
					<div className="absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-black/70 via-black/25 to-transparent pointer-events-none" />

					{/* Top Header: Name, Age & Status Cluster */}
					<div className="absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-2 p-2 text-white">
						<div className="min-w-0 flex-1">
							<p className="text-sm sm:text-base font-bold leading-tight truncate drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
								{name}
								{age && <span className="font-semibold text-white/90 ml-1"> {age}</span>}
							</p>
						</div>

						<div className={cn(
							"flex shrink-0 items-center",
							onlineStatus.isOnline ? "gap-1" : "gap-0.5"
						)}>
							{(isRightNow || isPopular) && (
								<div className="flex items-center gap-0.5">
									{isPopular && (
										<span className="inline-flex" title="Popular">
											<Zap
												className="h-4 w-4 text-amber-400 drop-shadow-[0_1px_1.5px_rgba(0,0,0,1)] drop-shadow-[0_0_0.8px_rgba(0,0,0,1)]"
												strokeWidth={2.5}
											/>
										</span>
									)}
									{isRightNow && (
										<span className="inline-flex" title="Right Now">
											<RightNowIcon className="h-4 w-4 text-[var(--right-now)] drop-shadow-[0_1px_1.5px_rgba(0,0,0,1)] drop-shadow-[0_0_0.8px_rgba(0,0,0,1)]" />
										</span>
									)}
								</div>
							)}
							{onlineStatus.isOnline ? (
								isVisiting ? (
									<span className="inline-flex" title={t("profile_details.visiting")}>
										<Plane
											className="h-4 w-4 text-green-500 drop-shadow-[0_1px_1.5px_rgba(0,0,0,1)] drop-shadow-[0_0_0.8px_rgba(0,0,0,1)]"
											strokeWidth={2.5}
										/>
									</span>
								) : isRoaming ? (
									<span className="inline-flex" title={t("profile_details.roaming")}>
										<Satellite
											className="h-4 w-4 text-green-500 drop-shadow-[0_1px_1.5px_rgba(0,0,0,1)] drop-shadow-[0_0_0.8px_rgba(0,0,0,1)]"
											strokeWidth={2.5}
										/>
									</span>
								) : (
									<span className="block h-3 w-3 rounded-full bg-green-500 shadow-lg ring-2 ring-black/30" />
								)
							) : null}
							{!onlineStatus.isOnline && (
								<span className="inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-bold text-white backdrop-blur-sm sm:text-[11px]">
									{t(onlineStatus.labelKey, { count: onlineStatus.count })}
								</span>
							)}
						</div>
					</div>

					{/* Bottom-right: Non-interactive indicators when not clickable; interactive chat pill moved outside outer <button> */}
					<div className="absolute bottom-2 right-2 z-10 flex items-center gap-1 pointer-events-none">
						{isFavorite && (
							<div className="flex h-5 w-5 items-center justify-center rounded-full bg-black/50 text-yellow-500 shadow-lg backdrop-blur-sm">
								<Star className="h-3.5 w-3.5 fill-current" />
							</div>
						)}

						{usesFreegrind && !isFavorite && (
							<FreeGrindBadge size="md" variant="onDark" title={t("profile_details.uses_free_grind")} />
						)}

						{/* Reserve horizontal slot if clickable chat badge sits outside the button */}
						{(unreadCount > 0 || hasChatted) && <span className="h-5 min-w-5 opacity-0" />}
					</div>

					{/* Bottom-left: Distance */}
					<div className="absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-black/70 via-black/25 to-transparent pointer-events-none" />
					<div className="absolute bottom-2 left-2 z-10 flex h-5 items-center text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
						{card.distanceMeters == null || !Number.isFinite(card.distanceMeters) ? (
							<MapPinOff className="h-3.5 w-3.5" />
						) : (
							<span className="inline-flex items-center gap-1 text-xs font-semibold">
								<MapPin className="h-3.5 w-3.5" />
								{formatDistance(card.distanceMeters, t, unitsPreset)}
							</span>
						)}
					</div>
					</div>
				</div>
			</button>

			{/* Sibling clickable chat/unread pill (outside outer <button> to avoid nested buttons) */}
			{(unreadCount > 0 || hasChatted) && !isDemoCard && (
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						handleTriggerChat();
					}}
					title={enableMiniChat ? "Open mini-chat" : "Open chat"}
					aria-label={enableMiniChat ? "Open mini-chat" : "Open chat"}
					className="absolute bottom-2 right-2 z-20 flex items-center justify-center transition-transform hover:scale-110 active:scale-95"
				>
					{unreadCount > 0 ? (
						<span className="flex h-5 min-w-5 flex-col items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[10px] font-bold text-[var(--accent-contrast)] shadow-lg ring-1 ring-black/20">
							<span>{unreadCount}</span>
							{showDebugInfo && (
								<span className="text-[7px] leading-tight opacity-80">
									db:{databaseUnread} a:{apiUnread}
								</span>
							)}
						</span>
					) : (
						<span className="flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white shadow-lg backdrop-blur-sm ring-1 ring-white/20">
							<MessageCircle className="h-3.5 w-3.5" />
						</span>
					)}
				</button>
			)}

			{/* Desktop hover provenance popover showing which saved accounts favorited or converse with this profile */}
			{hasProvenanceData && isHovered && provenance && (
				<div
					onClick={(e) => e.stopPropagation()}
					className="absolute inset-x-1 bottom-9 z-40 rounded-xl border border-white/15 bg-black/92 p-2 text-white shadow-2xl backdrop-blur-md animate-in fade-in zoom-in-95 duration-100"
				>
					{provenance.favoriteAccountIds.length > 0 && (
						<div className="mb-1.5 last:mb-0">
							<p className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-yellow-400">
								<Star className="h-3 w-3 fill-current" />
								Favorite of
							</p>
							<div className="flex flex-wrap gap-1">
								{provenance.favoriteAccountIds.map((accId) => {
									const meta = accountMetaMap[accId];
									const label = meta?.label || accId;
									return (
										<button
											key={`fav-${accId}`}
											type="button"
											onClick={() => handleTriggerChat(accId)}
											className="inline-flex max-w-full items-center gap-1 rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-white transition hover:bg-white/20"
											title={`Open ${label}`}
										>
											<Avatar src={meta?.avatarUrl ?? null} alt="" className="h-3.5 w-3.5 shrink-0 rounded-full border-0" />
											<span className="truncate">{label}</span>
										</button>
									);
								})}
							</div>
						</div>
					)}

					{provenance.conversations.length > 0 && (
						<div>
							<p className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-sky-300">
								<MessageCircle className="h-3 w-3" />
								Chats with
							</p>
							<div className="flex flex-col gap-1">
								{provenance.conversations.map((conv) => {
									const meta = accountMetaMap[conv.accountId];
									const label = meta?.label || conv.accountId;
									return (
										<button
											key={`conv-${conv.accountId}`}
											type="button"
											onClick={() => handleTriggerChat(conv.accountId)}
											className="flex w-full items-center gap-1.5 rounded-lg bg-white/10 px-1.5 py-1 text-left text-[10px] transition hover:bg-white/20"
											title={conv.lastMessagePreview || label}
										>
											<Avatar src={meta?.avatarUrl ?? null} alt="" className="h-4 w-4 shrink-0 rounded-full border-0" />
											<div className="min-w-0 flex-1">
												<p className="truncate font-semibold leading-tight text-white">{label}</p>
												{conv.lastMessagePreview && (
													<p className="truncate text-[9px] text-white/70">{conv.lastMessagePreview}</p>
												)}
											</div>
											{conv.unreadCount > 0 ? (
												<span className="shrink-0 rounded-full bg-[var(--accent)] px-1.5 text-[9px] font-bold text-[var(--accent-contrast)]">
													{conv.unreadCount}
												</span>
											) : conv.messageCount > 0 ? (
												<span className="shrink-0 text-[9px] text-white/60">{conv.messageCount}</span>
											) : null}
										</button>
									);
								})}
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
