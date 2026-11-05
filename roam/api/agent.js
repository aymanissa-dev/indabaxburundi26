/**
 * The only server file. The browser asks for a plan. We ask Gemini, run the
 * tools ourselves, and send back the steps.
 *
 * Gemini 3 and later put a thoughtSignature on function-call parts. We keep
 * each model turn exactly as it arrived, then answer with functionResponse
 * parts that repeat the call id. See:
 * https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures
 *
 * Imports from ../lib are static so Vercel's file tracer can follow them.
 * Hobby plan functions can run up to 300 seconds. This one is capped at 120
 * in vercel.json, which is inside that limit.
 */

import { getPlace } from "../lib/places.js";
import { systemInstruction } from "../lib/prompts.js";
import {
  createToolState,
  declarationsFor,
  executeTool,
  sanitizeItinerary,
} from "../lib/tools.js";

export const DEFAULT_MODEL = "gemini-3.8-flash";
export const HARD_MAX_STEPS = 12;
const BODY_LIMIT = 32 * 1024;
const CALL_TIMEOUT_MS = 20_000;
const DEADLINE_MS = 100_000;

// A warm serverless instance keeps this Map. A new instance starts empty.
// That makes the limit a speed bump, not a lock. The real cost guard is the
// spending cap in AI Studio and Google Cloud billing.
const hitsByIp = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_HITS = 20;

export function allowRequest(ip, now = Date.now()) {
  const recent = (hitsByIp.get(ip) || []).filter((time) => now - time < WINDOW_MS);
  if (recent.length >= MAX_HITS) {
    hitsByIp.set(ip, recent);
    return false;
  }
  recent.push(now);
  hitsByIp.set(ip, recent);
  return true;
}

export function resolveModel(env = process.env) {
  const raw = env.GEMINI_MODEL;
  if (typeof raw === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(raw)) return raw;
  return DEFAULT_MODEL;
}

export function resolveMaxSteps(env = process.env) {
  if (env.MAX_STEPS == null || env.MAX_STEPS === "") return 8;
  const parsed = Number(env.MAX_STEPS);
  if (!Number.isInteger(parsed) || parsed < 1) return 8;
  return Math.min(parsed, HARD_MAX_STEPS);
}

export function friendlyModelError(err) {
  if (err?.aborted || err?.name === "AbortError") return "Took too long. Try Replay.";
  if (err?.status === 429) {
    return "The AI is busy (rate limit). Try again in a minute, or use Replay.";
  }
  if (err?.status === 401 || err?.status === 403) {
    return "API key problem. Check GEMINI_API_KEY in Vercel.";
  }
  return "The AI could not answer just now. Try again, or use Replay.";
}

