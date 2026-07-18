/**
 * cost-switch — preview next-turn cost before changing model or thinking level.
 *
 * Built-in /model and thinking controls only notify after the change. This
 * extension owns a pre-change switch UX with hit vs cold estimates.
 *
 * Commands:
 *   /cost-switch [filter]     Pick model (+ thinking) with $ estimates, then apply
 *   /cost-estimate [filter]   Show comparison table without switching
 *   /cost-switch status       Toggle next-turn estimate in the status bar
 *
 * Notes:
 * - Input/cache math uses model.cost rates ($/1M), including tier thresholds.
 * - Model switch estimates use the cold (full rebill) column as the realistic case.
 * - Reasoning/output is a heuristic from recent session output × effort multipliers.
 * - Subscription / zero-priced models show "sub" instead of $0.00 spam.
 */

import type { Api, AssistantMessage, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { DEFAULT_ASSUMED_HIT_RATE, formatHitRateDisplay, resolveHitRate } from "./hit-rate.ts";
type ThinkingLevel = ModelThinkingLevel;

/** Rough output-token multipliers relative to a "medium" baseline turn. */
const EFFORT_MULT: Record<ThinkingLevel, number> = {
	off: 0.7,
	minimal: 0.9,
	low: 1.2,
	medium: 1.8,
	high: 3.5,
	xhigh: 6.5,
	max: 11,
};

interface CostRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

interface PromptShape {
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

interface TurnEstimate {
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

interface Candidate {
	model: Model<Api>;
	label: string;
	description: string;
	estimate: TurnEstimate;
	isCurrent: boolean;
}

function formatTokens(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1000) return String(Math.round(n));
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatUsd(n: number, priced: boolean): string {
	if (!priced) return "sub";
	if (!Number.isFinite(n) || n < 0) return "?";
	if (n === 0) return "$0";
	if (n < 0.001) return `$${n.toFixed(4)}`;
	if (n < 0.01) return `$${n.toFixed(3)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}

function formatUsdRange(min: number, max: number, priced: boolean): string {
	if (!priced) return "sub";
	const low = Math.min(min, max);
	const high = Math.max(min, max);
	if (Math.abs(high - low) < 0.0005) return formatUsd(high, true);
	return `${formatUsd(low, true)}–${formatUsd(high, true)}`;
}
function modelKey(model: Model<Api> | undefined): string {
	if (!model) return "none";
	return `${model.provider}/${model.id}`;
}

function resolveRates(model: Model<Api>, promptTokens: number): CostRates {
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

function isPriced(rates: CostRates): boolean {
	return rates.input > 0 || rates.output > 0 || rates.cacheRead > 0 || rates.cacheWrite > 0;
}

/** Full next request input at normal uncached-input pricing. */
function baseColdInputCost(promptTokens: number, rates: CostRates): number {
	return (promptTokens * rates.input) / 1_000_000;
}

/** Full next request input if a provider applies its cache-write premium. */
function writeColdInputCost(promptTokens: number, rates: CostRates): number {
	const writeRate = Math.max(rates.input, rates.cacheWrite);
	return (promptTokens * writeRate) / 1_000_000;
}

/** Extra input cost when a previously cacheable prefix is re-billed. */
function cacheTax(cacheableTokens: number, paidRate: number, readRate: number): number {
	return (cacheableTokens * Math.max(0, paidRate - readRate)) / 1_000_000;
}

/**
 * Hit input: apply resolved hit rate; residual at uncached input.
 * Observed 0 is unknown — resolveHitRate assumes DEFAULT_ASSUMED_HIT_RATE.
 */
function hitInputCost(promptTokens: number, hitRate: number, rates: CostRates): number {
	const { rate } = resolveHitRate(hitRate);
	const cached = Math.floor(promptTokens * rate);
	const uncached = Math.max(0, promptTokens - cached);
	return (cached * rates.cacheRead + uncached * rates.input) / 1_000_000;
}

function expectedOutputTokens(shape: PromptShape, fromLevel: ThinkingLevel, toLevel: ThinkingLevel): number {
	const base = shape.avgOutput > 0 ? shape.avgOutput : shape.lastOutput > 0 ? shape.lastOutput : 800;
	const fromMult = EFFORT_MULT[fromLevel] ?? 1.8;
	const toMult = EFFORT_MULT[toLevel] ?? 1.8;
	// Scale relative to current level's observed output when we have samples.
	const scaled = shape.outputSamples > 0 ? base * (toMult / fromMult) : base * (toMult / EFFORT_MULT.medium);
	return Math.max(64, Math.round(scaled));
}

function estimateTurn(
	model: Model<Api>,
	shape: PromptShape,
	thinking: ThinkingLevel,
	currentThinking: ThinkingLevel,
): TurnEstimate {
	const rates = resolveRates(model, shape.nextTokens);
	const priced = isPriced(rates);
	const expectedOut = expectedOutputTokens(shape, currentThinking, thinking);
	const inputHit = hitInputCost(shape.nextTokens, shape.hitRate, rates);
	const inputColdBase = baseColdInputCost(shape.nextTokens, rates);
	const inputColdWrite = writeColdInputCost(shape.nextTokens, rates);
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

function collectPromptShape(ctx: ExtensionContext): PromptShape {
	const usage = ctx.getContextUsage();
	let nextTokens = usage?.tokens && usage.tokens > 0 ? usage.tokens : 0;

	let lastInput = 0;
	let lastCacheRead = 0;
	let lastCacheWrite = 0;
	let lastOutput = 0;
	let sumOutput = 0;
	let outputSamples = 0;

	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as SessionEntry;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const msg = entry.message as AssistantMessage;
		if (msg.stopReason === "aborted" || msg.stopReason === "error") continue;
		const u = msg.usage;
		if (!u) continue;

		if (lastOutput === 0 && (u.output ?? 0) > 0) {
			lastOutput = u.output ?? 0;
			lastInput = u.input ?? 0;
			lastCacheRead = u.cacheRead ?? 0;
			lastCacheWrite = u.cacheWrite ?? 0;
		}
		if ((u.output ?? 0) > 0) {
			sumOutput += u.output ?? 0;
			outputSamples += 1;
		}
	}

	let cacheableTokens = lastInput + lastCacheRead + lastCacheWrite;
	if (nextTokens <= 0) nextTokens = cacheableTokens;
	if (nextTokens <= 0) nextTokens = 4_000;
	if (cacheableTokens <= 0) cacheableTokens = nextTokens;

	const hitRate = cacheableTokens > 0 ? lastCacheRead / cacheableTokens : 0;
	const avgOutput = outputSamples > 0 ? sumOutput / outputSamples : lastOutput;

	return {
		nextTokens,
		cacheableTokens,
		hitRate,
		lastOutput,
		avgOutput,
		outputSamples,
	};
}

function estimateDescription(est: TurnEstimate, opts?: { emphasizeCold?: boolean }): string {
	const riskMark = opts?.emphasizeCold ? " ← risk" : "";
	const cold = formatUsdRange(est.coldBase, est.coldWrite, est.priced);
	const tax = formatUsdRange(est.taxBase, est.taxWrite, est.priced);
	return `${formatUsd(est.hit, est.priced)} hit · ${cold} cold${riskMark} · tax +${tax} · ~${formatTokens(est.expectedOut)} out`;
}

function rankModels(models: Model<Api>[], current: Model<Api> | undefined, filter: string): Model<Api>[] {
	const q = filter.trim().toLowerCase();
	let list = models;
	if (q) {
		list = list.filter((m) => {
			const hay = `${m.provider}/${m.id} ${m.name ?? ""}`.toLowerCase();
			return hay.includes(q) || q.split(/\s+/).every((part) => hay.includes(part));
		});
	}

	const currentProvider = current?.provider;
	return [...list].sort((a, b) => {
		const aCur = current && a.provider === current.provider && a.id === current.id ? 0 : 1;
		const bCur = current && b.provider === current.provider && b.id === current.id ? 0 : 1;
		if (aCur !== bCur) return aCur - bCur;
		const aProv = currentProvider && a.provider === currentProvider ? 0 : 1;
		const bProv = currentProvider && b.provider === currentProvider ? 0 : 1;
		if (aProv !== bProv) return aProv - bProv;
		const aCost = a.cost?.input ?? 0;
		const bCost = b.cost?.input ?? 0;
		if (aCost !== bCost) return aCost - bCost;
		return `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`);
	});
}

function buildCandidates(
	models: Model<Api>[],
	current: Model<Api> | undefined,
	shape: PromptShape,
	thinking: ThinkingLevel,
	filter: string,
	limit = 40,
): Candidate[] {
	const ranked = rankModels(models, current, filter).slice(0, limit);
	return ranked.map((model) => {
		const isCurrent = !!current && model.provider === current.provider && model.id === current.id;
		const estimate = estimateTurn(model, shape, thinking, thinking);
		const label = isCurrent ? `${model.provider}/${model.id} (current)` : `${model.provider}/${model.id}`;
		const rates = resolveRates(model, shape.nextTokens);
		const rateBit = isPriced(rates)
			? `in $${rates.input}/M out $${rates.output}/M`
			: "subscription / unpriced";
		return {
			model,
			label,
			description: `${estimateDescription(estimate, { emphasizeCold: !isCurrent })} · ${rateBit}`,
			estimate,
			isCurrent,
		};
	});
}

async function showSelectList(
	ctx: ExtensionContext,
	title: string,
	subtitle: string,
	items: SelectItem[],
): Promise<string | null> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		// Fallback for non-TUI: plain select of labels.
		const labels = items.map((i) => `${i.label} — ${i.description ?? ""}`);
		const picked = await ctx.ui.select(title, labels);
		if (!picked) return null;
		const idx = labels.indexOf(picked);
		return idx >= 0 ? items[idx].value : null;
	}

	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title))));
		if (subtitle) {
			container.addChild(new Text(theme.fg("dim", subtitle)));
		}

		const selectList = new SelectList(items, Math.min(items.length, 12), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "type to filter · ↑↓ · enter select · esc cancel")));
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

function summarizeShape(shape: PromptShape, current: Model<Api> | undefined, thinking: ThinkingLevel): string {
	const cur = current ? estimateTurn(current, shape, thinking, thinking) : undefined;
	const curBit = cur
		? `current ${formatUsd(cur.hit, cur.priced)} hit / ${formatUsdRange(cur.coldBase, cur.coldWrite, cur.priced)} cold`
		: "no model";
	return `next ${formatTokens(shape.nextTokens)} · cacheable ${formatTokens(shape.cacheableTokens)} · hit ${formatHitRateDisplay(shape.hitRate)} · think ${thinking} · ${curBit}`;
}

export default function costSwitchExtension(pi: ExtensionAPI) {
	let showStatus = true;
	/** Suppress post-change toasts while /cost-switch applies model+thinking. */
	let suppressNotices = false;

	function updateStatus(ctx: ExtensionContext): void {
		if (!showStatus) {
			ctx.ui.setStatus("cost-switch", undefined);
			return;
		}
		const model = ctx.model;
		if (!model) {
			ctx.ui.setStatus("cost-switch", undefined);
			return;
		}
		const thinking = pi.getThinkingLevel();
		const shape = collectPromptShape(ctx);
		const est = estimateTurn(model, shape, thinking, thinking);
		const text = `next≈${formatUsd(est.hit, est.priced)} · miss ${formatUsd(est.coldBase, est.priced)} · hit ${formatHitRateDisplay(shape.hitRate)}`;
		ctx.ui.setStatus("cost-switch", ctx.ui.theme.fg("dim", text));
	}

	async function runEstimate(ctx: ExtensionContext, filter: string): Promise<void> {
		const models = ctx.modelRegistry.getAvailable();
		if (models.length === 0) {
			ctx.ui.notify("No available models (check auth / model list)", "warning");
			return;
		}
		const thinking = pi.getThinkingLevel();
		const shape = collectPromptShape(ctx);
		const candidates = buildCandidates(models, ctx.model, shape, thinking, filter, 25);

		const lines = [
			"Next-turn cost estimate (heuristic)",
			summarizeShape(shape, ctx.model, thinking),
			"",
			`hit = warm continuation at observed cache hit rate (or ~${(DEFAULT_ASSUMED_HIT_RATE * 100).toFixed(0)}% assumed when unknown)`,
			"cold = base uncached total through cache-write-premium upper bound",
			"tax = extra cost from re-billing only the previous cacheable prefix",
			"output = session-average output scaled by thinking effort",
			"",
		];
		for (const c of candidates.slice(0, 15)) {
			const mark = c.isCurrent ? "*" : " ";
			lines.push(`${mark} ${c.label}`);
			lines.push(`    ${c.description}`);
		}
		if (candidates.length > 15) {
			lines.push(`… ${candidates.length - 15} more (narrow with /cost-estimate <filter>)`);
		}
		lines.push("");
		lines.push("Switch with /cost-switch [filter]");

		// Prefer a compact notify-friendly summary; dump full table via custom when TUI.
		if (ctx.mode === "tui") {
			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
				for (const line of lines) {
					const colored =
						line.startsWith("*") || line.startsWith("Next-turn")
							? theme.fg("accent", line)
							: line.startsWith("hit =") || line.startsWith("cold =") || line.startsWith("output =")
								? theme.fg("dim", line)
								: line;
					container.addChild(new Text(colored));
				}
				container.addChild(new Text(theme.fg("dim", "press any key / esc to close")));
				container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
				return {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput() {
						done();
					},
				};
			});
		} else {
			ctx.ui.notify(lines.slice(0, 12).join("\n"), "info");
		}
	}

	async function runSwitch(ctx: ExtensionContext, filter: string): Promise<void> {
		const models = ctx.modelRegistry.getAvailable();
		if (models.length === 0) {
			ctx.ui.notify("No available models (check auth / model list)", "warning");
			return;
		}

		const currentThinking = pi.getThinkingLevel();
		const shape = collectPromptShape(ctx);
		const candidates = buildCandidates(models, ctx.model, shape, currentThinking, filter, 50);
		if (candidates.length === 0) {
			ctx.ui.notify(`No models match filter "${filter}"`, "warning");
			return;
		}

		const items: SelectItem[] = candidates.map((c) => ({
			value: `${c.model.provider}::${c.model.id}`,
			label: c.label,
			description: c.description,
		}));

		const picked = await showSelectList(
			ctx,
			"Cost switch — pick model",
			summarizeShape(shape, ctx.model, currentThinking),
			items,
		);
		if (!picked) return;

		const [provider, ...rest] = picked.split("::");
		const modelId = rest.join("::");
		const model = ctx.modelRegistry.find(provider, modelId);
		if (!model) {
			ctx.ui.notify(`Model not found: ${provider}/${modelId}`, "error");
			return;
		}

		const switchingModel =
			!ctx.model || model.provider !== ctx.model.provider || model.id !== ctx.model.id;
		const levels = getSupportedThinkingLevels(model);
		let nextThinking: ThinkingLevel = currentThinking;
		if (levels.length > 1) {
			if (!levels.includes(nextThinking)) {
				nextThinking = levels.includes("medium")
					? "medium"
					: levels.includes("low")
						? "low"
						: levels[0];
			}
			const thinkingItems: SelectItem[] = levels.map((level) => {
				const est = estimateTurn(model, shape, level, currentThinking);
				const isCur =
					model.provider === ctx.model?.provider &&
					model.id === ctx.model?.id &&
					level === currentThinking;
				const cacheRisk = switchingModel || level !== currentThinking;
				return {
					value: level,
					label: isCur ? `${level} (current)` : level,
					description: estimateDescription(est, { emphasizeCold: cacheRisk }),
				};
			});

			const levelPicked = await showSelectList(
				ctx,
				`Thinking for ${provider}/${modelId}`,
				switchingModel
					? `Model switch may re-bill ~${formatTokens(shape.cacheableTokens)} cached tokens (next ~${formatTokens(shape.nextTokens)})`
					: `Reasoning change may re-bill ~${formatTokens(shape.cacheableTokens)} cached tokens (next ~${formatTokens(shape.nextTokens)})`,
				thinkingItems,
			);
			if (!levelPicked) return;
			nextThinking = levelPicked as ThinkingLevel;
		} else {
			nextThinking = levels[0] ?? "off";
		}

		const finalEst = estimateTurn(model, shape, nextThinking, currentThinking);
		const changingThinking = nextThinking !== currentThinking;
		const cacheRisk = switchingModel || changingThinking;

		suppressNotices = true;
		try {
			const ok = await pi.setModel(model);
			if (!ok) {
				ctx.ui.notify(`No API key / failed to set ${provider}/${modelId}`, "error");
				return;
			}
			pi.setThinkingLevel(nextThinking);
		} finally {
			suppressNotices = false;
		}

		if (cacheRisk) {
			const reason = switchingModel ? "model-switch" : "reasoning-change";
			ctx.ui.notify(
				`Switched to ${provider}/${modelId} @ ${nextThinking} · next≈ ${formatUsdRange(finalEst.coldBase, finalEst.coldWrite, finalEst.priced)} cold ${reason} risk · tax +${formatUsdRange(finalEst.taxBase, finalEst.taxWrite, finalEst.priced)} · warm ${formatUsd(finalEst.hit, finalEst.priced)}`,
				"info",
			);
		} else {
			ctx.ui.notify(
				`Kept ${provider}/${modelId} @ ${nextThinking} · next≈ ${formatUsd(finalEst.hit, finalEst.priced)} hit`,
				"info",
			);
		}
		updateStatus(ctx);
	}

	pi.registerCommand("cost-switch", {
		description: "Preview next-turn $ then switch model/thinking",
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			if (raw === "status") {
				showStatus = !showStatus;
				updateStatus(ctx);
				ctx.ui.notify(
					showStatus ? "cost-switch status: on" : "cost-switch status: off",
					"info",
				);
				return;
			}
			if (raw === "help" || raw === "--help" || raw === "-h") {
				ctx.ui.notify(
					[
						"/cost-switch [filter]  — pick model + thinking with $ estimates",
						"/cost-estimate [filter] — comparison table only",
						"/cost-switch status   — toggle status-bar next≈ estimate",
						"",
						`hit = warm continuation at observed rate (or ~${(DEFAULT_ASSUMED_HIT_RATE * 100).toFixed(0)}% assumed when unknown)`,
						"cold = base-to-write-premium total",
						"tax = re-bill cost for the previous cacheable prefix",
						"model/reasoning changes are treated as cache-miss risks",
						"output scales from session averages × thinking effort",
					].join("\n"),
					"info",
				);
				return;
			}
			await runSwitch(ctx, raw);
		},
	});

	pi.registerCommand("cost-estimate", {
		description: "Show next-turn cost estimates without switching",
		handler: async (args, ctx) => {
			await runEstimate(ctx, (args ?? "").trim());
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		// After built-in /model: show what the next turn is likely to cost now.
		const thinking = pi.getThinkingLevel();
		const shape = collectPromptShape(ctx);
		const next = estimateTurn(event.model, shape, thinking, thinking);
		const prev = event.previousModel
			? estimateTurn(event.previousModel, shape, thinking, thinking)
			: undefined;
		if (!suppressNotices && event.source !== "restore") {
			const prevBit = prev ? ` (previous warm ${formatUsd(prev.hit, prev.priced)})` : "";
			ctx.ui.notify(
				`Model ${modelKey(event.previousModel)} → ${modelKey(event.model)} · next≈ ${formatUsdRange(next.coldBase, next.coldWrite, next.priced)} cold / ${formatUsd(next.hit, next.priced)} warm · tax +${formatUsdRange(next.taxBase, next.taxWrite, next.priced)}${prevBit}`,
				"info",
			);
		}
		updateStatus(ctx);
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		const model = ctx.model;
		if (!model) return;
		const shape = collectPromptShape(ctx);
		const next = estimateTurn(model, shape, event.level, event.previousLevel ?? event.level);
		if (!suppressNotices) {
			ctx.ui.notify(
				`Thinking ${event.previousLevel ?? "?"} → ${event.level} · next≈ ${formatUsdRange(next.coldBase, next.coldWrite, next.priced)} cold-risk / ${formatUsd(next.hit, next.priced)} warm · tax +${formatUsdRange(next.taxBase, next.taxWrite, next.priced)} · ~${formatTokens(next.expectedOut)} out`,
				"info",
			);
		}
		updateStatus(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role === "assistant") {
			updateStatus(ctx);
		}
	});
}
