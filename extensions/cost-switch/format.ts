/**
 * Pure formatting helpers for cost-switch estimates.
 */

export function formatTokens(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1000) return String(Math.round(n));
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatUsd(n: number, priced: boolean): string {
	if (!priced) return "sub";
	if (!Number.isFinite(n) || n < 0) return "?";
	if (n === 0) return "$0";
	if (n < 0.001) return `$${n.toFixed(4)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}

export function formatUsdRange(min: number, max: number, priced: boolean): string {
	if (!priced) return "sub";
	const low = Math.min(min, max);
	const high = Math.max(min, max);
	if (Math.abs(high - low) < 0.0005) return formatUsd(high, true);
	return `${formatUsd(low, true)}–${formatUsd(high, true)}`;
}

export function formatPct(rate: number): string {
	if (!Number.isFinite(rate) || rate <= 0) return "0%";
	return `${(rate * 100).toFixed(0)}%`;
}