export async function runLoop({
  callModel,
  mode,
  message,
  budget_usd,
  history = null,
  itinerary = null,
  trick = false,
  maxSteps = 8,
  model = DEFAULT_MODEL,
  apiKey = "",
  callTimeoutMs = CALL_TIMEOUT_MS,
  deadlineMs = null,
  signal = null,
}) {
  const steps = [];
  const safeHistory = normalizeHistory(history);
  if (safeHistory.error) {
    return publicResult({
      mode,
      steps,
      finalText: "",
      itinerary: null,
      status: "no_itinerary",
      stopped: "error",
      history: [],
      model,
      modelCalls: 0,
      errorMessage: safeHistory.error,
      apiKey,
    });
  }

  const cleaned = sanitizeItinerary(itinerary, trick);
  if (cleaned.error) {
    return publicResult({
      mode,
      steps,
      finalText: "",
      itinerary: null,
      status: "no_itinerary",
      stopped: "error",
      history: safeHistory.history,
      model,
      modelCalls: 0,
      errorMessage: cleaned.error,
      apiKey,
    });
  }

  const state = createToolState(cleaned.itinerary);
  const contents = safeHistory.history;
  contents.push({
    role: "user",
    parts: [{ text: userLine(message, budget_usd, mode) }],
  });

  let modelCalls = 0;
  let toolRounds = 0;
  let lastCheck = null;
  let finalText = "";
  let stopped = null;
  let errorMessage = "";
  const stepCap = Math.min(Math.max(1, maxSteps), HARD_MAX_STEPS);

  while (modelCalls < stepCap + 2) {
    if (deadlineMs != null && Date.now() > deadlineMs) {
      stopped = "error";
      errorMessage = "Took too long. Try Replay.";
      break;
    }

    const forceAnswer = mode === "one_tool" && toolRounds >= 1;
    const tools = mode === "chat" || forceAnswer ? [] : declarationsFor(mode);
    modelCalls += 1;

    let response;
    try {
      response = await callModel({
        model,
        systemInstruction: systemInstruction(mode),
        contents,
        tools,
        forceAnswer,
        timeoutMs: callTimeoutMs,
        signal,
      });
    } catch (err) {
      stopped = "error";
      errorMessage = friendlyModelError(err);
      break;
    }

    const content = response?.candidates?.[0]?.content;
    if (!content || !Array.isArray(content.parts) || content.parts.length === 0) {
      stopped = "error";
      errorMessage = "The AI sent back an empty reply. Try again, or use Replay.";
      break;
    }

    contents.push({
      role: content.role || "model",
      parts: content.parts,
    });

    const calls = functionCalls(content);
    if (calls.length === 0) {
      finalText = visibleText(content);
      if (!finalText) {
        stopped = "error";
        errorMessage = "The AI sent back an empty reply. Try again, or use Replay.";
      } else {
        stopped = "done";
      }
      break;
    }

    if (mode === "chat" || forceAnswer) {
      contents.pop();
      stopped = "error";
      errorMessage = "The AI tried to use a tool that is turned off. Try again, or use Replay.";
      break;
    }

    const responses = [];
    let hitLimit = false;
    for (const call of calls) {
      if (steps.length >= stepCap) {
        hitLimit = true;
        break;
      }
      const started = Date.now();
      const result = executeTool({
        name: call.name,
        args: call.args && typeof call.args === "object" ? call.args : {},
        mode,
        state,
        trick,
        sessionBudget: budget_usd,
      });
      steps.push({
        n: steps.length + 1,
        tool: typeof call.name === "string" ? call.name : "unknown",
        args: clone(call.args && typeof call.args === "object" ? call.args : {}),
        result: clone(result),
        ok: result.ok !== false,
        ms: Date.now() - started,
      });

      if (call.name === "check_budget" && result.error !== "INVALID_ARGUMENT") {
        lastCheck = {
          revision: state.itinerary ? state.itinerary.revision : null,
          budget_usd,
          result,
        };
      }
      if (
        (call.name === "create_itinerary" || call.name === "update_itinerary") &&
        result.itinerary_id
      ) {
        lastCheck = null;
      }

      const part = {
        functionResponse: {
          name: call.name,
          response: asObject(result),
        },
      };
      if (typeof call.id === "string" && call.id) part.functionResponse.id = call.id;
      responses.push(part);
    }

    if (responses.length > 0) {
      contents.push({ role: "user", parts: responses });
    } else if (hitLimit) {
      contents.pop();
    }

    if (hitLimit) {
      stopped = "step_limit";
      break;
    }
    if (mode === "one_tool") toolRounds += 1;
  }

  if (!stopped) stopped = "step_limit";

  const status = deriveStatus(state.itinerary, lastCheck, budget_usd);
  return publicResult({
    mode,
    steps,
    finalText,
    itinerary: enrichItinerary(state.itinerary, trick, lastCheck, budget_usd),
    status,
    stopped,
    history: contents,
    model,
    modelCalls,
    errorMessage,
    apiKey,
  });
}

