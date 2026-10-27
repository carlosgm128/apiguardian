# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

apiguardian compares two versions of an API's documentation (baseline = old, candidate = new) and produces:
1. **What changed** and 2. **how it changed**, per operation or section.
3. **What could fail** for clients built against the baseline docs.

Supported inputs: Swagger 2.0 / OpenAPI 3.x (`.yaml`, `.yml`, `.json`) and Markdown (`.md`). Both versions must use the same format. Swagger 2.0 vs OpenAPI 3.x counts as the same format. Support for AI-driven documentation is planned.

## Commands

```bash
npm test                                   # vitest, no network or API calls
npx vitest run backend/test/swagger-diff.test.ts   # single file
npx vitest run -t "moved sections"         # single test by name
npm run typecheck                          # tsc -p backend, then tsc -p frontend
npm run build                              # dist/ from backend/src (tsc) + dist/web from frontend/ (vite)
npm run build:web                          # dashboard only; the server serves dist/web

# Dashboard
npm run serve                              # apiguardian serve on :4319; runs stored in .apiguardian/runs
npm run dev:web                            # vite on :5173 with HMR, proxies /api to :4319 (run `npm run serve` too)

# Demo (no server: recorded runs replayed in the browser)
npm run build:demo                         # static dist/demo, relative paths
npm run dev:demo                           # vite --mode demo
npm run demo:export -- <source-dir>        # rebuild frontend/src/demo/recording.json from recorded runs

# CLI from source
npx tsx backend/src/cli.ts compare backend/test/fixtures/petstore-v1.yaml backend/test/fixtures/petstore-v2.yaml --no-agents
npx tsx backend/src/cli.ts compare old.md new.md --out report-dir   # with agents; needs Claude API credentials
npx tsx backend/src/cli.ts compare old.yaml new.yaml --simulate --ui   # fake agents, watch in the dashboard
npx tsx backend/src/cli.ts compare old.yaml new.yaml --ollama --worker-model qwen3.5:4b --lead-model qwen3.5:4b   # local agents
npx tsx backend/src/cli.ts compare old.yaml new.yaml --ollama --lead-provider claude   # local workers, Claude lead
npx tsx backend/src/cli.ts serve --ollama-url http://127.0.0.1:11434 --ollama-num-ctx 32768   # Ollama settings are server-side
npx tsx backend/src/cli.ts serve --ollama-gpus 0,1 [--ollama-models DIR]   # one managed Ollama per GPU (ids gpu0, gpu1)
npx tsx backend/src/cli.ts serve --ollama-endpoint gpu1=http://127.0.0.1:11435@1   # register your own per-GPU instance

# Tracked APIs (API change history)
npx tsx backend/src/cli.ts serve [--apis-dir .apiguardian/apis] [--no-scheduler]   # APIs page + in-process scheduler
npx tsx backend/src/cli.ts check-apis    # one pass over enabled tracked APIs, waits for reports; for cron
npx tsx backend/src/cli.ts serve --apps-dir .apiguardian/apps --public-url https://apiguardian.internal   # applications, channels; link base for notifications
npx tsx backend/src/cli.ts ui apiguardian-report     # open a finished run's events.jsonl in the dashboard
```

The CLI writes `report.md`, `report.json` and `events.jsonl` to `--out` (default `apiguardian-report/`). It exits with code 2 if any worker or the lead agent failed, or the run stopped early. With `--ui`, the server stays up after the run until Ctrl+C. Use `--port 0` to pick a free port. The dashboard needs `npm run build:web` first; otherwise the server answers 503 with that hint.

## Layout

- `backend/`: Node + TypeScript. CLI, orchestrator, differs, agents and dashboard server live in `backend/src`, with tests and sample fixtures in `backend/test`. It has its own `tsconfig.json` (nodenext). `tsconfig.build.json` emits to the root `dist/`, so `dist/cli.js` stays the bin.
- `frontend/`: the React dashboard (Vite). Source is in `frontend/src`, reducer tests in `frontend/test`, and it has its own `tsconfig.json` (bundler resolution). It builds to `dist/web`, which the backend serves.
- The root holds the single `package.json` (one `node_modules`), `vitest.config.ts` (runs both test folders) and this file. All commands run from the root.

