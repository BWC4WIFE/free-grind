/** Scrolled distance that counts as a deliberate move, in pixels. */
const STEP_THRESHOLD_PX = 40;
/** A pause this long ends a gesture. Touchpad coasting sends events far closer together. */
const GESTURE_END_GAP_MS = 140;
const PIXELS_PER_LINE = 16;
const PIXELS_PER_PAGE = 800;

export type WheelStepper = {
	/** True while the stream that already produced a step is still arriving. */
	isCoasting: (timeStamp: number) => boolean;
	/** Feeds in one wheel event and returns the step it completes, if any. */
	push: (event: Pick<WheelEvent, "deltaY" | "deltaMode" | "timeStamp">) => -1 | 0 | 1;
};

/**
 * Turns a wheel event stream into one step per gesture. A touchpad swipe sends dozens of
 * events, and keeps sending them while it coasts after the fingers lift. So a step is
 * taken once, then the rest of that stream is ignored until it pauses or changes
 * direction. Coasting never reverses, so a reversal is always a new gesture.
 */
export function createWheelStepper(): WheelStepper {
	let accumulated = 0;
	let lastEventTime = Number.NEGATIVE_INFINITY;
	let hasStepped = false;
	let steppedDirection = 0;

	const isCoasting = (timeStamp: number) =>
		hasStepped && timeStamp - lastEventTime <= GESTURE_END_GAP_MS;

	return {
		isCoasting,
		push({ deltaY, deltaMode, timeStamp }) {
			const coasting = isCoasting(timeStamp);
			if (timeStamp - lastEventTime > GESTURE_END_GAP_MS) {
				accumulated = 0;
				hasStepped = false;
			}
			lastEventTime = timeStamp;

			if (deltaY === 0) return 0;

			const scale =
				deltaMode === WheelEvent.DOM_DELTA_LINE
					? PIXELS_PER_LINE
					: deltaMode === WheelEvent.DOM_DELTA_PAGE
						? PIXELS_PER_PAGE
						: 1;
			const direction = Math.sign(deltaY) as -1 | 1;

			if (coasting && direction === steppedDirection) return 0;
			if (accumulated !== 0 && Math.sign(accumulated) !== direction) {
				accumulated = 0;
			}

			accumulated += deltaY * scale;
			if (Math.abs(accumulated) < STEP_THRESHOLD_PX) return 0;

			accumulated = 0;
			hasStepped = true;
			steppedDirection = direction;
			return direction;
		},
	};
}
