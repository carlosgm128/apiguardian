// Guided walkthroughs for the demo. Each step can open a page (`go`) and
// highlight the control to use next (`target`: visible text of a button,
// link, tab or heading).
import type { DemoServer } from "./server";

export interface TourStep {
  title: string;
  body: string;
  go?: (server: DemoServer) => string | undefined;
  target?: string;
}

export interface Tour {
  id: string;
  title: string;
  summary: string;
  steps: TourStep[];
}

const run = (id: string | undefined, tab = "overview") => (id ? `/runs/${id}/${tab}` : undefined);

export const TOURS: Tour[] = [
  {
    id: "compare",
    title: "Compare two versions with AI agents",
    summary: "A deterministic diff, one worker agent per changed endpoint, and a lead agent that lists what could fail.",
    steps: [
      {
        title: "Pick the documents and the agents",
        body: "The petstore sample compares v1 (Swagger 2.0) with v2 (OpenAPI 3.0). Both are reduced to one shape first, so a format change alone isn't reported as a change. Choose Ollama to run the agents on local models. Claude is disabled because the demo has no credentials.",
        go: () => "/new",
        target: "Ollama",
      },
      {
        title: "Start the run",
        body: "This replays a real recording: qwen3.5:4b workers and a qwen3.5 lead on a local GPU. It's compressed from minutes to about 25 seconds.",
        target: "Start run",
      },
      {
        title: "Watch the pipeline",
        body: "The diff runs first, with no LLM: 6 changed endpoints, 10 of the changes breaking. Workers then fan out (two at a time), and the lead synthesizes. The timeline shows every call as it happens.",
        go: (s) => run(s.latestRun((m, _role, started) => started && m.source === "dashboard" && !m.retryOf && m.baselineName.startsWith("petstore"))),
        target: "Overview",
      },
      {
        title: "Each worker's analysis",
        body: "Per endpoint: what changed, how it changed, and what a client built against v1 would hit. Severity is judged from that client's side: a stricter request or a looser response breaks it.",
        go: (s) => run(s.latestRun((m, _role, started) => started && m.source === "dashboard" && !m.retryOf && m.baselineName.startsWith("petstore")), "workers"),
        target: "Workers",
      },
      {
        title: "Every model call, inspectable",
        body: "The Inference tab shows the exact prompt and output of each call, with tokens and latency. Documentation text is wrapped and treated as data, never as instructions.",
        go: (s) => run(s.latestRun((m, _role, started) => started && m.source === "dashboard" && !m.retryOf && m.baselineName.startsWith("petstore")), "inference"),
        target: "Inference",
      },
      {
        title: "What could fail",
        body: "The lead's risk report: each risk has a failure scenario, a mitigation and the endpoints it touches. Download report.md for the full write-up, with a summary table at the top.",
        go: (s) => run(s.latestRun((m, _role, started) => started && m.source === "dashboard" && !m.retryOf && m.baselineName.startsWith("petstore")), "risks"),
        target: "Download report.md",
      },
    ],
  },
  {
    id: "rerun",
    title: "Recover from a failed lead agent",
    summary: "The workers all succeeded but a small lead model ran out of room: rerun only the lead, with a bigger model.",
    steps: [
      {
        title: "A run where only the lead failed",
        body: "All 6 workers finished, but qwen3.5:0.8b, the lead, kept generating until its 16k context window was full. The run kept every worker analysis.",
        go: (s) => run(s.latestRun((m, role) => role === "lead-failed")),
        target: "Rerun just the lead with another model",
      },
      {
        title: "Rerun just the lead",
        body: "Keep the “lead only” scope: the 6 analyses are reused, so no worker calls are repeated. Choose qwen3.5:4b as the lead model (the one the recording used), then start the rerun. The same panel lets you switch provider when one is down.",
        target: "Start rerun",
      },
      {
        title: "Reused analyses, one new lead",
        body: "The rerun marks the 6 units as reused and makes a single model call, the lead's. It finishes with 12 risks. The original run links to its rerun.",
        go: (s) => run(s.latestRun((m, _role, started) => started && Boolean(m.retryOf))),
        target: "Risks",
      },
    ],
  },
  {
    id: "track",
    title: "Track a live API and catch a breaking change",
    summary: "Register a spec URL; apiguardian snapshots every version it sees and reports each change.",
    steps: [
      {
        title: "Tracked APIs",
        body: "Each tracked API is fetched on a schedule. A new spec hash means a new version: it's saved as a snapshot and compared with the previous one. Key order or YAML vs JSON never counts as a change.",
        go: () => "/apis",
        target: "Petstore",
      },
      {
        title: "The version history",
        body: "Petstore started at v1.0.0 (the baseline) and moved to v2.0.0, which got a diff-only report. Each tracked API has its own agent settings, so scheduled checks don't spend credits unless you choose that.",
        go: () => "/apis/petstore",
        target: "Check now",
      },
      {
        title: "Check now",
        body: "The live API has moved to v2.1.0. Click Check now: a new snapshot is saved, and a report run starts against v2.0.0 with Ollama agents.",
        target: "Check now",
      },
      {
        title: "The change report",
        body: "The summary at the top lists every changed endpoint and the applications that use it. GET /owners was removed, which breaks Owner portal and the Mobile app. Notifications went out as the run finished (see the messages at the top right).",
        go: (s) => run(s.latestRun((m) => m.origin?.trigger === "check" && m.origin.toSnapshot.startsWith("0003"))),
        target: "Overview",
      },
      {
        title: "Monitoring",
        body: "The home page (click the apiguardian logo to get back to it) follows every scheduled check: what's due next, checks per day (note the short outage a few days ago), and a check log where your new version links to its report.",
        go: () => "/",
        target: "Checks per day",
      },
    ],
  },
  {
    id: "apps",
    title: "Who is affected: applications and notifications",
    summary: "Applications declare the operations they use; impacts and Slack, Teams or pipeline notifications follow.",
    steps: [
      {
        title: "Applications",
        body: "Each application lists the tracked APIs it consumes: either every operation, or specific ones such as GET /pets/{petId}. Three are registered in this demo.",
        go: () => "/apps",
        target: "Add application",
      },
      {
        title: "An application's impact history",
        body: "Owner portal uses GET /owners and GET /pets/{petId}. Every tracked change that touches those (or spec-wide settings) is an impact here, with the risks the lead agent tied to them. Breaking impacts notify #api-alerts and trigger a GitHub repository_dispatch.",
        go: () => "/apps/owner-portal",
      },
      {
        title: "Severity thresholds",
        body: "After “Check now” in the tracking tour, Owner portal and the Mobile app got breaking impacts, so Slack, GitHub and Teams were notified. Storefront web only saw info-level changes, below its threshold, so nothing was sent. Run that tour first if you haven't.",
        go: () => "/apps",
      },
      {
        title: "Channels and deliveries",
        body: "Slack, Teams, Discord, generic webhooks (HMAC-signed), GitHub and GitLab pipelines. Secrets are masked in responses. The delivery log records every attempt. In the demo, deliveries are recorded but nothing is sent.",
        go: () => "/channels",
      },
      {
        title: "Breaking-change reports",
        body: "Impacts across applications, filtered by time, application, API or severity. Export them as Markdown or CSV, with cells guarded against spreadsheet formula injection.",
        go: () => "/reports",
        target: "Export CSV",
      },
    ],
  },
  {
    id: "gpus",
    title: "Place agents on GPUs",
    summary: "One Ollama instance per GPU; choose where workers and the lead run, and watch the load.",
    steps: [
      {
        title: "System",
        body: "Each GPU gets its own Ollama instance (gpu-a, gpu-b), because one instance can't be told which GPU to use per request. The page shows utilization, VRAM, temperature and loaded models. The demo's GPU numbers are simulated.",
        go: () => "/system",
      },
      {
        title: "GPU placement",
        body: "In New run, choose Ollama and open GPU placement. Tick both endpoints for the workers and pick one for the lead, then start the run. Worker calls go to the least busy endpoint.",
        go: () => "/new",
        target: "GPU placement",
      },
      {
        title: "Where each call ran",
        body: "The Workers tab (“Ran on”) and the Inference tab show the endpoint that served each call. This recording split the workers across gpu-a and gpu-b. Open System while it runs to see the load.",
        go: (s) => run(s.latestRun((m) => Boolean(m.config.workerEndpoints && m.config.workerEndpoints.length > 1)), "workers"),
        target: "Workers",
      },
    ],
  },
];
