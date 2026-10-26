import { describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server/http.js";
import { RunManager } from "../src/server/runs.js";
import { codeVersion } from "../src/server/version.js";

describe("stale server detection", () => {
  it("reports when the code on disk changed after the server started", async () => {
    let version = "aaa111";
    const server = await startDashboardServer(await new RunManager().init(), { port: 0, codeVersion: async () => version });
    try {
      const read = async () => (await fetch(new URL("/api/version", server.url))).json();
      expect(await read()).toMatchObject({ version: "aaa111", current: "aaa111", stale: false });
      version = "bbb222"; // e.g. a merge landed while the server kept running
      expect(await read()).toMatchObject({ version: "aaa111", current: "bbb222", stale: true });
    } finally {
      await server.close();
    }
  });

  it("reads the git commit of this checkout", async () => {
    expect(await codeVersion()).toMatch(/^[0-9a-f]{12}$/);
  });
});
