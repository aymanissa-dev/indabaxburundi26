import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allowRequest,
  DEFAULT_MODEL,
  friendlyModelError,
  HARD_MAX_STEPS,
  resolveMaxSteps,
  resolveModel,
  runLoop,
} from "../api/agent.js";

const SECRET = "super-secret-demo-key";

const highlight = [
  { place_id: "rusizi-boat-safari", time: "09:00" },
  { place_id: "club-du-lac-lunch", time: "12:30" },
  { place_id: "saga-beach", time: "15:00" },
];

const fixed = [
  { place_id: "rusizi-guided-walk", time: "09:00" },
  { place_id: "club-du-lac-lunch", time: "12:30" },
  { place_id: "saga-beach", time: "15:00" },
];

describe("runLoop", () => {
  it("runs the tools in order and keeps the model's thought signature", async () => {
    const seen = [];
    let n = 0;
    const result = await runLoop({
      apiKey: SECRET,
      mode: "agent",
      message: "Plan a one-day trip in Bujumbura for me.",
      budget_usd: 50,
      maxSteps: 8,
      model: DEFAULT_MODEL,
      callModel: async (input) => {
        seen.push(input);
        n += 1;
        if (n === 1) return modelCall("search_places", {}, { id: "call-1", signature: "sig-keep-me" });
        if (n === 2) return modelCall("create_itinerary", { stops: highlight }, { id: "call-2", signature: "sig-2" });
        if (n === 3) {
          return modelCall(
            "check_budget",
            { itinerary_id: latestItineraryId(input.contents), budget_usd: 50 },
            { id: "call-3", signature: "sig-3" },
          );
        }
        if (n === 4) {
          return modelCall(
            "update_itinerary",
            { itinerary_id: latestItineraryId(input.contents), stops: fixed },
            { id: "call-4", signature: "sig-4" },
          );
        }
        if (n === 5) {
          return modelCall(
            "check_budget",
            { itinerary_id: latestItineraryId(input.contents), budget_usd: 50 },
            { id: "call-5", signature: "sig-5" },
          );
        }
        return textReply("Walk, lunch at Club du Lac, then Saga Beach. Checked total: $38.");
      },
    });

    assert.deepEqual(
      result.steps.map((step) => step.tool),
      ["search_places", "create_itinerary", "check_budget", "update_itinerary", "check_budget"],
    );
    assert.equal(result.steps[2].result.total_usd, 56);
    assert.equal(result.steps[2].result.ok, false);
    assert.equal(result.steps[4].result.total_usd, 38);
    assert.equal(result.steps[4].ok, true);
    assert.equal(result.status, "valid");
    assert.equal(result.stopped_reason, "done");
    assert.equal(result.itinerary.revision, 2);
    assert.equal(result.itinerary.total_usd, 38);
    assert.equal(result.usage.model_calls, 6);

    const second = seen[1];
    const signed = second.contents.find((turn) =>
      turn.parts.some((part) => part.thoughtSignature === "sig-keep-me"),
    );
    assert.ok(signed);
    assert.equal(signed.parts[0].functionCall.name, "search_places");
    const answered = second.contents.find((turn) => turn.parts.some((part) => part.functionResponse));
    assert.equal(answered.parts[0].functionResponse.id, "call-1");
    assert.equal(answered.parts[0].functionResponse.name, "search_places");
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  });

  it("stops at MAX_STEPS", async () => {
    const result = await runLoop({
      mode: "agent",
      message: "Keep searching.",
      budget_usd: 50,
      maxSteps: 2,
      callModel: async () => modelCall("search_places", { category: "nature" }, { id: "again" }),
    });

    assert.equal(result.stopped_reason, "step_limit");
    assert.equal(result.steps.length, 2);
    assert.equal(result.steps.every((step) => step.tool === "search_places"), true);
  });

  it("marks the run unverified when the model answers without a passing check", async () => {
    let n = 0;
    const result = await runLoop({
      mode: "agent",
      message: "Plan something.",
      budget_usd: 50,
      callModel: async (input) => {
        n += 1;
        if (n === 1) {
          return modelCall("create_itinerary", { stops: highlight }, { id: "make" });
        }
        assert.equal(latestItineraryId(input.contents) != null, true);
        return textReply("All set. I say this costs $10.");
      },
    });

    assert.equal(result.status, "unverified");
    assert.equal(result.stopped_reason, "done");
    assert.match(result.final_text, /\$10/);
    assert.equal(result.itinerary.total_usd, null);
    assert.equal(result.steps.some((step) => step.tool === "check_budget"), false);
  });

  it("never puts the API key in the response, even if the model repeats it", async () => {
    const result = await runLoop({
      apiKey: SECRET,
      mode: "chat",
      message: "Hello",
      budget_usd: 50,
      callModel: async () => textReply(`The key is ${SECRET}. Have a nice day.`),
    });

    assert.equal(result.mode, "chat");
    assert.equal(result.status, "no_itinerary");
    assert.match(result.final_text, /\[redacted\]/);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
    assert.equal("apiKey" in result, false);
  });

  it("gives One Tool mode a single tool round, then asks for words only", async () => {
    const seen = [];
    let n = 0;
    const result = await runLoop({
      mode: "one_tool",
      message: "What can I do?",
      budget_usd: 50,
      callModel: async (input) => {
        seen.push(input);
        n += 1;
        if (n === 1) return modelCall("search_places", {}, { id: "only" });
        return textReply("I found places. I did not add up a total.");
      },
    });

    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0].tool, "search_places");
    assert.equal(seen[0].tools.map((tool) => tool.name).join(), "search_places");
    assert.equal(seen[1].forceAnswer, true);
    assert.deepEqual(seen[1].tools, []);
    assert.equal(result.status, "no_itinerary");
    assert.match(result.final_text, /did not add up/);
  });

  it("maps a busy model to the rate-limit sentence", async () => {
    const result = await runLoop({
      mode: "chat",
      message: "Hello",
      budget_usd: 50,
      callModel: async () => {
        const error = new Error("upstream body that must stay on the server");
        error.status = 429;
        throw error;
      },
    });

    assert.equal(result.stopped_reason, "error");
    assert.equal(result.error, friendlyModelError({ status: 429 }));
    assert.match(result.error, /rate limit/);
    assert.equal(JSON.stringify(result).includes("upstream body"), false);
  });
});

