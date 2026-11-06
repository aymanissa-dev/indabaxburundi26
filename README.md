# indabaxburundi26

Everything for my talk at **IndabaX Burundi 2026**: _"From Chatbots to AI Agents."_

This repo has three parts:

```
indabaxburundi26/
├── roam/      # The working demo app — see roam/README.md for setup
├── codelab/   # A stepped workshop that walks the demo, for someone new to agents
└── slides/    # The talk deck
```

## roam/

Roam. — an AI trip planner that shows the difference between a chatbot and an AI agent. Plain HTML, CSS and JavaScript, one Vercel serverless function, and the Gemini API from Google AI Studio. Type a trip request and a budget, then switch between three modes — Chat, One Tool and Agent — and watch the same AI go from talking, to looking things up, to planning, checking, fixing and re-checking on its own.

Full setup instructions, prerequisites, and architecture notes are in [`roam/README.md`](./roam/README.md).

## codelab/

**[Live: aymanissa-dev.github.io/indabaxburundi26/codelab/](https://aymanissa-dev.github.io/indabaxburundi26/codelab/)**

A stepped workshop for someone new to agents. It walks the Roam demo in this repo — three modes, the loop, the budget checker, and how to run it locally. GitHub Pages publishes the repository root, so the single file `codelab/index.html` is served at [/codelab/](https://aymanissa-dev.github.io/indabaxburundi26/codelab/). The trip planner itself runs on Vercel, not on Pages.

## slides/

The talk deck — 18 slides plus 2 backups covering what chatbots and language models really are, how tools give AI "hands", the agent loop, the live demo, what goes wrong, and why you should start simple.

## Talk

**"From Chatbots to AI Agents"**
IndabaX Burundi 2026 — 30-minute session (slides + live demo), Friday 6 November 2026

## Author

**Ayman Issa**
[Website](https://aymanissa.dev) · [LinkedIn](https://www.linkedin.com/in/aymanissa-dev/) · [X](https://x.com/aymanissa_dev)

## License

MIT — see [LICENSE](./LICENSE).