## Architecture

The pipeline is a hybrid. Code drives the fan-out, and an agent drives the synthesis. It all lives in `backend/src/orchestrator.ts` (`compareDocs`):

1. **Detect format and diff deterministically (no LLM).**
   - OpenAPI: `swagger/normalize.ts` dereferences the spec and reduces v2 and v3 to one shape, `NSpec`. `swagger/diff.ts` then compares the two.
   - Markdown: `markdown/sections.ts` splits the doc by heading path, and `markdown/diff.ts` matches sections, detects moves, and diffs endpoint mentions and lines.
   - The output is a list of `WorkUnit`s (`backend/src/types.ts`), each holding its deterministic `Change`s.
2. **Fan out workers (code-driven).** One worker agent runs per unit through `mapWithConcurrency`. A worker that fails is recorded in `failedUnits`, and the run continues.
3. **Lead synthesis (agent-driven).** The lead agent gets all worker analyses. It can call `investigate(unitId, question)` to send a worker back to a unit, and it must finish by calling `submit_risk_report`.

Key design points:
- **Severity is judged from the baseline client's side, by direction.** In `diffSchema`, request schemas break when they get stricter (new required field, enum value removed, lower max). Response schemas break when they get looser (field removed, field made optional). Keep this rule when adding new kinds of change.
- **Unit and change ids:** a unit id is `METHOD /path/{}` with path parameter names erased so renames still match, `md:<heading path>`, or `spec:global`. Path parameters are keyed by position (`path#0`). Change ids are `<unitId>#n`, and agents cite them in `changeIds`.
- **Prose changes always go to agents.** `description-changed` and `section-changed` are `info` severity, but `--skip-info` never skips them, because semantic changes (units, defaults, behavior) hide there.
- **Agents sit behind the `AgentBackend` interface (`agents/backend.ts`).** The orchestrator never imports the SDK directly. Tests use a fake backend, and other providers or agent styles can be added as new backends.
- **Providers (`agents/factory.ts`):** `createBackend(config, ollamaSettings)` builds the backend.
  - `mode` (`claude`, `ollama`, `simulate`, `diff`) picks the workers' provider. `leadProvider` can put the lead on the other provider, in which case a `MixedBackend` routes each role.
  - Follow-up investigations always go to the workers' backend.
  - Add new providers here and in `RunConfig` / `StartRunBody`.
- **Ollama backend (`agents/ollama.ts`):** plain `fetch` against Ollama's REST API, no SDK.
  - **Workers** use `/api/chat` with `format` set to the Zod schema converted to JSON Schema, which constrains the output, plus one retry when the JSON is invalid.
  - **Lead** runs its own tool loop (`investigate`, `submit_risk_report`). It falls back to a single structured answer when `/api/show` says the model has no `tools` capability, or when the tool loop never produces a valid report.
  - **Things that bit during live testing:**
    - Always send `options.num_ctx`. Ollama silently truncates over-long prompts, so a call whose prompt fills the window throws an error instead of returning a degraded answer.
    - `prompt_eval_count` is the whole prompt, and `prompt_eval_cached_count` is a subset of it. Don't add them together.
    - Tool arguments are not grammar-constrained, and small models use words like "info" for severity. `normalizeReport` folds common synonyms before validation.
    - Only send `think` to models whose capabilities include `thinking`.
  - Unreachable server or missing model → `isFatal`.
  - The Ollama URL is a server/CLI setting (`--ollama-url`, `$OLLAMA_HOST`), never taken from API requests, to prevent SSRF.
