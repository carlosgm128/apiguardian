import { lazy, Suspense } from "react";
import { navigate, useRoute } from "./hooks/hooks";
import { StaleServerBanner } from "./components/StaleServerBanner";
import { ApiDetailPage } from "./pages/ApiDetailPage";
import { ApisPage } from "./pages/ApisPage";
import { ApplicationDetailPage, ApplicationsPage } from "./pages/ApplicationsPage";
import { MonitoringPage } from "./pages/MonitoringPage";
import { ChannelsPage } from "./pages/ChannelsPage";
import { ReportsPage } from "./pages/ReportsPage";
import { NewRunPage } from "./pages/NewRunPage";
import { RunPage } from "./pages/RunPage";
import { RunsPage } from "./pages/RunsPage";
import { SystemPage } from "./pages/SystemPage";

// Banner and guided tours, only in the demo build.
const DemoChrome = import.meta.env.MODE === "demo" ? lazy(() => import("./demo/DemoChrome")) : null;

export function App() {
  const [page, id, tab, item] = useRoute();
  return (
    <div className="app">
      <nav className="topbar">
        <button className="brand" onClick={() => navigate()} title="DASHBOARD" aria-label="API Guardian: DASHBOARD">
          <img className="brand-logo" src={`${import.meta.env.BASE_URL}favicon-96x96.png`} alt="" width={24} height={24} />
          API GUARDIAN
        </button>
        <button className={page === "runs" ? "nav active" : "nav"} onClick={() => navigate("runs")}>Runs</button>
        <button className={page === "new" ? "nav active" : "nav"} onClick={() => navigate("new")}>New run</button>
        <button className={page === "apis" ? "nav active" : "nav"} onClick={() => navigate("apis")}>APIs</button>
        <button className={page === "apps" ? "nav active" : "nav"} onClick={() => navigate("apps")}>Applications</button>
        <button className={page === "channels" ? "nav active" : "nav"} onClick={() => navigate("channels")}>Channels</button>
        <button className={page === "reports" ? "nav active" : "nav"} onClick={() => navigate("reports")}>Reports</button>
        <button className={page === "system" ? "nav active" : "nav"} onClick={() => navigate("system")}>System</button>
      </nav>
      {DemoChrome && <Suspense fallback={null}><DemoChrome /></Suspense>}
      <StaleServerBanner />
      <main className="content">
        {page === "new" ? <NewRunPage /> : page === "system" ? <SystemPage /> : page === "apis" ? (id ? <ApiDetailPage key={id} id={id} /> : <ApisPage />) : page === "apps" ? (id ? <ApplicationDetailPage key={id} id={id} /> : <ApplicationsPage />) : page === "channels" ? <ChannelsPage /> : page === "reports" ? <ReportsPage /> : page === "runs" ? (id ? <RunPage key={id} runId={id} tab={tab} item={item} /> : <RunsPage />) : <MonitoringPage />}
      </main>
    </div>
  );
}
