# GBrain

**Search gives you raw pages. Think gives you the answer.** GBrain is the brain layer your AI agent has been missing, and the only one that does synthesis, graph traversal, and gap analysis in one box.

Built by the President and CEO of Y Combinator to run his actual AI agents. The production brain behind his OpenClaw and Hermes deployments: **146,646 pages, 24,585 people, 5,339 companies**, 66 cron jobs running autonomously. The agent ingests meetings, emails, tweets, voice calls, and original ideas while you sleep. It enriches every person and company it encounters. It fixes its own citations and consolidates memory overnight. You wake up smarter than when you went to bed.

Lots of personal-knowledge systems give you keyword matching and grep in a box. GBrain does that, and adds two things nobody else ships together:

- **`gbrain think`**: synthesized, well-cited answers across people, companies, deals, and ideas. Not "here are 10 chunks that mention your query"; an actual answer with citations and an explicit note on what the brain doesn't know yet. The gap analysis is the part that changes how you use the brain.
- **A self-wiring knowledge graph.** Every page write extracts entity refs and creates typed edges (`attended`, `works_at`, `invested_in`, `founded`, `advises`) with zero LLM calls. Ask "who works at Acme AI?" or "what did Bob invest in this quarter?" and get answers vector search alone can't reach. Benchmarked: **P@5 49.1%, R@5 97.9%** on a 240-page Opus-generated rich-prose corpus, **+31.4 points P@5** over its graph-disabled variant and over ripgrep-BM25 + vector-only RAG by a similar margin. Full BrainBench scorecards live in the sibling [gbrain-evals](https://github.com/garrytan/gbrain-evals) repo.

The point of building a 100K-page brain is to use it as a strategic moat. To never lose context. To query what's in your own head without re-reading it. `gbrain think` is what makes the moat usable. The 24/7 dream cycle is what keeps it sharp. Both run on your hardware, your DB, your keys.

It's easier to ship a daemon that runs 24/7 to ingest, enrich, and consolidate than it is to keep an agent in chat working hard. GBrain is that daemon, generalized. Install in 30 minutes. Your agent does the work. As Garry's personal agent gets smarter, so does yours.

> **~30 minutes to a fully working brain.** Database ready in 2 seconds (PGLite, no server). You just answer questions about API keys.