- **GPU placement (`backend/src/compute/`):**
  - **Why one instance per GPU:** a single `ollama serve` decides GPU placement by itself, and there's no per-request way to pick a GPU. So pinning agents to GPUs means one Ollama instance per GPU (`CUDA_VISIBLE_DEVICES`, plus `ROCR_`/`HIP_VISIBLE_DEVICES` for AMD).
  - Each instance is an `OllamaEndpoint` `{ id, url, gpus? }`. You can register your own (`--ollama-endpoint id=url[@gpu]`), or have `startManagedOllama` start them (`--ollama-gpus 0,1`, ports from `--ollama-base-port`, default 11500). Managed instances are stopped on SIGINT/SIGTERM.
  - **Run config:** `workerEndpoints` (ids, default all) and `leadEndpoint` (default: the first worker endpoint). `selectEndpoints` resolves them and rejects unknown ids, so the API returns 400 for those.
  - **Routing:** `OllamaBackend.acquire()` sends each worker call to the least busy endpoint, rotating on ties. The lead counts as load on its own endpoint. Each `llm-call` records which endpoint served it (`endpoint`).
  - **Found live:** a systemd install keeps models in `/usr/share/ollama`, owned by the `ollama` user. An instance started as your user starts fine but can't read that store. `checkModelStore` fails at startup with the fix (`--ollama-models <dir>`, or run the instances as the service user and register them).
  - **GPU stats:** `listGpus()` parses `nvidia-smi` output (NVIDIA only; it reports "unavailable" without throwing). `endpointStatus()` combines `/api/version`, `/api/tags` and `/api/ps` (models loaded in VRAM).
