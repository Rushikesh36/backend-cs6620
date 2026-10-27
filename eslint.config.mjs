import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import security from "eslint-plugin-security";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/", "build/", "dist/", "terraform/", "scanners/", "graphify-out/"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  security.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["*.mjs"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Logs must be structured JSON through common/logger, never ad-hoc console output.
      "no-console": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
    },
  },
  {
    // Tests build objects with dynamic keys and fake passwords on purpose.
    files: ["tests/**"],
    rules: { "security/detect-object-injection": "off" },
  },
  {
    // Admin scripts talk to a terminal.
    files: ["scripts/**"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
    rules: { "no-console": "off", "security/detect-non-literal-fs-filename": "off" },
  },
  {
    files: ["**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
