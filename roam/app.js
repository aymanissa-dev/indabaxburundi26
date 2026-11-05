const ICONS = {
  search_places: "🔍",
  get_place_details: "📄",
  create_itinerary: "📝",
  update_itinerary: "✏️",
  check_budget: "🧮",
};

const MODE_LABELS = {
  chat: "Chat",
  one_tool: "One Tool",
  agent: "Agent",
};

const els = {
  modes: document.querySelector(".modes"),
  form: document.querySelector("#trip-form"),
  message: document.querySelector("#message"),
  budget: document.querySelector("#budget"),
  run: document.querySelector("#run"),
  passcodeRow: document.querySelector("#passcode-row"),
  passcode: document.querySelector("#passcode"),
  live: document.querySelector("#live"),
  follow: document.querySelector("#follow-up"),
  followMessage: document.querySelector("#follow-message"),
};

let mode = "chat";
let history = null;
let itinerary = null;
let busy = false;
let hintTimer = 0;

const storedPasscode = readPasscode();
if (storedPasscode) els.passcode.value = storedPasscode;

els.modes.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-mode]");
  if (!button || busy) return;
  setMode(button.dataset.mode);
});

els.modes.addEventListener("keydown", (event) => {
  const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"];
  if (!keys.includes(event.key)) return;
  const buttons = [...els.modes.querySelectorAll("button[data-mode]")];
  const index = buttons.findIndex((button) => button.dataset.mode === mode);
  const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
  const next = buttons[(index + step + buttons.length) % buttons.length];
  event.preventDefault();
  setMode(next.dataset.mode);
  next.focus();
});

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  runTrip({ followUp: false });
});

els.follow.addEventListener("submit", (event) => {
  event.preventDefault();
  runTrip({ followUp: true });
});

els.passcode.addEventListener("change", () => writePasscode(els.passcode.value));

function setMode(next) {
  mode = next;
  history = null;
  itinerary = null;
  els.follow.hidden = true;
  for (const button of els.modes.querySelectorAll("button[data-mode]")) {
    const on = button.dataset.mode === next;
    button.setAttribute("aria-checked", on ? "true" : "false");
  }
}

async function runTrip({ followUp }) {
  if (busy) return;
  const message = (followUp ? els.followMessage.value : els.message.value).trim();
  const budget = Number(els.budget.value);
  if (!message) {
    renderNotice("Type a trip request first.");
    return;
  }
  if (!Number.isFinite(budget) || budget <= 0 || budget > 10000) {
    renderNotice("Use a budget from 1 to 10000 dollars.");
    return;
  }

  setBusy(true);
  renderThinking();
  hintTimer = window.setTimeout(() => {
    const hint = document.querySelector("#hint");
    if (hint) hint.hidden = false;
  }, 10000);

  try {
    const headers = { "Content-Type": "application/json" };
    const passcode = els.passcode.value.trim();
    if (passcode) headers["x-demo-passcode"] = passcode;

    const response = await fetch("/api/agent", {
      method: "POST",
      headers,
      body: JSON.stringify({
        mode,
        message,
        budget_usd: budget,
        history: followUp ? history : null,
        itinerary: followUp ? leanItinerary(itinerary) : null,
        trick: false,
      }),
    });

    let data = null;
    try {
      data = await response.json();
    } catch {
      renderNotice("The server sent a reply we could not read.");
      return;
    }

    if (response.status === 401) {
      showPasscode();
      renderNotice(data.error || "This demo is locked. Add the passcode and try again.");
      return;
    }
    if (!response.ok && !(data.steps && data.steps.length)) {
      renderNotice(data.error || "Something went wrong. You can try again.");
      return;
    }

    history = Array.isArray(data.history) ? data.history : null;
    itinerary = data.itinerary || null;
    if (followUp) els.followMessage.value = "";
    await renderRun(data);
  } catch {
    renderNotice("The network failed. You can try again.");
  } finally {
    window.clearTimeout(hintTimer);
    setBusy(false);
  }
}

function renderThinking() {
  els.live.replaceChildren();
  const box = el("div", "thinking");
  box.append(el("span", "spinner"));
  box.append(el("p", null, "Thinking…"));
  const hint = el("p", "note", "Taking a while… you can use Replay.");
  hint.id = "hint";
  hint.hidden = true;
  box.append(hint);
  els.live.append(box);
  els.follow.hidden = true;
}

function renderNotice(text) {
  els.live.replaceChildren(el("p", "banner", text));
}

async function renderRun(data) {
  els.live.replaceChildren();
  els.live.append(el("p", "mode-flag", MODE_LABELS[data.mode] || "Run"));
  if (data.error) els.live.append(el("p", "banner", data.error));

  if (data.mode === "chat") {
    els.live.append(renderChat(data.final_text || ""));
  } else {
    const list = el("ol", "steps");
    els.live.append(list);
    for (const step of data.steps || []) {
      list.append(renderStep(step));
      await wait(600);
    }
    if (data.itinerary) els.live.append(renderReceipt(data));
    else if (data.final_text) els.live.append(renderAnswer(data));
  }

  els.follow.hidden = !history;
}

function renderChat(text) {
  const wrap = el("div", "chat-wrap");
  wrap.append(el("p", "bubble", text));
  wrap.append(el("p", "note", "Nothing was checked. No tools were used."));
  return wrap;
}