- **Claude backend (`agents/claude.ts`):**
  - Workers use `client.beta.messages.parse` with a Zod output format.
  - The lead uses `client.beta.messages.toolRunner` with `betaZodTool`s and `max_iterations`.
  - Both send `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) and check `stop_reason` for `refusal` and `max_tokens`.
  - Both models default to `claude-opus-5-5`. Workers run at effort `medium`, the lead at `high`.
- **Agent output schemas (`agents/schemas.ts`) must stay compatible with structured outputs:** no min/max/regex refinements.
- **Documentation text is untrusted.** Prompts (`agents/prompts.ts`) wrap it in tags and tell the model to treat it as data. The dashboard renders it only as React text, never `dangerouslySetInnerHTML`.

## Reruns

A finished run can be rerun on its saved input documents (`RunManager.retry`, `POST /api/runs/:id/retry {scope, config}`), optionally with a different provider, model or effort per role. That covers a model that can't finish the task, or a provider that's down.
- **Scopes:**
  - `lead`: every worker analysis is reused, and units without one stay failed (`Not re-run: <original error>`).
  - `failed`: reuses analyses and runs workers only for units without one.
  - `all`: starts over. It's also the way to upgrade a diff-only run to one with agents.
- **How reuse works:** the orchestrator takes `CompareOptions.reuse { fromRunId, analyses, rerunMissing, failures }`, and emits `unit-reused` instead of calling a worker. Reused analyses therefore add no `llm-call` events or cost. `report.reusedUnits` and `report.retryOf` record what happened.
- **Links:** the rerun is a new run with `retryOf` and `retryScope`. The original gets `retriedBy[]`. `GET /api/runs/:id/retry-info` tells the dashboard what can be reused.
- **Tracker runs:** reruns of tracker-origin runs get `origin.trigger: "retry"`, except reruns of on-demand compares, which stay `"compare"`.
  - `AppService` replaces the original run's impacts with the rerun's (now including its risks), without notifying again.
  - `ApiTracker.relinkRun` points the version at the rerun when it succeeds.
- **Found live** (a 0.8b lead hit the output limit; the rerun's lead then got a 500 from Ollama):
  - Ollama answers 500 when it can't parse a model's tool-call output ("XML syntax error…"). That raises `OllamaToolCallError`. The lead retries the turn once, then falls back to a single structured answer.
  - Failed Ollama calls still emit an `llm-call` with `stopReason: "error"`, so they appear in the Inference view.

## Observability

Every step of a run is a `RunEvent` (`backend/src/events.ts`), stamped with `seq` and `t`.
- **Who emits what:** the orchestrator emits lifecycle events (run, unit, synthesis, `run-end` with `stopped`). Backends emit `AgentEvent`s through the `ctx.emit` passed to `analyzeUnit` and `synthesize`:
  - `llm-call`, with token usage, latency, and the exact `prompt` and `output`. That's what the Inference tab shows. For lead turns after the first, `prompt.user` holds the tool results the lead was sent.
  - `lead-tool-call` and `lead-text`.
  - A new backend should emit `llm-call` for every model call.
- **Lead timing:** `llm-call.durationMs` for the lead excludes tool execution. Investigations run inside the lead's tool calls, so without this they would be counted as lead time.
- **Cancellation and fatal errors:**
  - `CompareOptions.signal` cancels a run, and `AgentContext.signal` must be passed to every model call.
  - `AgentBackend.isFatal(error)` (bad credentials, no permission) stops the run instead of failing every unit. Units never started end up in `report.notRunUnits`.
- **Where events go:** `EventLog` fans them out to the CLI's progress log, `events.jsonl`, and the dashboard.

## API change history (`backend/src/history/`)

You register a live API's spec URL, and apiguardian keeps a snapshot of every distinct version it sees, with a report per change.
- **`spec.ts`:**
  - `fetchSpec` accepts http(s) only, with a 20 MB cap and a 20s timeout. It parses JSON or YAML and requires a `swagger`/`openapi` field.
  - `canonicalJson` sorts keys recursively (arrays keep their order) before the sha256 hash, so YAML vs JSON or key order never counts as a new version.
  - `discoverSpec` tries `DISCOVERY_PATHS` when given a base URL. A URL that names a `.json`/`.yaml` file is used exactly as given, never swapped for another document on the host.
- **`tracker.ts` (`ApiTracker`):**
  - A check fetches the spec, compares its hash with the latest snapshot, and either logs "unchanged" or saves a new snapshot. A new snapshot also starts a run against the previous one, through `RunManager.start` with an `origin`. Those runs have `source: "tracker"` and link back to the API.
  - The first snapshot is the baseline and gets no report. A rollback to an older spec is recorded as a new version (same hash as the old one).
  - Concurrent checks of one API share a single promise.
  - `tick()` checks every enabled API whose `nextCheckAt` has passed. `startScheduler()` runs `tick` every 30s inside `serve`. `now` is injectable for tests.
  - A failed fetch is logged as an `error` check and keeps the existing history.
- **Storage** (per API, under `--apis-dir`): `api.json` (written with mode 600, since request headers can hold credentials), `versions.json`, `snapshots/<seq>-<hash12>.json` (canonical spec) and `checks.jsonl`.
- **Header redaction:** API responses replace header values with `REDACTED`. A PATCH that sends `REDACTED` back keeps the stored value.
- **Report agents:** each API has its own `agents` RunConfig, defaulting to `mode: "diff"` so scheduled checks never spend credits unless you choose that. Workers and the lead each have their own model, and the lead can run on the other provider (`leadProvider`). An `agents` PATCH replaces the stored settings, merged over the defaults, so cleared fields really clear. `RunManager.validateConfig` rejects configs that could never run, such as unknown Ollama endpoints, when you add or update an API.
- **Routes:** `/api/monitoring?days`, `/api/apis` (GET, POST), `/api/apis/discover`, `/api/apis/:id` (GET, PATCH, DELETE), `/:id/check`, `/:id/compare {from,to}`, `/:id/snapshots/:snap`. Fetch problems return 422, unknown APIs 404.
- **Limit:** specs that `$ref` other files by relative URL aren't fetched further, because the snapshot is saved as a single document.

## Applications and notifications (`backend/src/apps/`)

Applications consume tracked APIs. When a tracked API gets a new version, every application that uses it gets an impact record, and the application's channels are notified if the impact is severe enough.
- **Dependencies:** an `Application` lists `dependencies` as `{ apiId, operations: "all" | string[] }`.
  - Operation keys use the unit-id form, `"GET /pets/{}"`. `operationKey()` normalizes `{petId}`, `:id`, full URLs and lowercase methods.
  - The frontend has a copy of it in `frontend/src/lib/operations.ts`, because backend code can't be bundled. Keep the two in sync.
- **Impact (`impact.ts`, `computeImpact`):** the changes in the units an application uses, plus `spec:global` changes (servers, security schemes), which affect every consumer. Lead-agent risks are included when their `affectedUnits` overlap. The result is undefined when nothing touches the application.
- **When impacts are computed:**
  - **Trigger:** `RunManager.onRunFinished` listeners run after `report.json` is written. `AppService` only reacts to tracker runs with `origin.trigger === "check"`. A manual compare between two versions is not a new change and gets no impact.
  - **Backfill:** `backfill()` recomputes an application's impacts from the existing tracker history when it is created, or when its dependencies change. Backfilled impacts never send notifications.
- **Notifications (`notify.ts`):** `buildRequest()` is pure (one formatter per type) and `deliver()` sends.
  - **Formats:** Slack Block Kit, a Teams Adaptive Card (for Workflows webhooks), Discord with `allowed_mentions` off, a generic JSON webhook (HMAC `X-Apiguardian-Signature: sha256=…` when a secret is set), GitHub `repository_dispatch` (`client_payload` capped to under 10 keys), and a GitLab pipeline trigger (form-encoded `variables[APIGUARDIAN_*]`).
  - **Retries:** one retry after network errors, 429 or 5xx; never after other 4xx.
  - **Every attempt** is appended to `deliveries.jsonl`.
  - **Untrusted text:** change text comes from API docs. It's escaped for Slack (`&<>`), mention-neutralized for Discord, and length-capped everywhere. The CSV export prefixes `= + - @` cells against spreadsheet formula injection.
- **Storage** (under `--apps-dir`): `applications.json`, `channels.json` (mode 600: webhook URLs and tokens are credentials), `impacts.jsonl` (keyed by `runId:appId`, later lines win) and `deliveries.jsonl`.
- **Channel secrets:** API responses show the URL's origin plus `REDACTED`, and mask `secret`, `token` and header values. A PATCH that sends `REDACTED` back keeps the stored value. Slack, Teams, Discord and GitHub require https; webhook and GitLab URLs may be http, for self-hosted receivers.
- **Report links:** "Open report" links use `--public-url`, defaulting to the server's own URL.
- **Run report summary:** `renderMarkdownReport(report, { applications })` starts with a Summary: the changed endpoints (with an "Applications affected" column) and an applications table. `AppService.applicationsForRun` computes this live from the report and the current applications, so it includes applications added later; it returns undefined for runs not from a tracked API. `GET /api/runs/:id/report.md` renders on request, the file is refreshed after impacts are computed, and `GET /api/runs/:id/applications` feeds the run page's Summary panel.
- **Routes:**
  - `/api/apps` (CRUD, plus `/:id/backfill`), `/api/channels` (CRUD, plus `/:id/test`), `/api/deliveries`
  - `/api/reports/breaking?since&app&api&min&format=md|csv`
  - `/api/apis/:id/operations`: operations of the latest snapshot, for the dependency picker

## Dashboard

- **Applications** (`#/apps`, `#/apps/:id`): the dependency editor (all operations, or tick specific ones from the latest spec, or paste a list), channel selection with a minimum severity, and the impact history. **Channels** (`#/channels`): per-type forms with setup help, Send test, and the delivery log. **Reports** (`#/reports`): filterable impacts across applications, with Markdown and CSV export.

