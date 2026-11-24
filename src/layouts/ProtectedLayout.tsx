import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation } from "react-router-dom";
import { NavBar } from "../components/NavBar";
import { useDesktopBreakpoint } from "../hooks/useDesktopBreakpoint";
import { useAuth } from "../contexts/useAuth";
import { useApiFunctions } from "../hooks/useApiFunctions";
import { startViewerChaser } from "../services/viewerChaser";
import { GlobalSearchModal } from "../components/GlobalSearchModal";

export function ProtectedLayout() {
	const location = useLocation();
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const { userId } = useAuth();
	const apiFunctions = useApiFunctions();

	const [isGlobalSearchOpen, setIsGlobalSearchOpen] = useState(false);

	useEffect(() => {
		if (userId == null) return;
		return startViewerChaser(
			apiFunctions,
			t,
			() => userId != null,
			() => void queryClient.invalidateQueries({ queryKey: ["interest", "list"] }),
		);
	}, [apiFunctions, t, userId, queryClient]);

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				setIsGlobalSearchOpen((prev) => !prev);
			}
		};
		const onOpenGlobalSearch = () => {
			setIsGlobalSearchOpen(true);
		};
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("fg:open-global-search", onOpenGlobalSearch);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("fg:open-global-search", onOpenGlobalSearch);
		};
	}, []);

    const isChatConversationRoute =
        (/^\/chat\/[^/]+$/.test(location.pathname) && location.pathname !== "/chat/albums") ||
        (location.pathname === "/chat" && new URLSearchParams(location.search).has("targetProfileId"));
	const isProfileRoute = /^\/profile\/[^/]+$/.test(location.pathname);

	// Must use the same "desktop" signal ChatPage.tsx uses for its dual-pane
	// layout (pointer/hover capability, not window width) — otherwise the two
	// can disagree (e.g. a mouse-driven window narrower than some arbitrary
	// width threshold) and this hides the navbar for a route ChatPage itself
	// never even considers "mobile fullscreen".
	const isChatDualPane = useDesktopBreakpoint();

	// Hide navbar on mobile/tablet for full-screen chat or profile pages.
	const shouldHideNavbar = (isChatConversationRoute || isProfileRoute) && !isChatDualPane;

	return (
		<div className="relative">
			<Outlet />
			{!shouldHideNavbar ? <NavBar /> : null}
			<GlobalSearchModal isOpen={isGlobalSearchOpen} onClose={() => setIsGlobalSearchOpen(false)} />
		</div>
	);
}
