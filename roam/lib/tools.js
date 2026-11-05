/**
 * Tools the model may ask for. Our code checks the request, then runs it.
 * The model never receives a result we did not build here.
 */

import { evaluateBudget, isValidBudget } from "./budget.js";
import { CATEGORIES, getCatalog, getPlace, summarizePlace } from "./places.js";

export const MODES = ["chat", "one_tool", "agent"];

export const MODE_TOOLS = {
  chat: [],
  one_tool: ["search_places"],
  agent: [
    "search_places",
    "get_place_details",
    "create_itinerary",
    "update_itinerary",
    "check_budget",
  ],
};

const MAX_STOPS = 6;

const DECLARATIONS = [
  {
    name: "search_places",
    description:
      "List places in and around Bujumbura. You can filter by category or by a highest price. Descriptions are not included.",
    parameters: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Optional. One of: nature, food, beach, culture, viewpoint.",
          enum: CATEGORIES,
        },
        max_cost: {
          type: "number",
          description: "Optional. Only places that cost this many US dollars or less.",
        },
      },
    },
  },
  {
    name: "get_place_details",
    description: "Get the full description of one place, including its real price from our list.",
    parameters: {
      type: "object",
      properties: {
        place_id: {
          type: "string",
          description: "The id from search_places.",
        },
      },
      required: ["place_id"],
    },
  },
  {
    name: "create_itinerary",
    description:
      "Start a one-day plan. Each stop needs a place_id and a time like 09:30. Times must run from morning to evening.",
    parameters: {
      type: "object",
      properties: {
        stops: {
          type: "array",
          description: "Between 1 and 6 stops.",
          items: {
            type: "object",
            properties: {
              place_id: { type: "string" },
              time: { type: "string", description: "24-hour time, HH:MM." },
            },
            required: ["place_id", "time"],
          },
        },
      },
      required: ["stops"],
    },
  },
  {
    name: "update_itinerary",
    description:
      "Replace the stops on the plan you already created. This keeps the same plan id and adds 1 to the revision. Check the budget again after you update.",
    parameters: {
      type: "object",
      properties: {
        itinerary_id: { type: "string" },
        stops: {
          type: "array",
          items: {
            type: "object",
            properties: {
              place_id: { type: "string" },
              time: { type: "string" },
            },
            required: ["place_id", "time"],
          },
        },
      },
      required: ["itinerary_id", "stops"],
    },
  },
  {
    name: "check_budget",
    description:
      "Ask our code whether the current plan fits the user's budget. The total includes each place price plus $1 of transport per stop. Use the user's budget, not a number you made up. If this fails, change the plan and check again.",
    parameters: {
      type: "object",
      properties: {
        itinerary_id: { type: "string" },
        budget_usd: {
          type: "number",
          description: "The user's budget in US dollars.",
        },
      },
      required: ["itinerary_id", "budget_usd"],
    },
  },
];

export function declarationsFor(mode) {
  const allowed = new Set(MODE_TOOLS[mode] || []);
  return DECLARATIONS.filter((tool) => allowed.has(tool.name));
}

export function createToolState(itinerary = null) {
  return { itinerary: itinerary ? clone(itinerary) : null };
}

/**
 * Run one tool call. Validation failures come back as data for the model.
 * They are not thrown at the person using the app.
 */
export function executeTool({ name, args, mode, state, trick = false, sessionBudget = null }) {
  const allowed = MODE_TOOLS[mode] || [];
  if (!allowed.includes(name)) {
    return invalid(`The ${name || "requested"} tool is not available in this mode.`);
  }

  const input = args && typeof args === "object" && !Array.isArray(args) ? args : null;
  if (!input) {
    return invalid("Tool arguments must be an object.");
  }

  switch (name) {
    case "search_places":
      return searchPlaces(input, trick);
    case "get_place_details":
      return placeDetails(input, trick);
    case "create_itinerary":
      return createItinerary(input, state, trick);
    case "update_itinerary":
      return updateItinerary(input, state, trick);
    case "check_budget":
      return checkBudget(input, state, trick, sessionBudget);
    default:
      return invalid(`Unknown tool: ${name}`);
  }
}

export function sanitizeItinerary(raw, trick = false) {
  if (raw == null) return { itinerary: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "The saved plan is not in a shape we can check." };
  }
  if (typeof raw.itinerary_id !== "string" || !/^itin_[a-z0-9-]{4,40}$/i.test(raw.itinerary_id)) {
    return { error: "The saved plan has a bad id." };
  }
  if (!Number.isInteger(raw.revision) || raw.revision < 1 || raw.revision > 100) {
    return { error: "The saved plan has a bad revision." };
  }
  const stops = normalizeStops(raw.stops, trick);
  if (stops.error) return { error: stops.error };
  return {
    itinerary: {
      itinerary_id: raw.itinerary_id,
      revision: raw.revision,
      stops: stops.value,
      status: "needs_check",
    },
  };
}