- **Monitoring page** (`#/`, the home page; reached from the logo, not a nav item): checks across all tracked APIs, from `GET /api/monitoring?days=N` (1–90). The aggregation is the pure `summarizeMonitoring` (`history/monitoring.ts`), which `ApiTracker.monitoring` feeds with each API's full `checks.jsonl`. `demo/mirror.ts` has a copy: keep them in sync. Days are UTC buckets. `scheduler.running`/`tickMs` come from `startScheduler`; the page flags an API as Overdue when its `nextCheckAt` is more than two ticks past. The chart uses the validated status colors (unchanged = `--muted`, new version = `--accent`, failed = hatched `--critical`). The demo seeds a week of hourly checks with a short outage.

- **APIs page** (`#/apis`): a "Track an API" form (Detect checks the URL before saving), and a page per API (`#/apis/:id`) with the version history (newest first; each change shows its report status and breaking/warning counts), compare-any-two, Check now, Pause, settings and the check log.

- **GPU views:** the System page (`#/system`) polls `/api/compute` every 2s for GPU utilization, VRAM and temperature, plus each endpoint's loaded models. The New run form has a "GPU placement" section for choosing worker endpoints and the lead endpoint. The run header, the Workers tab ("Ran on") and the Inference tab show which endpoint served each call.

