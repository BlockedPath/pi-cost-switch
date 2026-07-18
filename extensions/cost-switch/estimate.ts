/**
 * Pure cost estimation helpers for cost-switch.
 *
 * Kept free of ExtensionAPI / TUI so unit tests can exercise math without Pi.
 */

import { formatTokens, formatUsd, formatUsdRange } from "./format.ts";
import { resolveHitRate } from "./hit-rate.ts";

/** Thinking levels accepted by effort multipliers (mirrors ModelThinkingLevel). */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Rough output-token multipliers relative to a "medium" baseline turn. */
export const EFFORT_MULT: Record<ThinkingLevel, number> = {
	off: 0.7,
	minimal: 0.9,
	low: 1.2,
	medium: 1.8,
	high: 3.5,
	xhigh: 6.5,
	max: 11,
};

export interface CostRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Minimal cost shape — compatible with pi-ai Model.cost. */
export interface ModelCostLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	tiers?: Array<{
		inputTokensAbove?: number;
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	}>;
}

/** Minimal model shape for rate resolution / ranking. */
export interface ModelLike {
	provider: string;
	id: string;
	name?: string;
	cost: ModelCostLike;
}

export interface PromptShape {
	/** Estimated total input tokens for the next request. */
	nextTokens: number;
	/** Previous request prompt tokens that could be re-billed on a miss. */
	cacheableTokens: number;
	/** Observed recent cache hit rate 0..1 (0 if unknown / no cache reads). */
	hitRate: number;
	/** Last assistant output tokens (for reasoning heuristic). */
	lastOutput: number;
	/** Rolling average assistant output tokens in this session. */
	avgOutput: number;
	/** Sample count for avgOutput. */
	outputSamples: number;
}

export interface TurnEstimate {
	hit: number;
	/** Full next request at normal uncached-input pricing. */
	coldBase: number;
	/** Full next request if the provider charges its cache-write premium. */
	coldWrite: number;
	/** Extra cost vs cached reads for the previously cacheable prefix. */
	taxBase: number;
	/** Extra cost vs cached reads if the prefix is billed at cache-write pricing. */
	taxWrite: number;
	inputHit: number;
	inputColdBase: number;
	inputColdWrite: number;
	output: number;
	expectedOut: number;
	priced: boolean;
}

export function modelKey(model: { provider: string; id: string } | undefined): string {
	if (!model) return "none";
	return `${model.provider}/${model.id}`;
}

export function resolveRates(model: ModelLike, promptTokens: number): CostRates {
	const cost = model.cost;
	let rates: CostRates = {
		input: cost.input ?? 0,
		output: cost.output ?? 0,
		cacheRead: cost.cacheRead ?? 0,
		cacheWrite: cost.cacheWrite ?? 0,
	};
	let matched = -1;
	for (const tier of cost.tiers ?? []) {
		const above = tier.inputTokensAbove ?? 0;
		if (promptTokens > above && above > matched) {
			rates = {
				input: tier.input ?? rates.input,
				output: tier.output ?? rates.output,
				cacheRead: tier.cacheRead ?? rates.cacheRead,
				cacheWrite: tier.cacheWrite ?? rates.cacheWrite,
			};
			matched = above;
		}
	}
	return rates;
}

export function isPriced(rates: CostRates): boolean {
	return rates.input > 0 || rates.output > 0 || rates.cacheRead > 0 || rates.cacheWrite > 0;
}

/** Full next request input at normal uncached-input pricing. */
export function baseColdInputCost(promptTokens: number, rates: CostRates): number {
	return (promptTokens * rates.input) / 1_000_000;
}

/** Full next request input if a provider applies its cache-write premium. */
export function writeColdInputCost(promptTokens: number, rates: CostRates): number {
	const writeRate = Math.max(rates.input, rates.cacheWrite);
	return (promptTokens * writeRate) / 1_000_000;
}

/** Extra input cost when a previously cacheable prefix is re-billed. */
export function cacheTax(cacheableTokens: number, paidRate: number, readRate: number): number {
	return (cacheableTokens * Math.max(0, paidRate - readRate)) / 1_000_000;
}

/**
 * Hit input: apply resolved hit rate; residual at uncached input.
 * Observed 0 is unknown — resolveHitRate assumes DEFAULT_ASSUMED_HIT_RATE.
 */
export function hitInputCost(promptTokens: number, hitRate: number, rates: CostRates): number {
	const { rate } = resolveHitRate(hitRate);
	const cached = Math.floor(promptTokens * rate);
	const uncached = Math.max(0, promptTokens - cached);
	return (cached * rates.cacheRead + uncached * rates.input) / 1_000_000;
}

