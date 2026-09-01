import tsParser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { project: "./tsconfig.json", tsconfigRootDir: import.meta.dirname }
    },
    rules: {
      "no-constant-condition": "error",
      "no-debugger": "error",
      "no-duplicate-imports": "error",
      "no-fallthrough": "error",
      "no-irregular-whitespace": "error",
      "no-unreachable": "error",
      "no-unused-vars": "off"
    }
  }
];
