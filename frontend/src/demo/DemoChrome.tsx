// Demo-only UI: the "demo mode" banner, guided tours and notices from the
// in-browser server (replays, notifications that would have been sent).
import { useEffect, useState } from "react";
import { demoServer } from "./install";
import type { DemoNotice } from "./server";
import { TOURS, type Tour } from "./tours";
import "./demo.css";

const HIGHLIGHT = "demo-highlight";
const TARGETS = "button, a, legend, h1, h2, strong, [role=tab], .tab";

export default function DemoChrome() {
  const [open, setOpen] = useState(() => !window.location.hash || window.location.hash === "#/");
  const [tour, setTour] = useState<Tour | null>(null);
  const [step, setStep] = useState(0);
  const [notices, setNotices] = useState<DemoNotice[]>([]);

  useEffect(
    () =>
      demoServer.onNotice((n) => {
        setNotices((list) => [...list.slice(-4), n]);
        if (n.kind === "info") setTimeout(() => setNotices((list) => list.filter((x) => x.id !== n.id)), 7000);
      }),
    [],
  );

  useEffect(() => {
    document.body.classList.toggle("demo-tour-open", open);
  }, [open]);

  const current = tour?.steps[step];
  useHighlight(current?.target);

  const go = (t: Tour, i: number) => {
    setTour(t);
    setStep(i);
    const route = t.steps[i]?.go?.(demoServer);
    if (route) window.location.hash = route;
  };

  return (
    <>
      <div className="demo-banner" role="status">
        <span className="demo-badge">Demo</span>
        <span className="demo-long">
          Everything runs in your browser from recorded runs of real local models, replayed faster. Your actions stay in your browser; only anonymous page views are counted. Reload to reset.
        </span>
        <span className="demo-short">Recorded runs, replayed in your browser.</span>
        <span className="spacer" />
        <button className="btn" onClick={() => setOpen((o) => !o)}>{open ? "Hide tours" : "Guided tours"}</button>
      </div>

      {open && (
        <aside className="demo-tour panel" aria-label="Guided tours">
          {!tour || !current ? (
            <>
              <div className="demo-tour-head">
                <strong>Guided tours</strong>
                <button className="btn-link" onClick={() => setOpen(false)}>Close</button>
              </div>
              <p className="muted small">apiguardian compares two versions of an API's documentation and tells you what changed, how it changed, and what could break for clients. Pick a workflow:</p>
              <ol className="demo-tour-list">
                {TOURS.map((t) => (
                  <li key={t.id}>
                    <button className="demo-tour-pick" onClick={() => go(t, 0)}>
                      <strong>{t.title}</strong>
                      <span className="muted small">{t.summary}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <>
              <div className="demo-tour-head">
                <button className="btn-link" onClick={() => setTour(null)}>← All tours</button>
                <span className="muted small">Step {step + 1} of {tour.steps.length}</span>
              </div>
              <p className="muted small demo-tour-title">{tour.title}</p>
              <h3>{current.title}</h3>
              <p className="small">{current.body}</p>
              {current.go && !current.go(demoServer) && <p className="warn-box small">Do the previous step first: there's nothing to open yet.</p>}
              <div className="demo-tour-actions">
                <button className="btn" disabled={step === 0} onClick={() => go(tour, step - 1)}>Back</button>
                {current.go && current.go(demoServer) && <button className="btn" onClick={() => go(tour, step)}>Show me</button>}
                <span className="spacer" />
                {step + 1 < tour.steps.length ? (
                  <button className="btn primary" onClick={() => go(tour, step + 1)}>Next</button>
                ) : (
                  <button className="btn primary" onClick={() => setTour(null)}>Done</button>
                )}
              </div>
            </>
          )}
        </aside>
      )}

      {notices.length > 0 && (
        <div className="demo-notices" aria-live="polite">
          {notices.map((n) => (
            <Notice key={n.id} notice={n} onClose={() => setNotices((list) => list.filter((x) => x.id !== n.id))} />
          ))}
        </div>
      )}
    </>
  );
}

function Notice({ notice, onClose }: { notice: DemoNotice; onClose: () => void }) {
  const [show, setShow] = useState(false);
  return (
    <div className={`demo-notice panel ${notice.kind}`}>
      <div className="demo-tour-head">
        <strong className="small">{notice.kind === "notification" ? "✉ " : "ℹ "}{notice.title}</strong>
        <button className="btn-link small" onClick={onClose} aria-label="Dismiss">✕</button>
      </div>
      {notice.detail && <p className="muted small">{notice.detail}</p>}
      {notice.payload && (
        <>
          <button className="btn-link small" onClick={() => setShow((s) => !s)}>{show ? "Hide" : "Show"} the request it would send</button>
          {show && (
            <pre className="demo-payload">
              POST {notice.payload.url}
              {"\n\n"}
              {pretty(notice.payload.body)}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

function pretty(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body.split("&").map(decodeURIComponent).join("\n");
  }
}

/** Outlines the first visible control whose text starts with `text`, following re-renders and page changes. */
function useHighlight(text: string | undefined) {
  useEffect(() => {
    if (!text) return;
    let scrolled = false;
    const find = () => {
      for (const el of document.querySelectorAll<HTMLElement>(TARGETS)) {
        if (el.closest(".demo-tour, .demo-banner, .demo-notices")) continue;
        if (el.offsetParent !== null && (el.textContent ?? "").trim().startsWith(text)) return el;
      }
      return undefined;
    };
    const tick = () => {
      const el = find();
      for (const other of document.querySelectorAll(`.${HIGHLIGHT}`)) if (other !== el) other.classList.remove(HIGHLIGHT);
      if (!el) return;
      el.classList.add(HIGHLIGHT);
      if (!scrolled) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        scrolled = true;
      }
    };
    tick();
    const id = setInterval(tick, 400);
    return () => {
      clearInterval(id);
      for (const el of document.querySelectorAll(`.${HIGHLIGHT}`)) el.classList.remove(HIGHLIGHT);
    };
  }, [text]);
}