export function expectedOutputTokens(
	shape: PromptShape,
	fromLevel: ThinkingLevel,
	toLevel: ThinkingLevel,
): number {
	const base = shape.avgOutput > 0 ? shape.avgOutput : shape.lastOutput > 0 ? shape.lastOutput : 800;
	const fromMult = EFFORT_MULT[fromLevel] ?? 1.8;
	const toMult = EFFORT_MULT[toLevel] ?? 1.8;
	// Scale relative to current level's observed output when we have samples.
	const scaled = shape.outputSamples > 0 ? base * (toMult / fromMult) : base * (toMult / EFFORT_MULT.medium);
	return Math.max(64, Math.round(scaled));
}

/** Ordered thinking levels for pure clamp (mirrors pi-ai, plus local "max"). */
export const THINKING_LEVEL_ORDER: ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/**
 * Clamp a requested thinking level to a model's supported set.
 * Pure mirror of pi-ai clampThinkingLevel for unit tests / fixtures.
 */
export function clampThinkingToSupported(
	level: ThinkingLevel,
	supported: readonly ThinkingLevel[],
): ThinkingLevel {
	if (supported.length === 0) return "off";
	if (supported.includes(level)) return level;
	const requestedIndex = THINKING_LEVEL_ORDER.indexOf(level);
	if (requestedIndex === -1) return supported[0];
	for (let i = requestedIndex; i < THINKING_LEVEL_ORDER.length; i++) {
		const candidate = THINKING_LEVEL_ORDER[i];
		if (supported.includes(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = THINKING_LEVEL_ORDER[i];
		if (supported.includes(candidate)) return candidate;
	}
	return supported[0];
}

export interface EstimateTurnOptions {
	/**
	 * When false, hit cost equals cold (cache does not transfer across models).
	 * Default true — warm continuation using session hit rate.
	 */
	assumeWarmCache?: boolean;
}

export function estimateTurn(
	model: ModelLike,
	shape: PromptShape,
	thinking: ThinkingLevel,
	currentThinking: ThinkingLevel,
	opts?: EstimateTurnOptions,
): TurnEstimate {
	const rates = resolveRates(model, shape.nextTokens);
	const priced = isPriced(rates);
	const expectedOut = expectedOutputTokens(shape, currentThinking, thinking);
	const inputColdBase = baseColdInputCost(shape.nextTokens, rates);
	const inputColdWrite = writeColdInputCost(shape.nextTokens, rates);
	// Cross-model: prompt cache almost never transfers — treat hit as full cold.
	const inputHit =
		opts?.assumeWarmCache === false
			? inputColdBase
			: hitInputCost(shape.nextTokens, shape.hitRate, rates);
	const output = (expectedOut * rates.output) / 1_000_000;
	const writeRate = Math.max(rates.input, rates.cacheWrite);
	return {
		hit: inputHit + output,
		coldBase: inputColdBase + output,
		coldWrite: inputColdWrite + output,
		taxBase: cacheTax(shape.cacheableTokens, rates.input, rates.cacheRead),
		taxWrite: cacheTax(shape.cacheableTokens, writeRate, rates.cacheRead),
		inputHit,
		inputColdBase,
		inputColdWrite,
		output,
		expectedOut,
		priced,
	};
}

export interface EstimateDescriptionOptions {
	emphasizeCold?: boolean;
	/**
	 * When false, show "n/a hit" instead of a warm $ (cache not transferable).
	 * Default true.
	 */
	warmHit?: boolean;
}

export function estimateDescription(est: TurnEstimate, opts?: EstimateDescriptionOptions): string {
	const riskMark = opts?.emphasizeCold ? " ← risk" : "";
	const cold = formatUsdRange(est.coldBase, est.coldWrite, est.priced);
	const tax = formatUsdRange(est.taxBase, est.taxWrite, est.priced);
	// Unpriced models format as "sub" — avoid "tax +sub".
	const taxBit = est.priced ? `tax +${tax}` : `tax ${tax}`;
	const hitBit = opts?.warmHit === false ? "n/a hit" : `${formatUsd(est.hit, est.priced)} hit`;
	return `${hitBit} · ${cold} cold${riskMark} · ${taxBit} · ~${formatTokens(est.expectedOut)} out`;
}

/**
 * Derive hit rate from last usage fields (pure slice of collectPromptShape).
 * Returns 0 when there is no cacheable volume.
 */
export function hitRateFromUsage(lastCacheRead: number, cacheableTokens: number): number {
	return cacheableTokens > 0 ? lastCacheRead / cacheableTokens : 0;
}

/**
 * Build cacheable token total from last usage fields (pure slice of collectPromptShape).
 */
export function cacheableFromUsage(lastInput: number, lastCacheRead: number, lastCacheWrite: number): number {
	return lastInput + lastCacheRead + lastCacheWrite;
}
