import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	type CostRates,
	type ModelLike,
	type PromptShape,
	type ThinkingLevel,
	baseColdInputCost,
	cacheTax,
	cacheableFromUsage,
	clampThinkingToSupported,
	estimateDescription,
	estimateTurn,
	expectedOutputTokens,
	hitInputCost,
	hitRateFromUsage,
	isPriced,
	resolveRates,
	writeColdInputCost,
} from "../extensions/cost-switch/estimate.ts";
import { rankModels } from "../extensions/cost-switch/rank.ts";
import { formatPct, formatTokens, formatUsd, formatUsdRange } from "../extensions/cost-switch/format.ts";

const BASE_RATES: CostRates = {
	input: 3,
	output: 15,
	cacheRead: 0.3,
	cacheWrite: 3.75,
};

function model(partial: Partial<ModelLike> & Pick<ModelLike, "id"> & { cost?: ModelLike["cost"] }): ModelLike {
	return {
		provider: partial.provider ?? "openai",
		id: partial.id,
		name: partial.name,
		cost: partial.cost ?? { ...BASE_RATES },
	};
}

function shape(partial: Partial<PromptShape> = {}): PromptShape {
	return {
		nextTokens: 10_000,
		cacheableTokens: 8_000,
		hitRate: 0.9,
		lastOutput: 500,
		avgOutput: 500,
		outputSamples: 3,
		...partial,
	};
}

describe("resolveRates", () => {
	it("returns base rates when no tiers", () => {
		const rates = resolveRates(model({ id: "base", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } }), 5_000);
		assert.deepEqual(rates, { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 });
	});

	it("keeps base rates when prompt is at or below first threshold", () => {
		const m = model({
			id: "tiered",
			cost: {
				input: 3,
				output: 15,
				cacheRead: 0.3,
				cacheWrite: 3.75,
				tiers: [{ inputTokensAbove: 200_000, input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 7.5 }],
			},
		});
		assert.equal(resolveRates(m, 200_000).input, 3);
		assert.equal(resolveRates(m, 1).input, 3);
	});

	it("applies the highest matching multi-tier threshold", () => {
		const m = model({
			id: "multi",
			cost: {
				input: 1,
				output: 2,
				cacheRead: 0.1,
				cacheWrite: 1.25,
				tiers: [
					{ inputTokensAbove: 100_000, input: 2, output: 4, cacheRead: 0.2, cacheWrite: 2.5 },
					{ inputTokensAbove: 500_000, input: 4, output: 8, cacheRead: 0.4, cacheWrite: 5 },
					// Out-of-order tier should still win when above is highest matched
					{ inputTokensAbove: 200_000, input: 3, output: 6, cacheRead: 0.3, cacheWrite: 3.75 },
				],
			},
		});
		assert.equal(resolveRates(m, 150_000).input, 2);
		assert.equal(resolveRates(m, 250_000).input, 3);
		assert.equal(resolveRates(m, 600_000).input, 4);
		assert.equal(resolveRates(m, 600_000).cacheRead, 0.4);
	});

	it("partial tier fields fall back to previous rates", () => {
		const m = model({
			id: "partial",
			cost: {
				input: 3,
				output: 15,
				cacheRead: 0.3,
				cacheWrite: 3.75,
				tiers: [{ inputTokensAbove: 10, input: 9 }],
			},
		});
		const rates = resolveRates(m, 11);
		assert.equal(rates.input, 9);
		assert.equal(rates.output, 15);
		assert.equal(rates.cacheRead, 0.3);
		assert.equal(rates.cacheWrite, 3.75);
	});
});

