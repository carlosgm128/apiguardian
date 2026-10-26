import { createHmac, randomBytes } from "node:crypto";
import type { Application, Channel, Delivery, ImpactRecord } from "./types.js";

// Turns an impact into the request each channel type expects, and sends it.
// Change messages and risk text come from API documentation, which is
// untrusted: it is escaped (Slack) or mention-neutralized (Discord) and
// length-capped everywhere, so a doc string can't @-mention a whole channel.

export type NotificationEvent =
  | { kind: "impact"; app: Application; impact: ImpactRecord; reportUrl?: string }
  | { kind: "test"; channel: Channel };

export interface HttpRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

const MAX_CHANGES_IN_MESSAGE = 10;
const MAX_TEXT = 300;

/** Structured payload shared by webhook, GitHub and GitLab channels. */
export function eventPayload(event: NotificationEvent) {
  if (event.kind === "test") {
    return { event: "apiguardian.test", channel: { id: event.channel.id, name: event.channel.name }, at: new Date().toISOString() };
  }
  const { app, impact, reportUrl } = event;
  return {
    event: "api.change.impact",
    severity: impact.worst,
    application: { id: app.id, name: app.name, owner: app.owner ?? null },
    api: { id: impact.apiId, name: impact.apiName },
    versions: { from: impact.from, to: impact.to },
    counts: impact.counts,
    changes: impact.changes.slice(0, 200),
    risks: impact.risks,
    reportUrl: reportUrl ?? null,
    runId: impact.runId,
    at: impact.at,
  };
}

export function headline(event: NotificationEvent): string {
  if (event.kind === "test") return `apiguardian test message for channel "${event.channel.name}"`;
  const { app, impact } = event;
  const v = (r: ImpactRecord["from"]) => `v${r.version ?? "?"} (#${r.seq})`;
  const what =
    impact.counts.breaking > 0 ? `${impact.counts.breaking} breaking change${impact.counts.breaking === 1 ? "" : "s"}`
    : impact.counts.warning > 0 ? `${impact.counts.warning} change${impact.counts.warning === 1 ? "" : "s"} to review`
    : `${impact.changes.length || impact.risks.length} minor change${(impact.changes.length || impact.risks.length) === 1 ? "" : "s"}`;
  return `${app.name}: ${impact.apiName} ${v(impact.from)} → ${v(impact.to)} has ${what} in operations it uses`;
}

const cap = (text: string, max = MAX_TEXT) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const slackEscape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const discordSafe = (text: string) => text.replace(/@(everyone|here)/g, "@​$1");

