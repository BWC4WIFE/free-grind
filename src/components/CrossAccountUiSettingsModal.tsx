import { useEffect } from "react";
import { MapPin, MessageSquare, RotateCcw, Users, X } from "lucide-react";
import { useCrossAccountUiPrefs, type CrossAccountUiPrefs } from "../utils/crossAccountUiPrefs";

interface CrossAccountUiSettingsModalProps {
	isOpen: boolean;
	onClose: () => void;
}

const TOGGLE_ITEMS: Array<{
	key: keyof CrossAccountUiPrefs;
	title: string;
	description: string;
	icon: typeof MapPin;
}> = [
	{
		key: "showAccountLocationHints",
		title: "Account Switcher Location Hints",
		description:
			"Show each account's short location tag and full location hover tooltip in the Home switcher and Settings.",
		icon: MapPin,
	},
	{
		key: "showGridCrossAccountProvenance",
		title: "Grid Cross-Account Provenance",
		description:
			"Reveal which of your accounts favorited or chatted with a profile when hovering a Grid card or viewing Profile Details.",
		icon: Users,
	},
	{
		key: "enableFloatingMiniChat",
		title: "Floating Mini-Chat Window",
		description:
			"Open a compact floating chat preview/reply box from Grid cards and Profile Details instead of navigating straight to full Chat.",
		icon: MessageSquare,
	},
];

export function CrossAccountUiSettingsModal({
	isOpen,
	onClose,
}: CrossAccountUiSettingsModalProps) {
	const { prefs, setPref, resetPrefs } = useCrossAccountUiPrefs();

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

	return (
		<div
			className="fixed inset-0 z-[90] flex items-center justify-center bg-black/55 p-4 backdrop-blur-xs"
			onClick={(e) => {
				if (e.target === e.currentTarget) {
					onClose();
				}
			}}
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="cross-account-ui-settings-title"
				className="w-full max-w-md overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] shadow-2xl animate-in fade-in zoom-in-95 duration-150"
			>
				<div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3.5">
					<div>
						<h2 id="cross-account-ui-settings-title" className="text-sm font-bold">
							Cross-Account & Grid UI
						</h2>
						<p className="mt-0.5 text-xs text-[var(--text-muted)]">
							Toggle individual multi-account overlays on or off anytime.
						</p>
					</div>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close settings"
						className="rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
					>
						<X className="h-4 w-4" />
					</button>
				</div>

				<div className="divide-y divide-[var(--border)]">
					{TOGGLE_ITEMS.map(({ key, title, description, icon: Icon }) => {
						const enabled = prefs[key];
						return (
							<div key={key} className="flex items-start gap-3 px-4 py-3.5">
								<div className="mt-0.5 shrink-0 rounded-xl bg-[var(--surface-2)] p-2 text-[var(--accent)]">
									<Icon className="h-4 w-4" />
								</div>
								<div className="min-w-0 flex-1">
									<p className="text-sm font-semibold leading-snug">{title}</p>
									<p className="mt-0.5 text-xs leading-relaxed text-[var(--text-muted)]">
										{description}
									</p>
								</div>
								<button
									type="button"
									role="switch"
									aria-checked={enabled}
									aria-label={title}
									onClick={() => setPref(key, !enabled)}
									className={`relative mt-1 inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
										enabled ? "bg-[var(--accent)]" : "bg-[var(--surface-2)]"
									}`}
								>
									<span
										className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
											enabled ? "translate-x-5" : "translate-x-0"
										}`}
									/>
								</button>
							</div>
						);
					})}
				</div>

				<div className="flex items-center justify-between border-t border-[var(--border)] bg-[var(--surface-2)]/40 px-4 py-3">
					<button
						type="button"
						onClick={resetPrefs}
						className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
					>
						<RotateCcw className="h-3.5 w-3.5" />
						Reset defaults
					</button>
					<button
						type="button"
						onClick={onClose}
						className="inline-flex items-center justify-center rounded-xl bg-[var(--accent)] px-4 py-1.5 text-xs font-semibold text-[var(--accent-contrast)] transition hover:brightness-110"
					>
						Done
					</button>
				</div>
			</div>
		</div>
	);
}