describe("hitInputCost", () => {
	it("uses known hit rate (capped at 0.99)", () => {
		// 10k * 0.9 = 9000 cached @ 0.3, 1000 uncached @ 3
		const cost = hitInputCost(10_000, 0.9, BASE_RATES);
		assert.equal(cost, (9000 * 0.3 + 1000 * 3) / 1_000_000);
	});

	it("caps hit rate at 0.99", () => {
		const cost = hitInputCost(1000, 1.0, BASE_RATES);
		const cached = Math.floor(1000 * 0.99);
		const uncached = 1000 - cached;
		assert.equal(cost, (cached * 0.3 + uncached * 3) / 1_000_000);
	});

	it("defaults to 85% when hit rate is unknown (0)", () => {
		const cost = hitInputCost(10_000, 0, BASE_RATES);
		const cached = Math.floor(10_000 * 0.85);
		const uncached = 10_000 - cached;
		assert.equal(cost, (cached * 0.3 + uncached * 3) / 1_000_000);
	});

	it("defaults to 85% for negative hit rate", () => {
		const known = hitInputCost(10_000, 0, BASE_RATES);
		const neg = hitInputCost(10_000, -0.5, BASE_RATES);
		assert.equal(neg, known);
	});

	it("returns zero for zero rates (subscription)", () => {
		const zero: CostRates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		assert.equal(hitInputCost(50_000, 0.9, zero), 0);
	});
});

describe("cacheTax and cold bounds", () => {
	it("cacheTax is paid-minus-read premium over cacheable tokens", () => {
		// 8000 * (3 - 0.3) / 1e6
		assert.equal(cacheTax(8_000, 3, 0.3), (8000 * 2.7) / 1_000_000);
	});

	it("cacheTax never goes negative when read > paid", () => {
		assert.equal(cacheTax(8_000, 0.1, 0.3), 0);
	});

	it("cold base uses uncached input rate", () => {
		assert.equal(baseColdInputCost(10_000, BASE_RATES), (10_000 * 3) / 1_000_000);
	});

	it("cold write upper bound uses max(input, cacheWrite)", () => {
		assert.equal(writeColdInputCost(10_000, BASE_RATES), (10_000 * 3.75) / 1_000_000);
		// When cacheWrite is below input, write bound collapses to input
		const rates: CostRates = { input: 5, output: 1, cacheRead: 0.5, cacheWrite: 2 };
		assert.equal(writeColdInputCost(1_000, rates), (1_000 * 5) / 1_000_000);
	});

	it("estimateTurn cold write is upper bound over cold base when write premium exists", () => {
		const est = estimateTurn(model({ id: "m" }), shape(), "medium", "medium");
		assert.ok(est.coldWrite >= est.coldBase);
		assert.ok(est.taxWrite >= est.taxBase);
		assert.equal(est.inputColdBase, baseColdInputCost(10_000, BASE_RATES));
		assert.equal(est.inputColdWrite, writeColdInputCost(10_000, BASE_RATES));
	});
});

describe("expectedOutputTokens", () => {
	it("scales with thinking level when samples exist", () => {
		const s = shape({ avgOutput: 1800, lastOutput: 1000, outputSamples: 4 });
		const medium = expectedOutputTokens(s, "medium", "medium");
		const high = expectedOutputTokens(s, "medium", "high");
		const off = expectedOutputTokens(s, "medium", "off");
		assert.equal(medium, 1800);
		// 1800 * (3.5 / 1.8)
		assert.equal(high, Math.round(1800 * (3.5 / 1.8)));
		assert.equal(off, Math.round(1800 * (0.7 / 1.8)));
		assert.ok(high > medium);
		assert.ok(off < medium);
	});

	it("uses medium baseline when no samples", () => {
		const s = shape({ avgOutput: 0, lastOutput: 0, outputSamples: 0 });
		// base 800 * (high / medium)
		assert.equal(expectedOutputTokens(s, "off", "high"), Math.round(800 * (3.5 / 1.8)));
	});

	it("falls back to lastOutput when avg is zero but last is set", () => {
		const s = shape({ avgOutput: 0, lastOutput: 400, outputSamples: 0 });
		assert.equal(expectedOutputTokens(s, "medium", "medium"), Math.round(400 * (1.8 / 1.8)));
	});

	it("enforces a 64-token floor", () => {
		const s = shape({ avgOutput: 10, lastOutput: 10, outputSamples: 1 });
		assert.equal(expectedOutputTokens(s, "high", "off"), 64);
	});
});

