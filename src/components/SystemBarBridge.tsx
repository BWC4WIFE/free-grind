import { useEffect } from "react";
import { useEffectiveColorScheme } from "../hooks/useEffectiveColorScheme";

/**
 * Tells Android which colour to show behind its navigation buttons, so that
 * strip blends in with the app. `window.FreeGrindBridge` only exists on
 * Android, so this does nothing elsewhere.
 */
export function SystemBarBridge() {
	const colorScheme = useEffectiveColorScheme();

	useEffect(() => {
		const bridge = (
			window as unknown as {
				FreeGrindBridge?: {
					setSystemBarBackground?: (red: number, green: number, blue: number) => void;
				};
			}
		).FreeGrindBridge;
		if (!bridge?.setSystemBarBackground) return;

		// Wait a frame: the theme attribute is applied by a separate effect.
		const frame = requestAnimationFrame(() => {
			const [red, green, blue] = (
				getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g) ?? []
			).map(Number);
			if ([red, green, blue].every(Number.isFinite)) {
				bridge.setSystemBarBackground?.(red, green, blue);
			}
		});
		return () => cancelAnimationFrame(frame);
	}, [colorScheme]);

	return null;
}
