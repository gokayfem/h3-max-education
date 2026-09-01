import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      exclude: ["**/src/index.ts"],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80
      }
    }
  }
});