describe("collectPromptShape-like pure helpers", () => {
	it("cache hit fixture: hit rate from usage", () => {
		const cacheable = cacheableFromUsage(1_000, 9_000, 0);
		assert.equal(cacheable, 10_000);
		assert.equal(hitRateFromUsage(9_000, cacheable), 0.9);
	});

	it("full miss fixture: zero cache read → zero hit rate", () => {
		const cacheable = cacheableFromUsage(10_000, 0, 0);
		assert.equal(cacheable, 10_000);
		assert.equal(hitRateFromUsage(0, cacheable), 0);
	});

	it("aborted/error skipped fixture: empty usage yields zero cacheable and zero hit", () => {
		// After skipping aborted/error assistants, no usage fields remain.
		const cacheable = cacheableFromUsage(0, 0, 0);
		assert.equal(cacheable, 0);
		assert.equal(hitRateFromUsage(0, cacheable), 0);
	});
});

describe("rankModels filter/rank", () => {
	const models: ModelLike[] = [
		model({ provider: "anthropic", id: "claude-sonnet", cost: { input: 3 } }),
		model({ provider: "openai", id: "gpt-4o", cost: { input: 2.5 } }),
		model({ provider: "openai", id: "gpt-4o-mini", cost: { input: 0.15 } }),
		model({ provider: "anthropic", id: "claude-haiku", cost: { input: 0.8 } }),
		model({ provider: "google", id: "gemini-flash", name: "Gemini Flash", cost: { input: 0.1 } }),
	];

	it("puts current model first", () => {
		const current = models[1]; // openai/gpt-4o
		const ranked = rankModels(models, current, "");
		assert.equal(`${ranked[0].provider}/${ranked[0].id}`, "openai/gpt-4o");
	});

	it("prefers same provider after current", () => {
		const current = models[1]; // openai/gpt-4o
		const ranked = rankModels(models, current, "");
		// After current: other openai models before other providers
		assert.equal(ranked[0].provider, "openai");
		assert.equal(ranked[1].provider, "openai");
		assert.equal(ranked[1].id, "gpt-4o-mini");
	});

	it("sorts by input cost within provider group", () => {
		const ranked = rankModels(models, undefined, "");
		// No current: cost ascending overall among groups (all "other provider")
		const costs = ranked.map((m) => m.cost.input ?? 0);
		assert.deepEqual(costs, [...costs].sort((a, b) => a - b));
	});

	it("filters by free-text query", () => {
		const ranked = rankModels(models, undefined, "claude");
		assert.equal(ranked.length, 2);
		assert.ok(ranked.every((m) => m.id.includes("claude") || m.provider === "anthropic"));
	});

	it("filters by multi-part query (all parts must match haystack)", () => {
		const ranked = rankModels(models, undefined, "openai mini");
		assert.equal(ranked.length, 1);
		assert.equal(ranked[0].id, "gpt-4o-mini");
	});

	it("matches display name", () => {
		const ranked = rankModels(models, undefined, "gemini flash");
		assert.equal(ranked.length, 1);
		assert.equal(ranked[0].id, "gemini-flash");
	});
});