> **LLMs:** fetch [`llms.txt`](llms.txt) for the documentation map, or [`llms-full.txt`](llms-full.txt) for the same map with core docs inlined in one fetch. **Agents:** start with [`AGENTS.md`](AGENTS.md) (or [`CLAUDE.md`](CLAUDE.md) if you're Claude Code).

## What this looks like

Pulled directly from `eval/reports/cat29-think-vs-search/2026-05-23-cat29.json` (the actual eval receipt; reproduce yourself via `bun eval/runner/cat29-think-vs-search.ts`). Same question, same brain, same retrieval pipeline. Judge: Claude Haiku 4.5, prompted to score 0-10 on accuracy + groundedness + utility.

**Question (note the typo — "Acme AI 0" instead of "Acme CO 0"; the brain only contains the latter):**

```
Has the ARR of the Acme AI 0 company grown over time? What were the readings?
```

| | Typical AI-memory stack (top-K vector retrieval, the shape MemPalace and most peer systems ship) | GBrain `think` |
|---|---|---|
| **Answer returned** (verbatim from the receipt) | <pre>Top retrieved pages:<br>1. companies/acme-co-0 — # Acme CO 0 A eval-frameworks company. Founded 2020. Focus area: [[concepts/agent-memory]]. Working on ai-infrastructure. ## Facts \| since \| claim \| metric \| value \| unit \| period \| \|-------\|-----<br>2. companies/crater-systems-5 — # Crater SYSTEMS 5 A autonomous-picking company. Founded 2022. Focus area: [[concepts/agent-memory]]...<br>3. companies/pulse-cloud-29 ...</pre> | <pre>## Answer<br><br>The question asks about "Acme AI 0". The brain contains a page for **Acme CO 0** [companies/acme-co-0] — no entity named "Acme AI 0" appears in the retrieved results. Assuming Acme CO 0 is the intended target, its ARR has grown consistently across all three readings:<br><br>- **2025-01-15**: ARR = $119,737 [companies/acme-co-0]<br>- **2025-08-20**: ARR = $502,387 (≈4.2× the prior reading) [companies/acme-co-0]<br>- **2026-04-10**: ARR = $841,657 (≈1.68× the prior reading) [companies/acme-co-0]</pre> |
| **Haiku judge score** | **0 / 10** | **9 / 10** |
| **Judge verdict** (verbatim) | *"The search results retrieved pages for incorrect companies (Crater Systems, Pulse Cloud, Vector AI, Titan Labs) instead of 'Acme AI 0', failed to extract or display any ARR metric values, and provided no information about ARR growth trajectory."* | *"Answer correctly identifies all three ARR readings in chronological order with accurate values and demonstrates consistent growth trajectory, with only minor deduction for the unresolved name discrepancy (Acme AI 0 vs Acme CO 0) which is transparently flagged rather than ignored."* |

Three things `gbrain think` did that a typical top-K retrieval cannot:

1. **Caught the name typo.** The question asked about "Acme AI 0"; the brain only has "Acme CO 0." Think flagged this transparently rather than silently returning the closest match.
2. **Walked the typed-claim Facts fence.** The synthesis combined three separate ARR readings on three different dates into a chronological trajectory with growth multipliers between them.
3. **Cited every claim.** Every number gets a `[companies/acme-co-0]` citation pointing at the source page — no floating numbers.

Across five multi-page relational questions in Cat 29, `gbrain think` averages **5.60/10** vs raw retrieval **1.60/10** — a **+4.00 point** Haiku-judged lift, with think winning 3 of 5 questions. Full receipt + the other four questions: [`docs/benchmarks/2026-05-23-v0.40.6.0-snapshot.md`](https://github.com/garrytan/gbrain-evals/blob/main/docs/benchmarks/2026-05-23-v0.40.6.0-snapshot.md).

## Install

GBrain runs in three shapes. Pick the one that matches how you use AI agents today.

### Run with your agent platform

Already using [OpenClaw](https://github.com/garrytan/openclaw) or [Hermes](https://github.com/garrytan/hermes)? GBrain installs as a skillpack scaffold into your agent's workspace.

```bash
gbrain init --pglite
gbrain skillpack scaffold --all   # or: scaffold <name> per skill
```

That's it. Your agent picks up 43 skills (signal detection, brain-ops, ingest, enrich, citation-fixer, daily-task-manager, cron-scheduler, eval framework, and 35 more). Routing lives in `skills/RESOLVER.md` — the agent reads it once per request, picks the right skill, executes. Scaffolded skills are first-class members of your agent repo — you own them, edit freely; `gbrain skillpack reference <name>` diffs your copy against gbrain's bundle when you want to pull upstream improvements. (The legacy `gbrain skillpack install` managed-block model was retired in v0.36.0.0; run `gbrain skillpack migrate-fence` once if you're upgrading from an older release.)

### CLI standalone

Use gbrain from any shell, no agent platform required.

```bash
bun install -g github:garrytan/gbrain
gbrain init --pglite   # 2 seconds; no server, no Docker
gbrain doctor          # verify health
```

Then point any MCP-aware client (Claude Code, Cursor, Windsurf) at it, or use it from your shell:

```bash
gbrain search "who works at acme AI?"
gbrain query "what did bob invest in this quarter?"
gbrain graph-query people/garry-tan --depth 2
```

Detailed setup paths (Postgres at scale, Supabase, thin-client mode) live in [`docs/INSTALL.md`](docs/INSTALL.md).

### MCP server (any MCP client)

```bash
gbrain serve              # stdio MCP (Claude Desktop / Code / Cursor)
gbrain serve --http       # HTTP MCP with OAuth 2.1 + admin dashboard
                          # at /admin, SSE activity feed at /admin/events
```

Per-client guides (Claude Desktop, Code, Cursor, ChatGPT, Perplexity, Cowork) live under [`docs/mcp/`](docs/mcp/). HTTP server supports DCR-style client registration, scope-gated access (`read`/`write`/`admin`), and built-in rate limiting.

## Search vs think

Two ways to query your brain. They are different things.

```bash
# search: raw pages, fast, no LLM cost
gbrain search "who's working on AI agents at portfolio companies?"

# think: synthesized answer with citations and gap analysis
gbrain think "who's working on AI agents at portfolio companies?"
```

`search` returns the top retrieved pages, ranked by hybrid scoring (vector + keyword + RRF + source-tier boost + reranker). Use it when you want raw material to skim: agent context windows, citation lookups, finding a specific quote.

`think` runs the same retrieval, then composes a synthesized answer across the results with explicit citations to the source pages AND an honest note on what the brain doesn't know yet. The gap analysis is the differentiator: the answer tells you when a page is stale, when a claim is uncited, when two pages contradict each other, when there's a hole you should fill.

**Why it compounds.** Pair `think` with `find_trajectory` and you get answers like *"how have the company's metrics changed AND what does the team look like right now AND what did they promise / share AND when did we last meet AND what's the value-add I can offer here"*: well-scored, well-cited, in one shot. That's the strategic moat. That's why building a 100K-page brain is worth the effort.

`gbrain agent run "..."` exposes the same surface to a sub-agent through the Minions queue, with crash-safe two-phase persistence. Same answers, durable.

## How to get data in (v0.38+)

One command, local or hosted, synchronous receipt:

```bash
gbrain capture "the thought I want to remember"
gbrain capture --file ./notes/today.md
echo "from a pipe" | gbrain capture --stdin
SLUG=$(gbrain capture "..." --quiet)
```

The page lands in the DB AND on disk in one move (the v0.38 `put_page`
write-through plumbing). Default slug `inbox/YYYY-MM-DD-<hash8>` so
captures cluster in a predictable triage location. On thin-client installs
the verb routes through MCP to the server — same command, same UX.

For webhook ingestion (Zapier / IFTTT / Apple Shortcuts):

```bash
curl -X POST https://your-brain/ingest \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: text/markdown" \
  -d "# a thought from a Shortcut"
```

For mobile capture, the inbox folder source picks up anything dropped into
`~/.gbrain/inbox/` from iOS Shortcuts / AirDrop / Drafts / Finder.

Third-party skillpacks can ship custom ingestion sources (Granola, Linear,
voice, OCR) against the versioned `IngestionSource` contract at
`gbrain/ingestion`. See [`docs/skillpack-anatomy.md`](docs/skillpack-anatomy.md).

## Recent releases

- **v0.40.6.0** — `gbrain sync --all` runs every configured source in parallel under a per-source lock invariant. `gbrain sources status` is the new at-a-glance dashboard. Live console prefix shows which source is talking when 6 jobs are running at once.
- **v0.40.4.0** — per-query graph signals in hybrid search; adjacency, cross-source, and session-demote boosts. `gbrain search --explain` shows per-stage attribution.
- **v0.40.2.0** — `gbrain think` grounds temporal answers in the typed-claim timeline. Ask "when did Marco last switch jobs" or "what was the ARR in March" and the answer is rooted in real chronology. Default on; flip `think.trajectory_enabled=false` to opt out.
- **v0.36.4.0** — `gbrain doctor --remediate --yes --target-score 90 --max-usd 5` drives the brain to 90/100 unattended. Cron-safe. Eleven new background-job types; three protected so an MCP-connected agent can't silently burn credits.
- **v0.36.2.0** — ZeroEntropy is the new default for embedding (`zembed-1` at 1280d via Matryoshka) and reranker (`zerank-2`). 2.2× faster than OpenAI (442ms vs 973ms), 2.6× cheaper ($0.05/M vs $0.13), wins 11 of 20 head-to-head, reshuffles 60% of top-1 results as a second-pass reranker. Bring your own key from [zeroentropy.dev](https://dashboard.zeroentropy.dev), or switch providers at install time with `gbrain init --pglite --embedding-model <provider:model> --embedding-dimensions <N>`.
- **v0.35.7** — Temporal trajectory + founder scorecard. Author typed metric assertions in the `## Facts` fence (`mrr=50000`, `arr=2000000`, `team_size=12`); `gbrain eval trajectory` prints chronological history with regressions flagged inline. `gbrain founder scorecard` rolls up claim accuracy, consistency, growth direction, red flags. New MCP op `find_trajectory` exposes the same data to agents.

Full notes in [`CHANGELOG.md`](CHANGELOG.md).

## What it does (the loop)

```
  signal   →   search   →   respond   →   write   →   auto-link   →   sync
  (every    (brain-first  (informed     (page +    (typed edges     (cron
  message)  retrieval)    by context)   timeline)  + backlinks)     keeps fresh)
```

- **Signal detector** runs on every message your agent receives. Captures ideas, entity mentions, time-sensitive todos, names, links.
- **Brain-first lookup** before any external API call. The cheapest, fastest, most personal information source you have.
- **Auto-link** fires on every page write. No LLM calls; pure pattern matching on `[[wiki/people/bob]]` style references. New entity → new page stub → graph grows.
- **Cron-driven enrichment** runs while you sleep: dedup people pages, fix citations, score salience, find contradictions, prep tomorrow's tasks.

The whole loop is described in [`docs/architecture/topologies.md`](docs/architecture/topologies.md) with diagrams.

## Capabilities

**Hybrid search.** Vector (HNSW on pgvector) + BM25 keyword + reciprocal-rank fusion + source-tier boost + intent-aware query rewriting. Three named search modes (`conservative`, `balanced`, `tokenmax`) bundle the cost/quality knobs into a single config key. Live cost/recall comparisons in [`docs/eval/SEARCH_MODE_METHODOLOGY.md`](docs/eval/SEARCH_MODE_METHODOLOGY.md). Default: `balanced` with ZeroEntropy reranker on. **New in v0.40.4.0:** per-query graph signals notice when a top result is a hub for THAT query (adjacency boost), is corroborated across team brains (cross-source boost), or is being crowded out by weak chunks from a chatty session (session demote). Run `gbrain search "<query>" --explain` to see per-stage attribution: base score, every boost that fired, what it multiplied. `gbrain doctor` ships a `graph_signals_coverage` check; `gbrain search stats` shows fire counts and failure breakdowns.

**Self-wiring knowledge graph.** Every `put_page` extracts entity refs from markdown/wikilinks/typed-link syntax and writes edges with zero LLM calls. Typed edges (`attended`, `works_at`, `invested_in`, `founded`, `advises`, `mentions`, …). Multi-hop traversal via `gbrain graph-query`. The graph is what produces the +31.4 P@5 lift over vector-only RAG.

**Job queue (Minions).** BullMQ-shaped, Postgres-native job queue. Durable subagents (LLM tool loops that survive crashes via two-phase pending→done persistence), shell jobs with audit, child jobs with cascading timeouts, rate leases for outbound providers, attachments via S3/Supabase storage. Replaces "spawn subagent as fire-and-forget Promise" with something that recovers from anything.

**43 curated skills.** Routing lives in [`skills/RESOLVER.md`](skills/RESOLVER.md). Covers signal capture, ingest (idea / media / meeting), enrichment, querying, brain ops, citation fixing, daily task management, cron scheduling, reports, voice, soul audit, skill creation, eval framework, and migrations. Skills are markdown files (tool-agnostic), packaged as a single skillpack the installer drops into your agent workspace.

**Eval framework.** `gbrain eval longmemeval` runs the public [LongMemEval](https://huggingface.co/datasets/xiaowu0162/longmemeval) benchmark against your hybrid retrieval. `gbrain eval export` + `gbrain eval replay` capture real queries and replay them against code changes (set `GBRAIN_CONTRIBUTOR_MODE=1`). `gbrain eval cross-modal` cross-checks an output against the task using three different-provider frontier models. Full methodology in [`docs/eval/SEARCH_MODE_METHODOLOGY.md`](docs/eval/SEARCH_MODE_METHODOLOGY.md).

**Brain consistency.** `gbrain eval suspected-contradictions` samples retrieval pairs, layered date pre-filter, query-conditioned LLM judge, persistent cache. Surfaces conflicts between takes + facts the agent has written. Wired into the daily dream cycle.

## Integrations

Data flowing into the brain. Each integration is a recipe — markdown + setup hints — that ships in `recipes/` and is discoverable via `gbrain integrations list`.

- **Voice**: Phone calls create brain pages via Twilio + OpenAI Realtime (or DIY STT+LLM+TTS). Setup recipe: [`recipes/twilio-voice-brain.md`](recipes/twilio-voice-brain.md).
- **Email + calendar**: webhook handlers that route to brain signals. [`docs/integrations/meeting-webhooks.md`](docs/integrations/meeting-webhooks.md).
- **Embedding providers**: 16 recipes covering OpenAI (default fallback), OpenRouter, Voyage, ZeroEntropy (default), Google Gemini, Azure OpenAI, MiniMax, Alibaba DashScope, Zhipu, Ollama (local), llama.cpp llama-server (local), LiteLLM proxy. Pricing matrix + decision tree in [`docs/integrations/embedding-providers.md`](docs/integrations/embedding-providers.md).
- **Credential gateway**: vault-aware secret distribution. [`docs/integrations/credential-gateway.md`](docs/integrations/credential-gateway.md).
- **MCP clients**: every major MCP client is supported. [`docs/mcp/`](docs/mcp/) per-client setup.

## Architecture

**Two engines, one contract.** PGLite (Postgres 17 via WASM, zero-config, default) for personal brains up to ~50K pages. Postgres + pgvector (Supabase or self-hosted) for shared / large / multi-machine deployments. The contract-first `BrainEngine` interface in [`src/core/engine.ts`](src/core/engine.ts) defines ~47 operations both engines implement; CLI and MCP server are generated from one source.

**Brain repo is the system of record.** Your knowledge lives in a regular git repo (your "brain repo") as markdown files. GBrain syncs the repo into Postgres for retrieval; deletes in git become soft-deletes in DB. You can publish public subsets, share team mounts, run thin-client setups pointing at a colleague's brain server. Topologies in [`docs/architecture/topologies.md`](docs/architecture/topologies.md).

**Two organizational axes (brain ⊥ source).** A *brain* is a database (your personal brain, a team mount you joined). A *source* is a repo inside that brain (wiki, gstack, an essay, a knowledge base). Routing lives in `.gbrain-source` dotfiles and resolves via a documented 6-tier precedence chain. Full diagrams in [`docs/architecture/brains-and-sources.md`](docs/architecture/brains-and-sources.md).

**Why the graph matters.** Vector search returns chunks that are semantically close. The graph returns chunks that are factually connected. Hybrid search pulls from both; auto-linking on every write keeps the graph fresh. Deep dive: [`docs/architecture/RETRIEVAL.md`](docs/architecture/RETRIEVAL.md).

## Troubleshooting

**`gbrain import` fails with `expected N dimensions, not M`?** Run `gbrain doctor`. It will print the exact `gbrain config set ...` or `gbrain retrieval-upgrade` command to repair the mismatch. You should not need to delete `~/.gbrain`. As of v0.37, fresh `gbrain init --pglite` auto-detects your embedding provider from API keys in your environment — set `OPENAI_API_KEY` (or `ZEROENTROPY_API_KEY` / `VOYAGE_API_KEY`) before running init, or pass `--embedding-model <provider>:<model>` explicitly. With multiple keys set, init fires an interactive picker. In non-TTY contexts (CI, Docker) with no keys, init exits 1 with a paste-ready setup hint; pass `--no-embedding` to defer setup until runtime. See [`docs/integrations/embedding-providers.md`](docs/integrations/embedding-providers.md) for the full provider matrix and [`docs/operations/headless-install.md`](docs/operations/headless-install.md) for Docker/CI sequencing.

## Docs

- [`docs/INSTALL.md`](docs/INSTALL.md) — every install path, end to end
- [`docs/architecture/`](docs/architecture/) — system design, topologies, retrieval theory
- [`docs/guides/`](docs/guides/) — how-to runbooks (sub-agent routing, minion deployment, skill development, brain-first lookup, idea capture, diligence ingestion)
- [`docs/integrations/`](docs/integrations/) — connecting external data sources (voice, email, calendar, embedding providers)
- [`docs/mcp/`](docs/mcp/) — per-client MCP setup (Claude Desktop, Code, Cursor, ChatGPT, Perplexity, Cowork)
- [`docs/eval/`](docs/eval/) — eval framework, metric glossary, methodology
- [`docs/ethos/`](docs/ethos/) — philosophy (thin harness, fat skills, markdown as recipes, origin story)
- [`AGENTS.md`](AGENTS.md) — entry point for non-Claude agents
- [`CLAUDE.md`](CLAUDE.md) — entry point for Claude Code (deep operating context)
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — contributor guide, test discipline, eval-capture mode
- [`SECURITY.md`](SECURITY.md) — OAuth threat model, hardening defaults

## Contributing

Run `bun run test` for the fast loop, `bun run verify` for the pre-push gate, `bun run ci:local` to run the full Docker-backed CI stack locally. Detailed test discipline in [`CONTRIBUTING.md`](CONTRIBUTING.md).

Community PRs are batched into release waves rather than merged one-by-one — see the "PR wave workflow" section in [`CLAUDE.md`](CLAUDE.md). Contributor attribution stays attached via `Co-Authored-By:` trailers. We credit every accepted contribution in [`CHANGELOG.md`](CHANGELOG.md).

If you find a bug or want a feature: open an issue first. Quick fixes (typo, doc bug, obvious regression) can go straight to a PR. Anything touching schema, retrieval ranking, MCP protocol, or the security boundary needs a design discussion in the issue first.

## License + credit

MIT. Built by Garry Tan to run his OpenClaw and Hermes deployments — the production brain behind his actual AI agents.

Origin story: [`docs/ethos/ORIGIN.md`](docs/ethos/ORIGIN.md).

Community PR contributors are credited in `CHANGELOG.md` per release. ZeroEntropy ([@zeroentropy](https://zeroentropy.dev)) for the embedding + reranker stack that became the v0.36.2.0 default. Voyage AI for the asymmetric-encoding recipe template. Ramp Labs for the search quality improvements lineage.
