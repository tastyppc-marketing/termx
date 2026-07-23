import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // *.e2e.test.ts spawns a real termx-host and needs a Node environment —
    // it runs only under vitest.e2e.config.ts, never in the unit suite.
    exclude: [...configDefaults.exclude, "src/**/*.e2e.test.ts"],
  },
});