export async function callGemini({
  apiKey,
  model,
  systemInstruction: instruction,
  contents,
  tools,
  forceAnswer,
  timeoutMs = CALL_TIMEOUT_MS,
  signal = null,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  const body = {
    systemInstruction: { parts: [{ text: instruction }] },
    contents,
  };
  const generationConfig = thinkingConfigFor(model);
  if (generationConfig) body.generationConfig = generationConfig;
  if (tools?.length) body.tools = [{ functionDeclarations: tools }];
  if (forceAnswer) body.toolConfig = { functionCallingConfig: { mode: "NONE" } };

  try {
    const response = await fetch(endpoint(model), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      console.error("gemini_error", response.status, clip(stripSecret(text, apiKey)));
      const error = new Error("gemini");
      error.status = response.status;
      throw error;
    }
    return await response.json();
  } catch (err) {
    if (err?.name === "AbortError") {
      const error = new Error("timeout");
      error.aborted = true;
      throw error;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

async function handle(request) {
  if (request.method !== "POST") {
    return json(405, { error: "Send a POST request.", stopped_reason: "error" });
  }

  const passcode = process.env.DEMO_PASSCODE;
  if (passcode) {
    if (request.headers.get("x-demo-passcode") !== passcode) {
      return json(401, {
        error: "This demo is locked. Add the passcode and try again.",
        stopped_reason: "error",
      });
    }
  }

  const ip = clientIp(request);
  if (!allowRequest(ip)) {
    return json(429, {
      error: "Too many tries from here. Wait a few minutes, or use Replay.",
      stopped_reason: "error",
    });
  }

  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > BODY_LIMIT) {
    return json(400, { error: "That request is too large. Start a new run.", stopped_reason: "error" });
  }

  let raw = "";
  try {
    raw = await request.text();
  } catch {
    return json(400, { error: "We could not read that request.", stopped_reason: "error" });
  }
  if (raw.length > BODY_LIMIT) {
    return json(400, { error: "That request is too large. Start a new run.", stopped_reason: "error" });
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "We could not read that request.", stopped_reason: "error" });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json(400, { error: "We could not read that request.", stopped_reason: "error" });
  }

  const mode = body.mode;
  if (mode !== "chat" && mode !== "one_tool" && mode !== "agent") {
    return json(400, { error: "Pick Chat, One Tool, or Agent.", stopped_reason: "error" });
  }
  if (typeof body.message !== "string" || body.message.trim().length === 0) {
    return json(400, { error: "Type a trip request first.", stopped_reason: "error" });
  }
  if (body.message.length > 1000) {
    return json(400, { error: "Keep the request under 1000 characters.", stopped_reason: "error" });
  }
  if (typeof body.budget_usd !== "number" || !Number.isFinite(body.budget_usd)) {
    return json(400, { error: "Enter a budget as a number.", stopped_reason: "error" });
  }
  if (body.budget_usd <= 0 || body.budget_usd > 10000) {
    return json(400, { error: "Use a budget from 1 to 10000 dollars.", stopped_reason: "error" });
  }
  if (body.trick != null && typeof body.trick !== "boolean") {
    return json(400, { error: "Trick mode must be on or off.", stopped_reason: "error" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("missing_gemini_key");
    return json(500, {
      error: "API key problem. Check GEMINI_API_KEY in Vercel.",
      stopped_reason: "error",
    });
  }

  const model = resolveModel();
  const result = await runLoop({
    apiKey,
    model,
    mode,
    message: body.message.trim(),
    budget_usd: body.budget_usd,
    history: body.history ?? null,
    itinerary: body.itinerary ?? null,
    trick: body.trick === true,
    maxSteps: resolveMaxSteps(),
    deadlineMs: Date.now() + DEADLINE_MS,
    callModel: (input) => callGemini({ ...input, apiKey }),
  });

  const status = result.stopped_reason === "error" && result.steps.length === 0 ? 502 : 200;
  if (result.error) console.error("run_error", result.stopped_reason, result.error);
  return json(status, result);
}

export default {
  async fetch(request) {
    return handle(request);
  },
};

function publicResult({
  mode,
  steps,
  finalText,
  itinerary,
  status,
  stopped,
  history,
  model,
  modelCalls,
  errorMessage,
  apiKey,
}) {
  const body = {
    mode,
    steps,
    final_text: finalText,
    itinerary,
    status,
    stopped_reason: stopped,
    history,
    model,
    usage: { model_calls: modelCalls },
  };
  if (errorMessage) body.error = errorMessage;
  return redact(body, apiKey);
}

function deriveStatus(itinerary, lastCheck, budget) {
  if (!itinerary) return "no_itinerary";
  const samePlan =
    lastCheck &&
    lastCheck.revision === itinerary.revision &&
    Number(lastCheck.budget_usd) === Number(budget);
  if (!samePlan) return "unverified";
  return lastCheck.result.ok === true ? "valid" : "invalid";
}

function enrichItinerary(itinerary, trick, lastCheck, budget) {
  if (!itinerary) return null;
  const samePlan = lastCheck && lastCheck.revision === itinerary.revision;
  const check = samePlan ? lastCheck.result : null;
  return {
    itinerary_id: itinerary.itinerary_id,
    revision: itinerary.revision,
    status: check?.ok === true ? "checked" : "needs_check",
    stops: itinerary.stops.map((stop) => {
      const place = getPlace(stop.place_id, trick);
      return {
        place_id: stop.place_id,
        time: stop.time,
        name: place ? place.name : stop.place_id,
        category: place ? place.category : "",
        cost_usd: place ? place.cost_usd : null,
      };
    }),
    total_usd: check ? check.total_usd : null,
    budget_usd: budget,
    over_by_usd: check && check.ok === false ? check.over_by_usd : null,
    breakdown: check?.breakdown || null,
  };
}

function normalizeHistory(history) {
  if (history == null) return { history: [] };
  if (!Array.isArray(history)) return { error: "The saved conversation is not a list." };
  if (history.length > 40) return { error: "That conversation is too long. Start a new run." };
  const copy = [];
  for (const turn of history) {
    if (!turn || (turn.role !== "user" && turn.role !== "model") || !Array.isArray(turn.parts)) {
      return { error: "The saved conversation is missing a turn we can send on." };
    }
    copy.push({ role: turn.role, parts: turn.parts });
  }
  return { history: copy };
}

function userLine(message, budget, mode) {
  if (mode === "chat") return `${message}\n\nMy budget is $${budget}.`;
  return `${message}\n\nMy budget is $${budget}. Use the tools for prices. Do not invent a total.`;
}

function functionCalls(content) {
  return (content.parts || [])
    .filter((part) => part && part.functionCall && typeof part.functionCall === "object")
    .map((part) => part.functionCall);
}

function visibleText(content) {
  return (content.parts || [])
    .filter((part) => part && typeof part.text === "string" && part.thought !== true && !part.functionCall)
    .map((part) => part.text)
    .join("")
    .trim();
}

function asObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return { result: value };
}

function thinkingConfigFor(model) {
  if (/gemini-[34]/i.test(model)) return { thinkingConfig: { thinkingLevel: "low" } };
  return null;
}

function endpoint(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

function clientIp(request) {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim() || "unknown";
  return request.headers.get("x-real-ip") || "unknown";
}

function redact(value, secret) {
  if (typeof secret !== "string" || secret.length < 8) return value;
  const json = JSON.stringify(value);
  if (!json.includes(secret)) return value;
  return JSON.parse(json.split(secret).join("[redacted]"));
}

function stripSecret(text, secret) {
  if (!secret) return text;
  return text.split(secret).join("[redacted]");
}

function clip(text) {
  return String(text || "").slice(0, 300);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
