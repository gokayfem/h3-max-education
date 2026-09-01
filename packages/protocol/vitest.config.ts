import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80
      }
    }
  }
});