/** Builds the HTTP request for a channel; pure, so formats are unit-testable. */
export function buildRequest(channel: Channel, event: NotificationEvent): HttpRequest {
  const json = { "content-type": "application/json", "user-agent": "apiguardian" };
  const title = headline(event);
  const changes = event.kind === "impact" ? event.impact.changes.slice(0, MAX_CHANGES_IN_MESSAGE) : [];
  const more = event.kind === "impact" ? event.impact.changes.length - changes.length : 0;
  const reportUrl = event.kind === "impact" ? event.reportUrl : undefined;

  switch (channel.type) {
    case "slack": {
      const lines = changes.map((c) => `• *${c.severity}* \`${slackEscape(cap(c.location, 120))}\`: ${slackEscape(cap(c.message))}`);
      if (more > 0) lines.push(`…and ${more} more`);
      const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: `*${slackEscape(title)}*` } }];
      if (lines.length) blocks.push({ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } });
      if (event.kind === "impact" && event.impact.risks.length) {
        const risks = event.impact.risks.slice(0, 5).map((r) => `• *${r.severity}* ${slackEscape(cap(r.title, 150))}`);
        blocks.push({ type: "section", text: { type: "mrkdwn", text: `*What could fail*\n${risks.join("\n")}` } });
      }
      if (reportUrl) blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open report" }, url: reportUrl }] });
      return { url: channel.url, headers: json, body: JSON.stringify({ text: slackEscape(title), blocks }) };
    }
    case "teams": {
      const body: unknown[] = [{ type: "TextBlock", text: cap(title, 400), weight: "Bolder", size: "Medium", wrap: true }];
      for (const c of changes) body.push({ type: "TextBlock", text: `**${c.severity}** ${cap(c.location, 120)}: ${cap(c.message)}`, wrap: true, spacing: "Small" });
      if (more > 0) body.push({ type: "TextBlock", text: `…and ${more} more`, isSubtle: true });
      const card = {
        type: "AdaptiveCard",
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        version: "1.4",
        body,
        ...(reportUrl && { actions: [{ type: "Action.OpenUrl", title: "Open report", url: reportUrl }] }),
      };
      return { url: channel.url, headers: json, body: JSON.stringify({ type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: card }] }) };
    }
    case "discord": {
      const description = changes.map((c) => `**${c.severity}** \`${cap(c.location, 120)}\`: ${cap(c.message)}`).join("\n") + (more > 0 ? `\n…and ${more} more` : "");
      return {
        url: channel.url,
        headers: json,
        body: JSON.stringify({
          content: discordSafe(cap(title, 1900)),
          embeds: description ? [{ title: "Changes", description: discordSafe(cap(description, 4000)), ...(reportUrl && { url: reportUrl }) }] : [],
          allowed_mentions: { parse: [] },
        }),
      };
    }
    case "webhook": {
      const body = JSON.stringify(eventPayload(event));
      const headers: Record<string, string> = { ...json, ...channel.headers, "x-apiguardian-event": event.kind === "test" ? "test" : "impact" };
      if (channel.secret) headers["x-apiguardian-signature"] = `sha256=${sign(channel.secret, body)}`;
      return { url: channel.url, headers, body };
    }
    case "github":
      // POST https://api.github.com/repos/OWNER/REPO/dispatches; a workflow with
      // `on: repository_dispatch: types: [<eventType>]` receives client_payload.
      return {
        url: channel.url,
        headers: { ...json, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(channel.token && { authorization: `Bearer ${channel.token}` }) },
        body: JSON.stringify({ event_type: channel.eventType || "apiguardian-api-change", client_payload: compactPayload(event) }),
      };
    case "gitlab": {
      // POST https://gitlab.example.com/api/v4/projects/ID/trigger/pipeline (form-encoded, as documented).
      const form = new URLSearchParams({ token: channel.token ?? "", ref: channel.ref || "main" });
      const p = eventPayload(event);
      form.set("variables[APIGUARDIAN_EVENT]", p.event);
      if (event.kind === "impact") {
        form.set("variables[APIGUARDIAN_APP]", event.app.name);
        form.set("variables[APIGUARDIAN_API]", event.impact.apiName);
        form.set("variables[APIGUARDIAN_SEVERITY]", event.impact.worst ?? "none");
        form.set("variables[APIGUARDIAN_BREAKING]", String(event.impact.counts.breaking));
        if (reportUrl) form.set("variables[APIGUARDIAN_REPORT_URL]", reportUrl);
      }
      form.set("variables[APIGUARDIAN_PAYLOAD]", JSON.stringify(compactPayload(event)).slice(0, 10_000));
      return { url: channel.url, headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "apiguardian" }, body: form.toString() };
    }
  }
}

/** GitHub caps client_payload at 10 top-level keys; keep the essentials. */
function compactPayload(event: NotificationEvent) {
  const p = eventPayload(event);
  if (event.kind === "test") return p;
  const { changes, risks, ...rest } = p as ReturnType<typeof eventPayload> & { changes: unknown[]; risks: unknown[] };
  return { ...rest, changes: (changes as unknown[]).slice(0, 25) };
}

export function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export interface DeliverOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryDelayMs?: number;
}

/** Sends one notification with one retry; never throws. */
export async function deliver(channel: Channel, event: NotificationEvent, options: DeliverOptions = {}): Promise<Delivery> {
  const { fetchImpl = fetch, timeoutMs = 10_000, retryDelayMs = 2000 } = options;
  const started = Date.now();
  const base = {
    id: randomBytes(6).toString("hex"),
    at: new Date(started).toISOString(),
    channelId: channel.id,
    channelName: channel.name,
    channelType: channel.type,
    test: event.kind === "test",
    ...(event.kind === "impact" && { appId: event.app.id, impactId: event.impact.id }),
  };
  let request: HttpRequest;
  try {
    request = buildRequest(channel, event);
  } catch (error) {
    return { ...base, ok: false, attempts: 0, durationMs: 0, error: (error as Error).message };
  }

  let status: number | undefined;
  let error: string | undefined;
  let attempts = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    attempts = attempt;
    try {
      const res = await fetchImpl(request.url, { method: "POST", headers: request.headers, body: request.body, signal: AbortSignal.timeout(timeoutMs) });
      status = res.status;
      if (res.ok) return { ...base, ok: true, status, attempts: attempt, durationMs: Date.now() - started };
      const text = await res.text().catch(() => "");
      error = `HTTP ${res.status}${text ? `: ${cap(text, 200)}` : ""}`;
      if (res.status !== 429 && res.status < 500) break;
    } catch (e) {
      status = undefined;
      error = (e as Error).name === "TimeoutError" ? `timed out after ${timeoutMs / 1000}s` : (e as Error).message;
    }
    if (attempt === 1) await new Promise((r) => setTimeout(r, retryDelayMs));
  }
  return { ...base, ok: false, status, attempts, durationMs: Date.now() - started, error };
}
