# apiguardian

apiguardian compares two versions of an API's documentation and tells you:

1. **What changed**, per operation or section.
2. **How it changed**: before vs after, with a severity (breaking, warning, info).
3. **What could fail** for clients built against the older docs.

It can also **track a live API**. You give it a Swagger/OpenAPI URL, and it saves every new version of the spec it finds and writes a report for each change, which builds the API's change history.

You can also register the **applications** that consume those APIs and the operations each one calls. When an API changes, the owners of the applications it affects are notified on Slack, Teams, Discord, a webhook or a CI pipeline, and the changes are collected in a **breaking-changes report**.

Supported formats: **Swagger 2.0 / OpenAPI 3.x** (`.yaml`, `.yml`, `.json`) and **Markdown** (`.md`).

## How it works

```
baseline docs ─┐
               ├─► deterministic diff ─► one worker agent per changed unit ─► lead agent ─► report
candidate docs ┘     (no LLM)              (run in parallel)                  (risk list)
```

1. **Deterministic diff.**
   - For OpenAPI, both specs are converted to a common shape (Swagger 2.0 and OpenAPI 3.x can be compared with each other) and compared operation by operation.
   - Severity is judged from the side of a client built against the old docs. A request that gets stricter is breaking (new required field, removed enum value, lower maximum). So is a response that gets looser (field removed, field made optional).
   - For Markdown, sections are matched by heading. Moved sections are detected, along with changes to which `METHOD /path` endpoints each section mentions, and line diffs.
2. **Worker agents.** One agent per changed operation or section explains what changed in client terms. It double-checks the severity and reads the prose for semantic changes a schema diff can't see, such as units, defaults and behavior.
3. **Lead agent.** Merges the workers' findings into a ranked list of what could fail. It can send a worker back to an operation or section with a follow-up question before it submits.

Agents are optional. The diff alone already produces a useful report, at no cost.

## Requirements

