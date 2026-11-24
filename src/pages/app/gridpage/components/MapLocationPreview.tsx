import { MapPin } from "lucide-react";
import { useEffectiveColorScheme } from "../../../../hooks/useEffectiveColorScheme";

type Props = {
	lat: number;
	lon: number;
	className?: string;
};

/**
 * Lightweight static raster-tile preview for chat location bubbles.
 * Avoids spinning up a WebGL MapLibre context per message (browsers/WebViews
 * cap WebGL contexts at ~8-16, which blanked earlier location bubbles).
 */
export function MapLocationPreview({ lat, lon, className = "h-32 w-full" }: Props) {
	const scheme = useEffectiveColorScheme();
	const zoom = 15;
	const n = 2 ** zoom;
	const exactX = ((lon + 180) / 360) * n;
	const latRad = (lat * Math.PI) / 180;
	const exactY =
		((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
	const tileX = Math.max(0, Math.min(n - 1, Math.floor(exactX)));
	const tileY = Math.max(0, Math.min(n - 1, Math.floor(exactY)));
	const offsetX = Math.round((exactX - tileX) * 100);
	const offsetY = Math.round((exactY - tileY) * 100);
	const stylePath = scheme === "dark" ? "dark_all" : "rastertiles/voyager";
	const tileUrl = `https://basemaps.cartocdn.com/${stylePath}/${zoom}/${tileX}/${tileY}@2x.png`;

	return (
		<div className={`relative overflow-hidden bg-[var(--surface-2)] ${className}`}>
			<img
				src={tileUrl}
				alt=""
				loading="lazy"
				decoding="async"
				className="h-full w-full object-cover"
				style={{ objectPosition: `${offsetX}% ${offsetY}%` }}
			/>
			<div
				className="pointer-events-none absolute -translate-x-1/2 -translate-y-full drop-shadow-md"
				style={{ left: `${offsetX}%`, top: `${offsetY}%` }}
			>
				<MapPin className="h-6 w-6 fill-[var(--accent)] text-white" />
			</div>
		</div>
	);
}