function renderAnswer(data) {
  const card = el("article", "answer");
  card.append(el("p", "final-text", data.final_text));
  card.append(badgeNode(data.status));
  return card;
}

function renderStep(step) {
  const item = el("li", "step");
  if (step.tool === "check_budget") item.classList.add(step.result && step.result.ok ? "under" : "over");

  const kicker = el("p", "kicker");
  kicker.append(el("span", "num", String(step.n)));
  kicker.append(el("span", "icon", ICONS[step.tool] || "•", true));
  kicker.append(el("span", null, step.tool || "tool"));
  item.append(kicker);

  const asked = el("p", "line");
  const who = el("span", "who", "AI asked: ");
  asked.append(who);
  asked.append(document.createTextNode(askedPhrase(step)));
  item.append(asked);

  const answered = el("p", "line");
  answered.append(el("span", "who", "Our code answered: "));
  answered.append(document.createTextNode(answeredPhrase(step)));
  item.append(answered);
  return item;
}

function renderReceipt(data) {
  const plan = data.itinerary;
  const card = el("article", "receipt");
  card.append(el("h2", "receipt-title", "Today in Bujumbura"));
  const list = el("ol", "stops");
  for (const stop of plan.stops || []) {
    const item = el("li", "stop");
    item.append(el("span", "time", stop.time || ""));
    item.append(el("span", "stop-name", stop.name || stop.place_id || "Stop"));
    if (stop.cost_usd != null) item.append(el("span", "cost", money(stop.cost_usd)));
    list.append(item);
  }
  card.append(list);

  const transport = (plan.breakdown || []).find((line) => line.label === "Transport");
  if (transport) {
    card.append(el("p", "transport", `Transport ${money(transport.cost_usd)} · $1 per stop`));
  }

  const total = el("div", "total");
  if (plan.total_usd != null) {
    total.append(el("p", "total-figure", money(plan.total_usd)));
    if (data.status === "invalid" && plan.over_by_usd != null) {
      total.append(el("p", null, `Over budget by ${money(plan.over_by_usd)}`));
    }
  } else {
    total.append(el("p", "total-figure", "No checked total"));
  }
  total.append(badgeNode(data.status));
  card.append(total);
  if (data.final_text) card.append(el("p", "final-text", data.final_text));
  return card;
}

function badgeNode(status) {
  if (status === "valid") return el("p", "badge ok", "✓ Checked by code");
  if (status === "invalid") return el("p", "badge bad", "✗ Over budget");
  return el("p", "badge warn", "⚠ Not checked");
}

function askedPhrase(step) {
  const args = step.args || {};
  if (step.tool === "search_places") {
    const bits = [];
    if (args.category) bits.push(args.category);
    if (args.max_cost != null) bits.push(`up to ${money(args.max_cost)}`);
    return bits.length ? `search places — ${bits.join(", ")}` : "search places";
  }
  if (step.tool === "get_place_details") return `place details — ${args.place_id || "unknown"}`;
  if (step.tool === "create_itinerary") return `create plan — ${(args.stops || []).length} stops`;
  if (step.tool === "update_itinerary") return `update plan — ${(args.stops || []).length} stops`;
  if (step.tool === "check_budget") return `check budget — ${money(args.budget_usd)}`;
  return step.tool || "unknown tool";
}

function answeredPhrase(step) {
  const result = step.result || {};
  if (result.error === "INVALID_ARGUMENT") return `✗ ${result.detail || "That request was not accepted."}`;
  if (step.tool === "search_places" && Array.isArray(result.places)) {
    return `${result.places.length} ${result.places.length === 1 ? "place" : "places"}`;
  }
  if (step.tool === "get_place_details" && result.place) return result.place.name;
  if ((step.tool === "create_itinerary" || step.tool === "update_itinerary") && result.itinerary_id) {
    return `Revision ${result.revision}, ${result.stops.length} stops`;
  }
  if (step.tool === "check_budget" && result.ok === true) return `✓ ${money(result.total_usd)}, within budget`;
  if (step.tool === "check_budget" && result.error === "BUDGET_EXCEEDED") {
    return `✗ ${money(result.total_usd)}, over budget by ${money(result.over_by_usd)}`;
  }
  if (result.detail) return `✗ ${result.detail}`;
  return step.ok ? "Done" : "✗ Not accepted";
}

function leanItinerary(plan) {
  if (!plan || !plan.itinerary_id) return null;
  return {
    itinerary_id: plan.itinerary_id,
    revision: plan.revision,
    stops: (plan.stops || []).map((stop) => ({ place_id: stop.place_id, time: stop.time })),
  };
}

function money(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "$0";
  return Number.isInteger(number) ? `$${number}` : `$${number.toFixed(2)}`;
}

function setBusy(next) {
  busy = next;
  els.run.disabled = next;
  els.follow.querySelector("button").disabled = next;
}

function showPasscode() {
  els.passcodeRow.hidden = false;
}

function readPasscode() {
  try {
    return sessionStorage.getItem("roam_demo_passcode") || "";
  } catch {
    return "";
  }
}

function writePasscode(value) {
  try {
    sessionStorage.setItem("roam_demo_passcode", value);
  } catch {
    /* Storage can be blocked. The field still sends the passcode. */
  }
}

function el(tag, className, text, ariaHidden) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  if (ariaHidden) node.setAttribute("aria-hidden", "true");
  return node;
}

function wait(ms) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
