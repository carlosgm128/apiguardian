import { api } from "../api";
import { usePoll } from "../hooks/hooks";

// The dashboard is served fresh from disk, but the server only loads its code
// at startup. After a merge or rebuild, a long-running `apiguardian serve`
// keeps answering with old code, and new pages fail in confusing ways (404s).
// Say so plainly instead.

export function StaleServerBanner() {
  const { data, error } = usePoll(api.version, 30_000);
  // A server older than /api/version itself answers 404 "Not found".
  const tooOld = error === "Not found";
  if (!tooOld && !data?.stale) return null;
  return (
    <div className="stale-banner" role="alert">
      <strong>Restart the apiguardian server.</strong>{" "}
      {tooOld
        ? "It's running older code than this dashboard, so newer features (like Rerun) won't work until it restarts."
        : <>The code changed since it started{data?.version && data.current ? <> (<code>{data.version}</code> → <code>{data.current}</code>)</> : null}, so newer features may not work until it restarts.</>}{" "}
      Stop it (Ctrl+C) and run <code>npm run serve</code> again, then reload this page.
    </div>
  );
}