describe("isPriced / estimateTurn priced flag", () => {
	it("isPriced is false for all-zero rates", () => {
		assert.equal(isPriced({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), false);
	});

	it("isPriced is true when any rate is positive", () => {
		assert.equal(isPriced({ input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }), true);
	});

	it("estimateTurn marks subscription models unpriced", () => {
		const est = estimateTurn(
			model({ id: "sub", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
			shape(),
			"medium",
			"medium",
		);
		assert.equal(est.priced, false);
		assert.equal(est.hit, 0);
	});
});

describe("cross-model warm-hit policy (#3)", () => {
	it("default estimateTurn keeps warm hit below cold", () => {
		const est = estimateTurn(model({ id: "m" }), shape({ hitRate: 0.9 }), "medium", "medium");
		assert.ok(est.hit < est.coldBase);
		assert.equal(est.inputHit, hitInputCost(10_000, 0.9, BASE_RATES));
	});

	it("assumeWarmCache:false forces hit = coldBase (no transferable cache)", () => {
		const warm = estimateTurn(model({ id: "m" }), shape({ hitRate: 0.9 }), "medium", "medium");
		const cold = estimateTurn(model({ id: "m" }), shape({ hitRate: 0.9 }), "medium", "medium", {
			assumeWarmCache: false,
		});
		assert.equal(cold.hit, cold.coldBase);
		assert.equal(cold.inputHit, cold.inputColdBase);
		assert.ok(cold.hit > warm.hit);
		// Output / tax unchanged by cache-transfer policy
		assert.equal(cold.output, warm.output);
		assert.equal(cold.taxBase, warm.taxBase);
	});

	it("estimateDescription shows n/a hit when warmHit:false", () => {
		const est = estimateTurn(model({ id: "m" }), shape(), "medium", "medium", {
			assumeWarmCache: false,
		});
		const desc = estimateDescription(est, { emphasizeCold: true, warmHit: false });
		assert.match(desc, /^n\/a hit · /);
		assert.match(desc, /cold ← risk/);
		assert.doesNotMatch(desc, /\$[\d.]+ hit/);
	});

	it("estimateDescription still shows $ hit for current/warm path", () => {
		const est = estimateTurn(model({ id: "m" }), shape(), "medium", "medium");
		const desc = estimateDescription(est);
		assert.match(desc, /\$[\d.]+ hit/);
		assert.doesNotMatch(desc, /n\/a hit/);
	});
});

describe("clampThinkingToSupported (#4)", () => {
	it("keeps supported level unchanged", () => {
		assert.equal(clampThinkingToSupported("high", ["off", "low", "medium", "high"]), "high");
	});

	it("clamps unsupported high down to nearest available", () => {
		// Prefer nearest at-or-above, then below — high not supported → xhigh missing → medium
		assert.equal(clampThinkingToSupported("high", ["off", "low", "medium"]), "medium");
	});

	it("non-reasoning models only support off", () => {
		assert.equal(clampThinkingToSupported("xhigh", ["off"]), "off");
		assert.equal(clampThinkingToSupported("medium", ["off"]), "off");
	});

	it("empty supported list falls back to off", () => {
		assert.equal(clampThinkingToSupported("high", []), "off");
	});

	it("estimate with clamped thinking reduces expectedOut vs unsupported high", () => {
		const s = shape({ avgOutput: 1800, outputSamples: 4 });
		const supported: ThinkingLevel[] = ["off", "low", "medium"];
		const requested: ThinkingLevel = "high";
		const clamped = clampThinkingToSupported(requested, supported);
		assert.equal(clamped, "medium");

		const unclamped = estimateTurn(model({ id: "m" }), s, requested, "medium");
		const clampedEst = estimateTurn(model({ id: "m" }), s, clamped, "medium");
		assert.ok(clampedEst.expectedOut < unclamped.expectedOut);
		assert.equal(clampedEst.expectedOut, expectedOutputTokens(s, "medium", "medium"));
	});
});

describe("estimateDescription tax label (#7)", () => {
	it("priced models keep tax +$ prefix", () => {
		const est = estimateTurn(model({ id: "m" }), shape(), "medium", "medium");
		const desc = estimateDescription(est);
		assert.match(desc, /tax \+\$/);
	});

	it("unpriced models use tax sub without +", () => {
		const est = estimateTurn(
			model({ id: "sub", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
			shape(),
			"medium",
			"medium",
		);
		const desc = estimateDescription(est);
		assert.match(desc, /tax sub/);
		assert.doesNotMatch(desc, /tax \+sub/);
	});
});

describe("format helpers", () => {
	it("formatTokens buckets", () => {
		assert.equal(formatTokens(0), "0");
		assert.equal(formatTokens(42), "42");
		assert.equal(formatTokens(1500), "1.5k");
		assert.equal(formatTokens(25_000), "25k");
		assert.equal(formatTokens(2_500_000), "2.50M");
	});

	it("formatUsd shows sub when unpriced", () => {
		assert.equal(formatUsd(1.23, false), "sub");
		assert.equal(formatUsdRange(1, 2, false), "sub");
		assert.equal(formatUsd(0, true), "$0");
		assert.equal(formatUsd(0.0004, true), "$0.0004");
		assert.equal(formatUsd(0.005, true), "$0.005"); // former <0.01 branch, same 3dp as <1
		assert.equal(formatUsd(0.5, true), "$0.500");
		assert.equal(formatUsd(1.5, true), "$1.50");
	});

	it("formatPct", () => {
		assert.equal(formatPct(0), "0%");
		assert.equal(formatPct(0.85), "85%");
	});
});
