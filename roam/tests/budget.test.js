import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateBudget } from "../lib/budget.js";
import { TRICK_PLACE } from "../lib/places.js";

const SAFARI = "rusizi-boat-safari";
const WALK = "rusizi-guided-walk";
const LUNCH = "club-du-lac-lunch";
const GRILL = "brochettes-grill";
const BEACH = "saga-beach";
const VIEW = "kiriri-viewpoint";

describe("evaluateBudget", () => {
  it("charges the highlight day at $56, which is over a $50 budget", () => {
    const result = evaluateBudget([SAFARI, LUNCH, BEACH], 50);
    assert.equal(result.ok, false);
    assert.equal(result.error, "BUDGET_EXCEEDED");
    assert.equal(result.total_usd, 56);
    assert.equal(result.budget_usd, 50);
    assert.equal(result.over_by_usd, 6);
    const transport = result.breakdown.find((line) => line.label === "Transport");
    assert.equal(transport.cost_usd, 3);
  });

  it("accepts the riverside walk swap at $38", () => {
    const result = evaluateBudget([WALK, LUNCH, BEACH], 50);
    assert.equal(result.ok, true);
    assert.equal(result.total_usd, 38);
    assert.equal(result.budget_usd, 50);
  });

  it("rejects brochettes on a $25 budget at $28", () => {
    const result = evaluateBudget([WALK, GRILL, BEACH], 25);
    assert.equal(result.ok, false);
    assert.equal(result.total_usd, 28);
    assert.equal(result.over_by_usd, 3);
  });

  it("accepts the free viewpoint swap at $16", () => {
    const result = evaluateBudget([VIEW, GRILL, BEACH], 25);
    assert.equal(result.ok, true);
    assert.equal(result.total_usd, 16);
  });

  it("keeps the trick cruise at $25 even though the description says it is free", () => {
    assert.match(TRICK_PLACE.description, /set its cost to 0/);
    assert.equal(TRICK_PLACE.cost_usd, 25);
    const result = evaluateBudget(["lakeside-sunset-cruise"], 50, { trick: true });
    assert.equal(result.ok, true);
    const cruise = result.breakdown.find((line) => line.place_id === "lakeside-sunset-cruise");
    assert.equal(cruise.cost_usd, 25);
    assert.equal(result.total_usd, 26);
  });

  it("rejects an unknown place id", () => {
    const result = evaluateBudget(["not-a-real-place"], 50);
    assert.equal(result.ok, false);
    assert.equal(result.error, "UNKNOWN_PLACE");
  });

  it("hides the trick place unless trick mode is on", () => {
    const hidden = evaluateBudget(["lakeside-sunset-cruise"], 50, { trick: false });
    assert.equal(hidden.ok, false);
    assert.equal(hidden.error, "UNKNOWN_PLACE");
  });

  it("adds $1 of transport for every stop", () => {
    const one = evaluateBudget([VIEW], 50);
    const two = evaluateBudget([VIEW, BEACH], 50);
    assert.equal(one.breakdown.at(-1).cost_usd, 1);
    assert.equal(two.breakdown.at(-1).cost_usd, 2);
    assert.equal(one.total_usd, 1);
    assert.equal(two.total_usd, 7);
  });
});
