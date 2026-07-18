/**
 * Hit-rate policy for warm (cache-hit) cost estimates.
 *
 * Observed session hit rate is separate from the rate used for $ estimates:
 * when no cache reads have been seen yet, estimates assume a default warm rate
 * rather than treating 0 as a measured 0% hit rate.
 */

/** Default warm hit rate when the session has no observed cache reads. */
export const DEFAULT_ASSUMED_HIT_RATE = 0.85;

/** Cap applied to observed rates so estimates stay slightly conservative. */
export const MAX_HIT_RATE = 0.99;

export interface ResolvedHitRate {
	/** Rate 0..1 used for dollar estimates. */
	rate: number;
	/** True when `rate` is the default assumption, not session-observed. */
	assumed: boolean;
	/** Raw observed rate 0..1 (0 when unknown / no cache reads). */
	observed: number;
}

/**
 * Resolve the hit rate used for warm estimates from an observed session rate.
 * Observed 0 / non-finite means "unknown", not a measured 0% hit rate.
 */
export function resolveHitRate(observedHitRate: number): ResolvedHitRate {
	const observed =
		Number.isFinite(observedHitRate) && observedHitRate > 0 ? observedHitRate : 0;
	if (observed > 0) {
		return {
			rate: Math.min(MAX_HIT_RATE, observed),
			assumed: false,
			observed,
		};
	}
	return {
		rate: DEFAULT_ASSUMED_HIT_RATE,
		assumed: true,
		observed: 0,
	};
}

/**
 * UI label for the rate behind hit-$ estimates.
 * Examples: "72%", "~85% (assumed)"
 */
export function formatHitRateDisplay(observedHitRate: number): string {
	const { rate, assumed } = resolveHitRate(observedHitRate);
	const pct = `${(rate * 100).toFixed(0)}%`;
	return assumed ? `~${pct} (assumed)` : pct;
}