function searchPlaces(args, trick) {
  const extra = unknownKeys(args, ["category", "max_cost"]);
  if (extra) return invalid(extra);

  let places = getCatalog(trick);
  if (args.category != null) {
    if (typeof args.category !== "string" || !CATEGORIES.includes(args.category)) {
      return invalid("Category must be nature, food, beach, culture, or viewpoint.");
    }
    places = places.filter((place) => place.category === args.category);
  }
  if (args.max_cost != null) {
    if (typeof args.max_cost !== "number" || !Number.isFinite(args.max_cost) || args.max_cost < 0) {
      return invalid("max_cost must be a number that is 0 or more.");
    }
    places = places.filter((place) => place.cost_usd <= args.max_cost);
  }

  return { ok: true, places: places.map(summarizePlace) };
}

function placeDetails(args, trick) {
  const extra = unknownKeys(args, ["place_id"]);
  if (extra) return invalid(extra);
  if (typeof args.place_id !== "string" || args.place_id.length === 0) {
    return invalid("place_id must be a string.");
  }
  const place = getPlace(args.place_id, trick);
  if (!place) return invalid(`Unknown place: ${args.place_id}`);
  return { ok: true, place: { ...place } };
}

function createItinerary(args, state, trick) {
  const extra = unknownKeys(args, ["stops"]);
  if (extra) return invalid(extra);
  if (state.itinerary) {
    return invalid("A plan already exists. Call update_itinerary to change it.");
  }
  const stops = normalizeStops(args.stops, trick);
  if (stops.error) return invalid(stops.error);

  state.itinerary = {
    itinerary_id: newItineraryId(),
    revision: 1,
    stops: stops.value,
    status: "needs_check",
  };
  return { ...state.itinerary };
}

function updateItinerary(args, state, trick) {
  const extra = unknownKeys(args, ["itinerary_id", "stops"]);
  if (extra) return invalid(extra);
  if (!state.itinerary) return invalid("There is no plan yet. Call create_itinerary first.");
  if (typeof args.itinerary_id !== "string" || args.itinerary_id !== state.itinerary.itinerary_id) {
    return invalid("itinerary_id does not match the current plan.");
  }
  const stops = normalizeStops(args.stops, trick);
  if (stops.error) return invalid(stops.error);

  state.itinerary = {
    itinerary_id: state.itinerary.itinerary_id,
    revision: state.itinerary.revision + 1,
    stops: stops.value,
    status: "needs_check",
  };
  return { ...state.itinerary };
}

function checkBudget(args, state, trick, sessionBudget) {
  const extra = unknownKeys(args, ["itinerary_id", "budget_usd"]);
  if (extra) return invalid(extra);
  if (!state.itinerary) return invalid("There is no plan to check yet.");
  if (typeof args.itinerary_id !== "string" || args.itinerary_id !== state.itinerary.itinerary_id) {
    return invalid("itinerary_id does not match the current plan.");
  }
  if (!isValidBudget(args.budget_usd)) {
    return invalid("budget_usd must be a number greater than 0 and at most 10000.");
  }
  if (sessionBudget != null && Number(args.budget_usd) !== Number(sessionBudget)) {
    return invalid(`Check the user's budget of $${sessionBudget}, not a different number.`);
  }

  const result = evaluateBudget(
    state.itinerary.stops.map((stop) => stop.place_id),
    args.budget_usd,
    { trick },
  );
  return { ...result, revision: state.itinerary.revision };
}

function normalizeStops(stops, trick) {
  if (!Array.isArray(stops) || stops.length === 0) {
    return { error: "Add at least one stop." };
  }
  if (stops.length > MAX_STOPS) {
    return { error: "Use 6 stops or fewer." };
  }

  const clean = [];
  let lastMinutes = -1;
  for (const stop of stops) {
    if (!stop || typeof stop !== "object" || Array.isArray(stop)) {
      return { error: "Each stop needs a place_id and a time." };
    }
    const extra = unknownKeys(stop, ["place_id", "time"]);
    if (extra) return { error: extra };
    if (typeof stop.place_id !== "string" || !getPlace(stop.place_id, trick)) {
      return { error: `Unknown place: ${stop.place_id}` };
    }
    const minutes = parseTime(stop.time);
    if (minutes == null) return { error: "Times must look like 09:30." };
    if (minutes <= lastMinutes) {
      return { error: "Times must be in order, from morning to evening." };
    }
    lastMinutes = minutes;
    clean.push({ place_id: stop.place_id, time: stop.time });
  }
  return { value: clean };
}

function parseTime(value) {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function unknownKeys(obj, allowed) {
  const extra = Object.keys(obj).filter((key) => !allowed.includes(key));
  if (extra.length === 0) return null;
  return `Unexpected argument: ${extra[0]}.`;
}

function invalid(detail) {
  return { ok: false, error: "INVALID_ARGUMENT", detail };
}

function newItineraryId() {
  const rand = Math.random().toString(36).slice(2, 8);
  const time = Date.now().toString(36).slice(-4);
  return `itin_${rand}${time}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
