import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // The Claude Code plugin has its own Node test runner.
    exclude: [...configDefaults.exclude, "integrations/**"],
  },
});
