import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_ASSUMED_HIT_RATE,
	MAX_HIT_RATE,
	formatHitRateDisplay,
	resolveHitRate,
} from "./hit-rate.ts";

describe("resolveHitRate", () => {
	it("assumes the default rate when observed is 0 / unknown", () => {
		const resolved = resolveHitRate(0);
		assert.equal(resolved.assumed, true);
		assert.equal(resolved.observed, 0);
		assert.equal(resolved.rate, DEFAULT_ASSUMED_HIT_RATE);
		assert.equal(resolved.rate, 0.85);
	});

	it("assumes the default rate for non-finite observed values", () => {
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -0.1]) {
			const resolved = resolveHitRate(bad);
			assert.equal(resolved.assumed, true);
			assert.equal(resolved.rate, DEFAULT_ASSUMED_HIT_RATE);
			assert.equal(resolved.observed, 0);
		}
	});

	it("uses the observed rate when positive", () => {
		const resolved = resolveHitRate(0.72);
		assert.equal(resolved.assumed, false);
		assert.equal(resolved.observed, 0.72);
		assert.equal(resolved.rate, 0.72);
	});

	it("caps extreme observed rates", () => {
		const resolved = resolveHitRate(1);
		assert.equal(resolved.assumed, false);
		assert.equal(resolved.rate, MAX_HIT_RATE);
	});
});

describe("formatHitRateDisplay", () => {
	it("labels the assumed default instead of claiming hit 0%", () => {
		assert.equal(formatHitRateDisplay(0), "~85% (assumed)");
		assert.notEqual(formatHitRateDisplay(0), "0%");
	});

	it("shows observed rates without an assumed tag", () => {
		assert.equal(formatHitRateDisplay(0.72), "72%");
		assert.equal(formatHitRateDisplay(0.994), "99%");
	});
});
