/**
 * Pure model filter/rank helpers for cost-switch.
 */

import type { ModelLike } from "./estimate.ts";

/**
 * Filter by free-text query, then sort: current first, same provider, cost asc, id.
 */
export function rankModels<T extends ModelLike>(
	models: T[],
	current: ModelLike | undefined,
	filter: string,
): T[] {
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