describe("limits", () => {
  it("caps MAX_STEPS at 12 and defaults to 8", () => {
    assert.equal(resolveMaxSteps({}), 8);
    assert.equal(resolveMaxSteps({ MAX_STEPS: "3" }), 3);
    assert.equal(resolveMaxSteps({ MAX_STEPS: "99" }), HARD_MAX_STEPS);
    assert.equal(resolveModel({}), DEFAULT_MODEL);
    assert.equal(resolveModel({ GEMINI_MODEL: "gemini-3.8-flash" }), "gemini-3.8-flash");
  });

  it("allows 20 hits in 10 minutes and blocks the next one", () => {
    const ip = "203.0.113.10";
    const start = 1_700_000_000_000;
    for (let i = 0; i < 20; i += 1) assert.equal(allowRequest(ip, start + i), true);
    assert.equal(allowRequest(ip, start + 21), false);
    assert.equal(allowRequest(ip, start + 10 * 60 * 1000 + 21), true);
  });
});

function modelCall(name, args, { id, signature } = {}) {
  const part = { functionCall: { name, args, id } };
  if (signature) part.thoughtSignature = signature;
  return { candidates: [{ content: { role: "model", parts: [part] } }] };
}

function textReply(text) {
  return { candidates: [{ content: { role: "model", parts: [{ text }] } }] };
}

function latestItineraryId(contents) {
  let id = null;
  for (const turn of contents) {
    for (const part of turn.parts || []) {
      if (part.functionResponse?.response?.itinerary_id) {
        id = part.functionResponse.response.itinerary_id;
      }
    }
  }
  return id;
}
