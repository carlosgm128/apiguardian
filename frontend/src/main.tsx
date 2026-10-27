import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const render = () =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

// `npm run build:demo`: no server; /api is answered in the browser from recorded runs.
if (import.meta.env.MODE === "demo") void import("./demo/install").then((demo) => demo.installDemo()).then(render);
else render();
