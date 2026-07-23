import { defineConfig } from "vitest/config";

// T8 reattach e2e (docs/memos/2026-07-23-t8-e2e-architecture.md): Node
// environment — the suite spawns a real termx-host.exe and drives the real
// HostClient over Node's global WebSocket. No jsdom, no React plugin.
// Run from ui/:  npx vitest run --config vitest.e2e.config.ts
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.e2e.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
