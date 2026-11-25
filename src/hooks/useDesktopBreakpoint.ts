import { useEffect, useState } from "react";

/**
 * Hook to detect if the current device is a desktop (has a mouse/pointer and hover).
 * This is more reliable for scrolling behavior than screen width.
 */
export function useDesktopBreakpoint() {
	const [isDesktop, setIsDesktop] = useState(() =>
		typeof window !== "undefined"
			? window.matchMedia("(hover: hover) and (pointer: fine)").matches
			: false,
	);

	useEffect(() => {
		if (typeof window === "undefined") return;

		const query = window.matchMedia("(hover: hover) and (pointer: fine)");
		const update = () => setIsDesktop(query.matches);

		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);

	return isDesktop;
}

/**
 * Width-aware desktop layout check for multi-column splits (e.g. dual-pane chat)
 * so narrow desktop windows collapse cleanly instead of crushing side-by-side panes.
 */
export function useCanFitDualPane() {
	const [canFit, setCanFit] = useState(() =>
		typeof window !== "undefined"
			? window.matchMedia("(min-width: 768px) and (hover: hover) and (pointer: fine)").matches
			: false,
	);

	useEffect(() => {
		if (typeof window === "undefined") return;

		const query = window.matchMedia("(min-width: 768px) and (hover: hover) and (pointer: fine)");
		const update = () => setCanFit(query.matches);

		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);

	return canFit;
}
