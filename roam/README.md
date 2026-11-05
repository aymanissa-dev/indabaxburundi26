# Roam.

An AI trip planner for Bujumbura. It is the live demo for the talk "From Chatbots to AI Agents."

You type a trip and a budget. Then you pick one of three modes. The same kind of model is behind all three. The difference is what our code lets it do.

Real place names. Made-up prices. This is not a booking system.

## The idea

The model only *asks* for a tool. Our code checks the request, runs it, and limits it. Every dollar figure comes from `lib/budget.js`, never from the model.

| Mode | What it can do |
|---|---|
| Chat, "The Talker" | No tools. It writes a plan and checks nothing. |
| One Tool, "The Helper" | It may call `search_places` once. The prices are real. Nobody adds them up. |
| Agent, "The Agent" | Four more tools, plus a budget checker that always gives the same answer for the same plan. It can go over budget, notice, change the plan, and check again. |

There is also a **Trick** switch. It adds one place whose description says the trip is free. The budget checker still uses the price in our data.

## What you need

- Node.js 20 or newer (for `npm test`)
- A free [Google AI Studio](https://aistudio.google.com/) API key
- A [Vercel](https://vercel.com/) account
- The Vercel CLI, used with `npx vercel`. It is not a dependency of this folder.

## Project layout

The Vercel project root is this `roam/` folder, not the repo root.

```
roam/
├── index.html          # the page
├── style.css
├── app.js              # modes, steps, replay, download
├── api/agent.js        # the only server file
├── lib/                # places, tools, budget, prompts
├── replays/            # saved runs the page can play back
├── tests/
├── vercel.json
└── .env.example
```

`api/agent.js` imports `../lib` with static paths. Vercel’s file tracer follows those imports, so the libraries stay outside `api/`.

## Environment variables

Copy the names from [`.env.example`](./.env.example). Put the real values in Vercel, or in `.env.local` for `vercel dev`. Never commit them. The browser never receives the API key.

| Name | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | yes | Google AI Studio key. Server only. |
| `GEMINI_MODEL` | no | Model id. Default `gemini-3.8-flash` (the current Flash model in the Gemini docs when this was built). |
| `DEMO_PASSCODE` | no | If set, every request must send header `x-demo-passcode`. |
| `MAX_STEPS` | no | Agent loop limit. Default `8`. Hard maximum `12`. |

## Tests

From this folder:

```bash
npm test
```

That runs Node’s built-in test runner. No test library. The agent-loop tests use a fake model, so they do not call Google and do not need a key.

## Run it on your machine

From this folder:

```bash
npx vercel dev
```

Open the local URL it prints. `index.html` by itself cannot reach the model, because the key lives in the function.

If `DEMO_PASSCODE` is set, the first Run returns “locked”. A passcode field appears. It is stored in `sessionStorage` for the tab.

## Deploy

1. Import this GitHub repo in Vercel.
2. Set the project **Root Directory** to `roam`.
3. Add the environment variables above. Do not put the key in the repo.
4. Deploy. You do not need a build command. There is no frontend build.

`vercel.json` sets `maxDuration` to **120 seconds**. On the Hobby plan the ceiling is **300 seconds** (checked against the Vercel docs). 120 is inside that ceiling and is enough for a short agent loop. You can raise it up to 300 if a slow model run is cut off.

Each call to Gemini also has its own 20 second timeout. If that fires, the page says to try Replay.

### Spending limit

In Google AI Studio, set a spending cap before the talk. A small cap is the real cost guard. The in-memory rate limit in `api/agent.js` (20 requests per 10 minutes per IP) only slows traffic that hits the same warm instance. Serverless memory is not shared.

### GitHub Pages

The codelab is a static site. It does not use this Vercel project. See the repo root README.

## How a run works

1. The browser sends `POST /api/agent` with `{ mode, message, budget_usd, history, itinerary, trick }`.
2. The function checks the size (32 KB), the message (1,000 characters), the passcode, and the rate limit.
3. It calls Gemini’s `generateContent` REST endpoint with the key in the `x-goog-api-key` header. No SDK.
4. If the reply has `functionCall` parts, we validate them, run them, and send the results back as `functionResponse` parts.
5. Gemini 3 models attach a `thoughtSignature` to function-call parts. We append the model’s parts unchanged, including that signature, and we copy the call `id` onto the response. The page does not show hidden reasoning. It shows the tool request, our result, and the final answer.
6. For the current Flash model we ask for a low thinking level, so the live demo stays responsive. `minimal` is not supported on Gemini 3.8 Flash.
7. The browser reveals the steps one at a time.

A follow-up such as “Actually, my budget is now $25” sends the history and the plan back. The plan id stays the same. Our code does not trust prices in that object. It looks the places up again. The revision goes up only when `update_itinerary` succeeds. A new budget needs a new passing `check_budget`.

### Status values

| Status | Meaning on screen |
|---|---|
| `valid` | ✓ Checked by code. The latest plan passed `check_budget` for this budget. |
| `invalid` | ✗ Over budget. The checker refused the plan. This is not a success. |
| `unverified` | ⚠ Not checked. The model wrote an answer without a check for this plan. |
| `no_itinerary` | No plan object. Chat mode always ends here. |

One Tool mode stops after one tool round, then we call the model again with function calling turned off (`mode: "NONE"`) so it has to answer in words.

## Replay and a recording

**Replay** plays a JSON file through the same step renderer. The badge says **↺ REPLAY, NOT LIVE**.

- **Example run** is `replays/scripted.json`. It was written for the demo. It is not a recording of Gemini.
- **Recorded real run** is `replays/recorded.json`. It starts as a placeholder that says **No recording yet**.

**Download this run** saves the last live response as `recorded.json` in that same shape. After a rehearsal you trust, replace `replays/recorded.json` with the file and commit it. Do not invent a recording. This repo does not contain one.

Replay works with no network call to Gemini. You still need the page itself to be open.

## The receipt the talk expects

Transport is $1 per stop. Prices are the integers in `lib/places.js`.

- Boat safari + Club du Lac lunch + Saga Beach = 30 + 18 + 5 + 3 = **$56** (over $50).
- Swap the safari for the riverside walk = **$38** (fits $50).
- On a $25 budget, walk + brochettes + beach = **$28** (still over).
- Swap the walk for the free Kiriri viewpoint = **$16** (fits $25).

The trick cruise costs **$25** in the data, even though its description tells the model to treat it as free.

## Troubleshooting

| What you see | What to try |
|---|---|
| API key problem. Check GEMINI_API_KEY in Vercel. | The key is missing, or Google returned 401/403. Fix the env var and redeploy. |
| The AI is busy (rate limit). | Google returned 429, or you hit the local speed bump. Wait, or press Replay. |
| Took too long. Try Replay. | A model call exceeded 20 seconds, or the function ran out of time. |
| This demo is locked. | `DEMO_PASSCODE` is set. Type it in the field that appears. |
| That request is too large. | The history grew past 32 KB. Start a new run. |
| The page says the network failed. | You opened the HTML file directly, or `vercel dev` is not running. |
| A follow-up starts a brand new plan. | The model called `create_itinerary` again. The tool tells it to use `update_itinerary` if a plan already exists. |

Server logs leave out the API key. The raw Google error body is not sent to the browser.
