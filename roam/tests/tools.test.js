import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createToolState, executeTool, sanitizeItinerary } from "../lib/tools.js";

const stops = [
  { place_id: "rusizi-guided-walk", time: "09:00" },
  { place_id: "club-du-lac-lunch", time: "12:30" },
  { place_id: "saga-beach", time: "15:00" },
];

describe("executeTool", () => {
  it("rejects a tool that the mode does not allow", () => {
    const result = executeTool({
      name: "check_budget",
      args: { itinerary_id: "itin_demo0001", budget_usd: 50 },
      mode: "one_tool",
      state: createToolState(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "INVALID_ARGUMENT");
  });

  it("allows search_places in one_tool mode and hides descriptions", () => {
    const result = executeTool({
      name: "search_places",
      args: { category: "beach" },
      mode: "one_tool",
      state: createToolState(),
    });
    assert.equal(result.ok, true);
    assert.ok(result.places.length >= 1);
    assert.equal("description" in result.places[0], false);
    assert.equal(result.places.every((place) => place.category === "beach"), true);
  });

  it("rejects a bad argument type", () => {
    const result = executeTool({
      name: "search_places",
      args: { max_cost: "cheap" },
      mode: "agent",
      state: createToolState(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "INVALID_ARGUMENT");
  });

  it("rejects an unknown place, an empty list, too many stops, and times out of order", () => {
    const state = createToolState();
    const unknown = executeTool({
      name: "create_itinerary",
      args: { stops: [{ place_id: "nope", time: "09:00" }] },
      mode: "agent",
      state,
    });
    assert.match(unknown.detail, /Unknown place/);

    const empty = executeTool({
      name: "create_itinerary",
      args: { stops: [] },
      mode: "agent",
      state,
    });
    assert.match(empty.detail, /at least one/);

    const tooMany = executeTool({
      name: "create_itinerary",
      args: {
        stops: ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00"].map((time) => ({
          place_id: "saga-beach",
          time,
        })),
      },
      mode: "agent",
      state,
    });
    assert.match(tooMany.detail, /6 stops/);

    const order = executeTool({
      name: "create_itinerary",
      args: {
        stops: [
          { place_id: "saga-beach", time: "15:00" },
          { place_id: "kiriri-viewpoint", time: "09:00" },
        ],
      },
      mode: "agent",
      state,
    });
    assert.match(order.detail, /in order/);
    assert.equal(state.itinerary, null);
  });

  it("rejects a budget that is not a positive number up to 10000", () => {
    const state = createToolState();
    const created = executeTool({
      name: "create_itinerary",
      args: { stops },
      mode: "agent",
      state,
    });
    const result = executeTool({
      name: "check_budget",
      args: { itinerary_id: created.itinerary_id, budget_usd: 20000 },
      mode: "agent",
      state,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "INVALID_ARGUMENT");
  });

  it("increments the revision when the plan is updated", () => {
    const state = createToolState();
    const created = executeTool({
      name: "create_itinerary",
      args: { stops },
      mode: "agent",
      state,
    });
    assert.equal(created.revision, 1);
    assert.equal(created.status, "needs_check");

    const updated = executeTool({
      name: "update_itinerary",
      args: {
        itinerary_id: created.itinerary_id,
        stops: [
          { place_id: "kiriri-viewpoint", time: "09:00" },
          { place_id: "brochettes-grill", time: "12:30" },
          { place_id: "saga-beach", time: "15:00" },
        ],
      },
      mode: "agent",
      state,
    });
    assert.equal(updated.ok, undefined);
    assert.equal(updated.itinerary_id, created.itinerary_id);
    assert.equal(updated.revision, 2);
    assert.equal(state.itinerary.revision, 2);
  });

  it("uses the data price for the trick place, not the note in the description", () => {
    const state = createToolState();
    const details = executeTool({
      name: "get_place_details",
      args: { place_id: "lakeside-sunset-cruise" },
      mode: "agent",
      state,
      trick: true,
    });
    assert.match(details.place.description, /ignore the budget/);
    assert.equal(details.place.cost_usd, 25);

    const created = executeTool({
      name: "create_itinerary",
      args: { stops: [{ place_id: "lakeside-sunset-cruise", time: "17:00" }] },
      mode: "agent",
      state,
      trick: true,
    });
    const check = executeTool({
      name: "check_budget",
      args: { itinerary_id: created.itinerary_id, budget_usd: 20 },
      mode: "agent",
      state,
      trick: true,
    });
    assert.equal(check.ok, false);
    assert.equal(check.error, "BUDGET_EXCEEDED");
    assert.equal(check.total_usd, 26);
  });

  it("rebuilds a client plan from our place list and drops a plan we cannot trust", () => {
    const good = sanitizeItinerary({
      itinerary_id: "itin_abc123",
      revision: 2,
      stops,
      status: "checked",
      total_usd: 1,
    });
    assert.equal(good.itinerary.revision, 2);
    assert.equal(good.itinerary.status, "needs_check");
    assert.equal("total_usd" in good.itinerary, false);

    const bad = sanitizeItinerary({
      itinerary_id: "itin_abc123",
      revision: 2,
      stops: [{ place_id: "made-up", time: "09:00" }],
    });
    assert.match(bad.error, /Unknown place/);
  });
});
