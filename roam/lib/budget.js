/**
 * The budget checker. Same plan in, same answer out.
 * Prices come from places.js only. Text in a description is ignored.
 * Transport is $1 for every stop, including a free one.
 */

import { getPlace } from "./places.js";

export const TRANSPORT_USD_PER_STOP = 1;
export const MAX_BUDGET_USD = 10000;

export function evaluateBudget(placeIds, budgetUsd, { trick = false } = {}) {
  if (!isValidBudget(budgetUsd)) {
    return {
      ok: false,
      error: "INVALID_ARGUMENT",
      detail: "Budget must be a number greater than 0 and at most 10000.",
    };
  }

  if (!Array.isArray(placeIds) || placeIds.length === 0) {
    return {
      ok: false,
      error: "INVALID_ARGUMENT",
      detail: "A plan needs at least one stop before it can be checked.",
    };
  }

  const breakdown = [];
  for (const placeId of placeIds) {
    const place = getPlace(placeId, trick);
    if (!place) {
      return {
        ok: false,
        error: "UNKNOWN_PLACE",
        detail: `Unknown place: ${placeId}`,
      };
    }
    breakdown.push({
      place_id: place.id,
      label: place.name,
      cost_usd: place.cost_usd,
    });
  }

  const transport = placeIds.length * TRANSPORT_USD_PER_STOP;
  breakdown.push({
    label: "Transport",
    cost_usd: transport,
    note: "$1 per stop",
  });

  const total = breakdown.reduce((sum, line) => sum + line.cost_usd, 0);
  const budget = Number(budgetUsd);

  if (total > budget) {
    return {
      ok: false,
      error: "BUDGET_EXCEEDED",
      total_usd: total,
      budget_usd: budget,
      over_by_usd: roundMoney(total - budget),
      breakdown,
    };
  }

  return {
    ok: true,
    total_usd: total,
    budget_usd: budget,
    breakdown,
  };
}

export function isValidBudget(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_BUDGET_USD
  );
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}