- Node.js 20 or newer
- For Claude agents: an Anthropic API key (`ANTHROPIC_API_KEY`) or a profile from `ant auth login`
- For local agents: [Ollama](https://ollama.com) with a model installed (e.g. `ollama pull qwen3.5:4b`)
- For GPU stats in the dashboard: `nvidia-smi` (NVIDIA only)

## Setup

```bash
npm install
npm run build          # backend to dist/, dashboard to dist/web
```

Run the CLI from source with `npx tsx backend/src/cli.ts …`, or after building with `node dist/cli.js …`. Run `npm link` once to get an `apiguardian` command. The examples below use that name.

## Quick start

Compare the bundled sample specs, without agents:

```bash
apiguardian compare backend/test/fixtures/petstore-v1.yaml backend/test/fixtures/petstore-v2.yaml --no-agents
# 27 changes (10 breaking) in 6 units. Report: apiguardian-report/report.md
```

Each run writes these files to `--out` (default `apiguardian-report/`):

| File | Contents |
|---|---|
| `report.md` | A summary (every changed endpoint, and the applications it affects for tracked APIs), then what could fail, then what changed and how |
| `report.json` | The same data, machine-readable |
| `events.jsonl` | Every step of the run, including each LLM call's prompt, output and token usage |

The exit code is 2 if any agent failed or the run stopped early.

## Agents

| Mode | Flag | What runs | Cost |
|---|---|---|---|
| Diff only | `--no-agents` | Deterministic diff | Free |
| Claude | *(default)* | Claude workers and lead (`claude-opus-5-5` by default) | API usage |
| Ollama | `--ollama` | Local models through Ollama | Free (your hardware) |
| Mixed | `--ollama --lead-provider claude` | Local workers, Claude lead (or the reverse) | Lead only |
| Simulated | `--simulate` | Fake agents with realistic timing | Free; for trying the UI |

```bash
# Claude
export ANTHROPIC_API_KEY=...
apiguardian compare old.yaml new.yaml

# Local models
apiguardian compare old.yaml new.yaml --ollama --worker-model qwen3.5:4b --lead-model qwen3.5:4b
```

Useful options:
- `--concurrency <n>`: number of workers running at once (default 4).
- `--worker-model` / `--lead-model`: a Claude model id or an Ollama model name.
- `--worker-effort` / `--lead-effort`: `low` … `max` (Claude only).
- `--skip-info`: don't send info-only changes to workers. Prose edits are always reviewed.

**Ollama notes:**
- **Context window:** apiguardian always sends a context window size (`--ollama-num-ctx`, default 16384), because Ollama silently cuts off longer prompts. A prompt that fills the window fails with a message saying to raise it.
- **Models without tool support:** the lead writes the report in one step and can't send follow-up questions to workers.
- **Server:** if Ollama isn't running, or a model isn't installed, the run stops with a hint (`ollama serve`, `ollama pull …`).
- **"Hit the output length limit":** the model kept generating until its context window was full. Small models (e.g. `qwen3.5:0.8b` as the lead) often do this on bigger tasks. Use **Rerun → Only the lead agent** with a larger model or another provider. The workers' analyses are reused, so nothing else runs again.
- **Malformed tool calls:** if Ollama can't parse a model's tool call (an HTTP 500 such as "XML syntax error"), the lead retries the turn once. If it fails again, the lead writes the report in one step instead.
- **Failed calls:** model calls that error out still appear in the run's **Inference** tab, with the error, so you can see what was sent.

## Dashboard

```bash
apiguardian serve          # http://127.0.0.1:4319
```

- **Monitoring** (the home page; click the **apiguardian** logo to get back to it): the scheduled checks across all tracked APIs. Shows what is due next, checks per day (unchanged, new version, failed), per-API stats and a filterable check log (see [Monitoring](#monitoring)).
- **Runs:** every run with its status, mode, duration, breaking-change count, LLM calls, tokens and estimated cost.
- **New run:** use a sample or upload two files, then pick the agents, models, effort, concurrency and GPU placement. Running runs can be cancelled.
- **Run view:**
  - a live timeline of workers and the lead
  - **Workers**: tokens and time per unit, and where each ran
  - **Inference**: every LLM call with its exact prompt, output, latency, tokens and estimated cost
  - **Changes**, **Risks** and **Events** tabs
  - every view and selection has its own URL, so you can share links
- **APIs:** tracked APIs and their version history (see below).
- **Applications, Channels, Reports:** which applications use which APIs, where to notify them, and breaking-change reports (see below).
- **System:** live GPU utilization, VRAM and temperature, and the models loaded in each Ollama instance.
- **Restart banner:** if the server is running older code than the dashboard (e.g. after an update), a banner asks you to restart it. See [Updating](#updating).

**Rerun** a finished run from its page. This helps when a model couldn't finish (e.g. "hit the output length limit") or a provider was down. Choose what to rerun:

- **Only the lead agent:** reuses every worker analysis, so only the final synthesis runs again.
- **Failed workers and the lead:** reruns only the workers that failed or never ran, then the lead.
- **Everything:** runs all workers and the lead again on the same documents.

For each role you can switch provider, model and effort, e.g. from a small Ollama model to a larger one, or to Claude if Ollama is overloaded, or the reverse. The rerun is a new run linked to the original. Reused analyses cost nothing. For a tracked API, the rerun's report replaces the original in the version history and in applications' impacts, without notifying anyone again.

To watch a single CLI run in the dashboard, add `--ui` to `compare`. To reopen a finished run, use `apiguardian ui <report-dir>`.

The server only listens on 127.0.0.1, and it rejects requests from other sites, so a web page can't start runs that spend your API credits.

## Demo

A server-free build of the dashboard, for showing apiguardian to someone. Everything runs in the browser from recorded runs of real local models (qwen3.5 on Ollama), replayed in compressed time. No server, API key or GPU is needed, and nothing is sent anywhere.

```bash
npm run build:demo     # static site in dist/demo; host it anywhere (it uses relative paths)
npm run dev:demo       # the same with hot reload on :5173
```

A **Guided tours** panel walks through five workflows:

1. **Compare two versions with AI agents:** the diff, one worker per endpoint, the lead's risk report, and every model call.
2. **Recover from a failed lead agent:** a real run where qwen3.5:0.8b ran out of context, rerun with only the lead on qwen3.5:4b.
3. **Track a live API:** "Check now" finds Petstore v2.1.0 and starts a report run.
4. **Applications and notifications:** three sample applications. The change notifies Slack, Teams and GitHub, and the demo shows each request that would be sent. Reports can be exported.
5. **Place agents on GPUs:** the System page (simulated GPU stats) and a run split across two Ollama endpoints.

Everything else works too: create applications and channels, rerun any run, compare versions. State is in memory and resets on reload. Claude runs and uploaded files aren't available, because there are no recordings for them.

### Deploy to Vercel

`vercel.json` deploys the demo as a static site: it runs `npm ci` and `npm run build:demo` and serves `dist/demo`. Hashed files in `assets/` are cached for a year. Routing lives in the URL hash, so no rewrites are needed.

- **From Git:** import the repository in Vercel and leave the project settings at their defaults (root directory `./`); `vercel.json` sets the rest.
- **From the CLI:** `npx vercel` for a preview, `npx vercel --prod` for production.

Only the demo is deployed. The real dashboard needs `apiguardian serve`, which only accepts loopback connections.

The recordings live in `frontend/src/demo/recording.json`. To refresh them with your own runs, put the run directories (from `serve`'s runs dir, or from `compare --out`) and a tracked API directory in one folder, as described at the top of `backend/scripts/export-demo.ts`, then run `npm run demo:export -- <folder>`.

## Tracking a live API

On the dashboard's **APIs** page, click **Track an API**:

1. **URL:** paste the spec URL or the API's base URL, then click **Detect**. With a base URL, it looks in the usual places (`/openapi.json`, `/v3/api-docs`, `/swagger.json`, …).
2. **Request headers:** add any the spec needs (e.g. `Authorization`). They're stored in a file only you can read and never shown again.
3. **Schedule:** choose how often to check (manual, 15 min, hourly, 6 h, daily, weekly).
4. **Report:** choose what writes the report for each new version. The default is diff-only, so scheduled checks never cost money unless you choose otherwise. With agents, pick a model for the workers and a separate one for the lead. The lead can also run on the other provider, e.g. local Ollama workers with a Claude lead.

What happens next:
- **First check:** saves the first version, which later versions are compared with.
- **Later checks:** save a new version only when the spec's content actually changed. The same spec served as YAML instead of JSON, or with keys reordered, doesn't count as a change.
- **Each new version:** gets a report against the previous one, linked from the version history. Any two versions can also be compared.
- **Rollbacks:** going back to an older spec is recorded as a new version, so the history shows it.

Checks run while `apiguardian serve` is running. If the server isn't always up, use cron instead:

```bash
*/30 * * * * cd /path/to/apiguardian && apiguardian check-apis
```

### Monitoring

The **Monitoring** page is the dashboard's home page, and the **apiguardian** logo leads back to it. It shows the recurring checks of every tracked API in one place. It refreshes every 10 seconds.

- **Overview:** tracked and paused APIs, checks and new versions in the chosen window (today, 7, 30 or 90 days), failed checks with the failure rate, and the next scheduled check.
- **Checks per day:** a bar per day (UTC), split into unchanged, new version and failed. Failed checks are also hatched. Hover a bar for its numbers.
- **Schedule:** every API with its last result, interval, last check, a countdown to the next check, version count, last change, and its checks, failures and average fetch time in the window. A check that is more than two scheduler ticks late is flagged **Overdue**. If the server runs with `--no-scheduler`, the page says so.
- **Check log:** every check, newest first, filterable by API and by result (new versions, failures). A new version links to its report, and a failure shows its error.

Data comes from `GET /api/monitoring?days=7`, built from each API's `checks.jsonl`. Checks run by `check-apis` from cron show up too.

Tracked APIs are stored in `.apiguardian/apis/` (change it with `--apis-dir`) and runs in `.apiguardian/runs/` (change it with `--runs-dir`).

## Applications, notifications and reports

Track the applications that consume your APIs, so the right people hear about the changes that affect them.

1. **Applications:** add an application (name, owning team, contact). Then, for each tracked API it uses, choose **All operations** or the specific operations it calls. You can tick them from the API's current spec, or paste a list such as `GET /pets/{id}` (e.g. from client code, a gateway or access logs).
2. **Channels:** add where notifications go, then click **Send test** to check it works:

   | Type | What you need |
   |---|---|
   | Slack | An incoming webhook URL |
   | Microsoft Teams | A Workflows "post to a channel when a webhook request is received" URL (Adaptive Card messages) |
   | Discord | A channel webhook URL |
   | Webhook | Any URL that accepts a JSON POST. Add a secret to get an `X-Apiguardian-Signature: sha256=…` HMAC header |
   | GitHub Actions | A `repository_dispatch` URL and a token. Start a workflow with `on: repository_dispatch: types: [apiguardian-api-change]` |
   | GitLab CI | A pipeline trigger URL, a trigger token and a branch. The pipeline gets `APIGUARDIAN_*` variables |

3. **Notifications:** on the application's page, pick its channels and when to notify (breaking changes only, breaking changes and warnings, or every change).

When a tracked API gets a new version, apiguardian works out what it means for each application that uses it:
- **Which changes count:** only changes to the operations that application calls, plus spec-wide changes such as removed servers or new authentication, which affect everyone.
- **What gets recorded:** each application gets an impact record, and its channels are notified if the impact is severe enough.
- **What a notification contains:** the application, the API and versions, the changes, the risks (when agents ran), and an **Open report** link. Use `--public-url` if the dashboard is reachable at another address.
- **New applications:** an application you add later gets its history computed from past changes, without notifications.

**Reports** lists impacts across applications, filterable by period, application, API and severity, with **Export Markdown** and **Export CSV**. Each application's page shows its own impact history.

Webhook URLs, secrets and tokens are stored in `.apiguardian/apps/channels.json`, which only you can read, and are never shown again in the dashboard.

## GPU placement (Ollama)

A single Ollama server decides GPU placement by itself, so pinning agents to specific GPUs needs one Ollama instance per GPU:

```bash
# Let apiguardian start and stop one Ollama per GPU (endpoint ids gpu0, gpu1)
apiguardian serve --ollama-gpus 0,1

# Or register instances you run yourself
apiguardian serve --ollama-endpoint gpu0=http://127.0.0.1:11434@0 --ollama-endpoint gpu1=http://127.0.0.1:11435@1
```

In **New run → GPU placement**, choose which endpoints the workers use. Each worker call goes to the least busy one. You can also put the lead on its own GPU. From the CLI, use `--worker-endpoints gpu0,gpu1 --lead-endpoint gpu1`.

If Ollama was installed as a systemd service, its models live in `/usr/share/ollama` and belong to the `ollama` user. Instances that apiguardian starts as your user can't read them. Either point them at a model store you can read (`--ollama-models <dir>`), or run the per-GPU instances as the service user and register them with `--ollama-endpoint`.

## CLI reference

```
apiguardian compare <baseline> <candidate> [options]
apiguardian serve [--port <n>] [--runs-dir <dir>] [--apis-dir <dir>] [--apps-dir <dir>] [--public-url <url>] [--no-scheduler]
apiguardian check-apis [--runs-dir <dir>] [--apis-dir <dir>] [--apps-dir <dir>] [--public-url <url>]
apiguardian ui <report-dir | events.jsonl> [--port <n>]
```

`apiguardian --help` lists every option.

Data lives in `.apiguardian/` next to where you run it: `runs/` (reports and event logs), `apis/` (tracked APIs and their spec snapshots) and `apps/` (applications, channels, impacts, deliveries). `--public-url` sets the dashboard address used in notification links.

## Updating

After pulling or merging new changes:

```bash
npm install
npm run build
# then restart the server: stop `apiguardian serve` / `npm run serve` (Ctrl+C) and start it again
```

The dashboard's pages load straight from the new build, but a running server keeps its old code until it restarts. Until then, new features can fail with "Not found" errors. If that happens, the dashboard shows a **"Restart the apiguardian server"** banner at the top, with the code versions involved.

## Development

```bash
npm test                                          # all tests (no network, no API calls, no GPU needed)
npx vitest run backend/test/swagger-diff.test.ts  # one file
npm run typecheck                                 # backend and frontend
npm run serve                                     # dashboard from source on :4319
npm run dev:web                                   # dashboard with hot reload on :5173 (needs `npm run serve` running)
npm run dev:demo                                  # the demo build with hot reload (no server needed)
```

Project layout:

```
backend/
  src/
    cli.ts            commands
    orchestrator.ts   diff → workers → lead
    swagger/          OpenAPI normalizer and differ
    markdown/         Markdown section differ
    agents/           Claude, Ollama and simulated backends, prompts, output schemas
    compute/          GPU discovery, per-GPU Ollama instances
    history/          live API tracking (spec fetching, snapshots, scheduler)
    apps/             applications, impact matching, notification channels, reports
    server/           dashboard HTTP API and run manager
    report/           report.md renderer
  scripts/            export-demo.ts (packages recordings for the demo)
  test/               tests and sample fixtures
frontend/
  src/                React dashboard (Vite)
    demo/             in-browser server, recordings and guided tours for the demo build
  test/
```

`CLAUDE.md` has the detailed design notes.

## Limitations

- OpenAPI diffs ignore response headers, `examples` and `links`. Request bodies with several media types are compared on the JSON one.
- For Markdown, only `METHOD /path` mentions are extracted structurally. Everything else is judged by the agents.
- The lead agent gets every worker's analysis in one prompt, so very large APIs may hit model context limits.
- Tracked specs that reference other files by relative URL (`$ref`) are saved as a single document; those files aren't fetched.
- GPU stats need `nvidia-smi`. Multi-GPU placement has been tested on a single-GPU machine only(im poor to own a rtx 6000).
- Cost figures in the dashboard are estimates from list prices.
