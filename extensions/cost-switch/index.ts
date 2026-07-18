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
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	DynamicBorder,
	estimateTokens,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

import {
	type PromptShape,
	type ThinkingLevel,
	type TurnEstimate,
	estimateDescription,
	estimateTurn,
	isPriced,
	modelKey,
	resolveRates,
} from "./estimate.ts";
import { formatTokens, formatUsd, formatUsdRange } from "./format.ts";
import {
	DEFAULT_ASSUMED_HIT_RATE,
	formatHitRateDisplay,
} from "./hit-rate.ts";
import { rankModels } from "./rank.ts";

/** Bridge pi ModelThinkingLevel into our effort-multiplier union (includes "max"). */
function asThinking(level: ModelThinkingLevel | string): ThinkingLevel {
	return level as ThinkingLevel;
}

/** Bridge back to the API type accepted by setThinkingLevel. */
function toApiThinking(level: ThinkingLevel): ModelThinkingLevel {
	return level as ModelThinkingLevel;
}

// Re-export pure helpers for tests / external consumers.
export {
	EFFORT_MULT,
	THINKING_LEVEL_ORDER,
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
	modelKey,
	resolveRates,
	writeColdInputCost,
} from "./estimate.ts";
export { formatPct, formatTokens, formatUsd, formatUsdRange } from "./format.ts";
export {
	DEFAULT_ASSUMED_HIT_RATE,
	MAX_HIT_RATE,
	formatHitRateDisplay,
	resolveHitRate,
} from "./hit-rate.ts";
export { rankModels } from "./rank.ts";
export type {
	CostRates,
	EstimateDescriptionOptions,
	EstimateTurnOptions,
	ModelLike,
	PromptShape,
	ThinkingLevel,
	TurnEstimate,
} from "./estimate.ts";

interface Candidate {
	model: Model<Api>;
	label: string;
	description: string;
	estimate: TurnEstimate;
	isCurrent: boolean;
}

/**
 * Rough token estimate for the LLM-visible context path.
 * Used when getContextUsage().tokens is null (right after compaction,
 * before the next assistant response has trustworthy usage).
 */
function estimateActiveContextTokens(ctx: ExtensionContext): number {
	try {
		const entries = ctx.sessionManager.buildContextEntries();
		let total = 0;
		for (const entry of entries) {
			for (const msg of sessionEntryToContextMessages(entry)) {
				total += estimateTokens(msg);
			}
		}
		return total;
	} catch {
		return 0;
	}
}