- **Server (`backend/src/server/`):**
  - `RunManager` (`runs.ts`) starts, cancels, lists and persists runs. Each run directory under `--runs-dir` holds the inputs, `events.jsonl`, `report.json`, `report.md` and `meta.json`. Runs still marked `running` at startup are marked failed.
  - `attach()` registers runs that come from the CLI (`compare --ui`) or a replay.
  - `http.ts` is plain `node:http`. Its routes are `/api/status`, `/api/runs` (GET list, POST start from a sample or uploaded files), `/api/runs/:id`, `/api/runs/:id/events` (SSE: history, then live), `/cancel`, `/report` and `/report.md`, plus the static `dist/web`.
  - **Stale servers:** the dashboard is served fresh from `dist/web`, but the backend loads its code only at startup. After a merge or rebuild, a running server keeps answering with old code, and new pages hit 404s. `server/version.ts` records the git commit (or the newest file mtime) at startup. `GET /api/version` reports `stale` when the code on disk moved on, and the dashboard's `StaleServerBanner` then asks you to restart. A 404 from `/api/version` itself means the server predates the check.
  - **Security:** it binds to 127.0.0.1 and rejects any non-loopback `Host` or `Origin` header, because a page on another site could otherwise start runs that spend API credits. Keep this check when adding routes.
- **React app (`frontend/`, Vite + React 19):**
  - Routing is in the hash: `#/` (Monitoring, the home page; `#/monitoring` also works), `#/runs`, `#/new`, `#/runs/:id/:tab/:item`, where `item` is a unit id (overview, workers) or an `llm-call` seq (inference). Every view is linkable.
  - **State:** `frontend/src/state/runState.ts` rebuilds everything from events. `applyEvent` mutates in place and dedupes by `seq`, and `useRunStream` re-renders once per frame. New event types need handling in `applyEvent` and `describeEvent` (`components/Views.tsx`).
  - **Shared types:** `frontend/src/types.ts` imports backend types with `import type` only. Nothing from `backend/` may be bundled.
  - **Colors** follow the dataviz reference palette, checked with its validator. Red and green fail the color-blindness separation check, so status is never shown by color alone: failed bars are hatched, follow-up attempts are outlined, and badges always have an icon and a label.
  - **Costs** are estimates from the list prices in `frontend/src/lib/pricing.ts`. Update them when prices or models change.
