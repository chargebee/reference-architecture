import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Pin the React version explicitly so eslint-plugin-react skips its
  // auto-detection path that calls context.getFilename() — an API removed
  // in ESLint 10. Remove once eslint-plugin-react ships ESLint 10 support.
  // Tracking: https://github.com/jsx-eslint/eslint-plugin-react/issues/3977
  { settings: { react: { version: "19.2.4" } } },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