function collectPromptShape(ctx: ExtensionContext): PromptShape {
	const usage = ctx.getContextUsage();
	// tokens may be null after compaction until the next LLM response.
	let nextTokens = usage?.tokens != null && usage.tokens > 0 ? usage.tokens : 0;

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
	// After compaction, last assistant usage is pre-compact and overstates size.
	if (nextTokens <= 0 && usage?.tokens === null) {
		const estimated = estimateActiveContextTokens(ctx);
		if (estimated > 0) {
			nextTokens = estimated;
			// Compaction replaces the cached prefix with a new summary.
			cacheableTokens = estimated;
			lastCacheRead = 0;
		}
	}
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
		// Clamp session thinking to what this candidate actually supports (#4).
		const clampedThinking = asThinking(clampThinkingLevel(model, toApiThinking(thinking)));
		// Non-current models do not retain prompt cache — hit is cold / n/a (#3).
		const estimate = estimateTurn(model, shape, clampedThinking, thinking, {
			assumeWarmCache: isCurrent,
		});
		const label = isCurrent ? `${model.provider}/${model.id} (current)` : `${model.provider}/${model.id}`;
		const rates = resolveRates(model, shape.nextTokens);
		const rateBit = isPriced(rates)
			? `in $${rates.input}/M out $${rates.output}/M`
			: "subscription / unpriced";
		const thinkNote =
			!isCurrent && clampedThinking !== thinking ? ` · est@${clampedThinking}` : "";
		return {
			model,
			label,
			description: `${estimateDescription(estimate, {
				emphasizeCold: !isCurrent,
				warmHit: isCurrent,
			})}${thinkNote} · ${rateBit}`,
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
	/** Bumped on each apply so a deferred release cannot clear a newer suppression window. */
	let suppressToken = 0;

	function beginSuppressNotices(): number {
		const token = ++suppressToken;
		suppressNotices = true;
		return token;
	}

	/**
	 * Release suppression after void-emitted thinking_level_select handlers can run.
	 *
	 * Pi awaits model_select but fire-and-forgets thinking_level_select:
	 *   void this._extensionRunner.emit({ type: "thinking_level_select", ... })
	 * setModel also clamps thinking via setThinkingLevel before model_select.
	 * A macrotask is enough for those promise chains to observe suppressNotices.
	 */
	function endSuppressNotices(token: number): void {
		setTimeout(() => {
			if (suppressToken === token) {
				suppressNotices = false;
			}
		}, 0);
	}

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
		const thinking = asThinking(pi.getThinkingLevel());
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
		const thinking = asThinking(pi.getThinkingLevel());
		const shape = collectPromptShape(ctx);
		const candidates = buildCandidates(models, ctx.model, shape, thinking, filter, 25);

		const lines = [
			"Next-turn cost estimate (heuristic)",
			summarizeShape(shape, ctx.model, thinking),
			"",
			`hit = warm continuation for the *current* model (or ~${(DEFAULT_ASSUMED_HIT_RATE * 100).toFixed(0)}% assumed when unknown)`,
			"hit = n/a for other models (prompt cache does not transfer across models/providers)",
			"cold = base uncached total through cache-write-premium upper bound",
			"tax = extra cost from re-billing only the previous cacheable prefix",
			"thinking is clamped per model to its supported levels",
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

		const currentThinking = asThinking(pi.getThinkingLevel());
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
		const levels = getSupportedThinkingLevels(model).map(asThinking);
		// Prefer pi-ai clamp over ad-hoc medium/low/first fallbacks (#4 / #7).
		let nextThinking = asThinking(clampThinkingLevel(model, toApiThinking(currentThinking)));
		if (levels.length > 1) {
			const thinkingItems: SelectItem[] = levels.map((level) => {
				const est = estimateTurn(model, shape, level, currentThinking, {
					assumeWarmCache: !switchingModel,
				});
				const isCur =
					model.provider === ctx.model?.provider &&
					model.id === ctx.model?.id &&
					level === currentThinking;
				const cacheRisk = switchingModel || level !== currentThinking;
				return {
					value: level,
					label: isCur ? `${level} (current)` : level,
					description: estimateDescription(est, {
						emphasizeCold: cacheRisk,
						warmHit: !switchingModel,
					}),
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
			nextThinking = asThinking(levelPicked);
		}


		const finalEst = estimateTurn(model, shape, nextThinking, currentThinking, {
			assumeWarmCache: !switchingModel,
		});
		const changingThinking = nextThinking !== currentThinking;
		const cacheRisk = switchingModel || changingThinking;

		const token = beginSuppressNotices();
		try {
			const ok = await pi.setModel(model);
			if (!ok) {
				ctx.ui.notify(`No API key / failed to set ${provider}/${modelId}`, "error");
				return;
			}
			pi.setThinkingLevel(toApiThinking(nextThinking));
		} finally {
			endSuppressNotices(token);
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
						`hit = warm continuation for the *current* model (or ~${(DEFAULT_ASSUMED_HIT_RATE * 100).toFixed(0)}% assumed when unknown)`,
						"hit = n/a for other models (prompt cache does not transfer)",
						"cold = base-to-write-premium total",
						"tax = re-bill cost for the previous cacheable prefix",
						"thinking is clamped per model; model/reasoning changes are cache-miss risks",
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
		const thinking = asThinking(pi.getThinkingLevel());
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
		const next = estimateTurn(
			model,
			shape,
			asThinking(event.level),
			asThinking(event.previousLevel ?? event.level),
		);
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

	// Refresh after compaction so next≈/miss reflect the shrunk context
	// without waiting for the next assistant turn. Single fire (not streaming).
	pi.on("session_compact", async (_event, ctx) => {
		updateStatus(ctx);
	});
}