- **Demo build (`frontend/src/demo/`, Vite `--mode demo`):** the dashboard with no server, for showing the product.
  - **Isolation:** `main.tsx` installs it before rendering, and `App.tsx` lazy-loads `DemoChrome` (banner, guided tours, notices), both behind `import.meta.env.MODE === "demo"`. The regular `dist/web` build contains none of it; check this with a grep after changing those imports.
  - **The in-browser server:** `install.ts` routes `fetch('/api/…')`, `EventSource` for run events, and clicks on `<a href="/api/…">` downloads to `DemoServer` (`server.ts`). `DemoServer` mirrors the HTTP routes' responses: runs, retry, tracked APIs, applications, channels with masking, deliveries and reports. When a route or response shape changes, update it too.
  - **Mirrored helpers:** pure backend helpers it needs (`computeImpact`, `meetsSeverity`, `summarize`, `summarizeMonitoring`, report md/csv) are copied in `demo/mirror.ts`. Keep them in sync, like `lib/operations.ts`.
  - **Recordings:** `recording.json` is real recorded runs, written by `backend/scripts/export-demo.ts`. The script uses the real backend code for whatever the browser can't compute: report.md with the applications summary, operations per snapshot, and the notification requests the real formatters build for the sample apps and channels in `demo/seed.json`. It replaces local paths with file names, and fails if `$HOME` is left in the output.
  - **Replay:** events are re-timed, compressed to about 25s, and `durationMs` is scaled by the same factor; a notice says so.
  - **Picking a recording:** new runs use the recording for the chosen sample and mode. A multi-endpoint Ollama run uses `petstore-gpu`. Lead/failed reruns use `reuseAnalyses`, which keeps the original's analyses and takes the lead turns from a recording of the same units. The failed-lead run's lead rerun uses the real `lead-rerun` recording. Claude runs and uploads are refused with an explanation, since no recordings exist for them.
  - **Check now:** reveals the third recorded Petstore version and replays `tracker-2`. Impacts and "deliveries" (nothing is sent) follow the same rules as `AppService.onRunFinished`.
  - **Tours:** in `demo/tours.ts`. They highlight controls by their visible text, so renaming a button can break a step.
  - **Tests:** `frontend/test/demo-server.test.ts` drives `DemoServer` with fake timers.
  - **Hosting:** `vercel.json` deploys `dist/demo` as a static site (`npm run build:demo`). The demo must keep relative paths (`base: "./"`) and hash routing so it works from any host without rewrites. Never deploy the real dashboard publicly: the server only accepts loopback.
- **Simulated backend:** `SimulatedBackend` (`--simulate`, or "Simulated" in the dashboard) fakes worker and lead behavior: delays, token counts, prompts and outputs, one investigation, optional failures (`failureRate`), and abort support. Use it for UI work without API credentials. Simulated runs are flagged in report.md and in the UI.

## Testing notes

- `backend/test/fixtures/petstore-v1.yaml` (Swagger 2.0) vs `petstore-v2.yaml` (OpenAPI 3.0) deliberately crosses spec versions. Diffing a fixture against itself must give zero units, which guards against normalization false positives.
- The Claude backend has no live tests. Changes to `agents/claude.ts` are checked only by `tsc` against the installed SDK types.
- `backend/test/retry.test.ts` reproduces "workers fine, lead failed" with a configurable fake backend: a lead-only rerun with another model (no worker runs again), failed-workers rerun, scope validation, and impact replacement for tracked APIs without a second notification.
- `backend/test/apps.test.ts` covers operation keys, impact scoping, every channel format (including the escaping and signature checks), retry rules, and the end-to-end flow: a tracked API changes, the affected application's webhook receives a signed payload, a later-added application is backfilled, a manual compare causes no impact, and reports export. It uses an in-test evolving API and a webhook receiver.
- `backend/test/history.test.ts` drives the tracker and routes against an in-test "evolving API" server whose spec changes between requests (v1 → v2), with a fake clock for the scheduler.
- `backend/test/compute.test.ts` tests the per-GPU launcher with a fake `ollama` binary (a node script that reports `CUDA_VISIBLE_DEVICES`), so it needs no GPU. Only one GPU was available during development, so real multi-GPU placement has only been checked by registering one instance under two endpoint ids.
- `backend/test/ollama.test.ts` runs `OllamaBackend` against a scripted fake Ollama HTTP server, so it needs no real models. For a live check, run `compare --ollama` against a running `ollama serve`. `qwen3.5:4b` handles both roles.
- `backend/test/server.test.ts` drives the real HTTP server with a fast `SimulatedBackend` (`createBackend` override), and `frontend/test/run-state.test.ts` replays simulated runs through the dashboard reducer.

## Known limits

- The lead agent gets every worker analysis in one prompt. Very large APIs may need batching or compaction there.
- OpenAPI diffs ignore response headers, `examples`, and `links`. Request bodies with several media types are compared on the JSON one only.
- For Markdown, only `METHOD /path` mentions are extracted structurally. Everything else is judged by the workers.
