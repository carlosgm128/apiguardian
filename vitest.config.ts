import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["backend/test/**/*.test.ts", "frontend/test/**/*.test.ts"],
  },
});
