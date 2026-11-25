import { useCallback, useRef } from "react";

/**
 * Callback ref that enables horizontal scrolling via Mouse Wheel and Shift + Wheel
 * on overflowing horizontal containers (including inside Lenis-managed pages).
 */
export function useHorizontalWheelScroll<T extends HTMLElement = HTMLDivElement>() {
	const cleanupRef = useRef<(() => void) | null>(null);

	return useCallback((node: T | null) => {
		if (cleanupRef.current) {
			cleanupRef.current();
			cleanupRef.current = null;
		}
		if (!node) return;

		const onWheel = (e: WheelEvent) => {
			if (node.scrollWidth <= node.clientWidth + 1) return;
			const delta = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
			if (delta === 0) return;

			const prev = node.scrollLeft;
			node.scrollLeft += delta;
			if (node.scrollLeft !== prev || e.shiftKey) {
				e.preventDefault();
				e.stopPropagation();
			}
		};

		node.addEventListener("wheel", onWheel, { passive: false });
		cleanupRef.current = () => node.removeEventListener("wheel", onWheel);
	}, []);
}
