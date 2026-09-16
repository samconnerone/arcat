import { defineConfig, globalIgnores } from "eslint/config"
import nextCoreWebVitals from "eslint-config-next/core-web-vitals"
import nextTypescript from "eslint-config-next/typescript"

// eslint-config-next 16 ships flat configs natively — no FlatCompat needed
// (the old compat.extends() path crashed with a circular-structure error).
const eslintConfig = defineConfig([
  ...nextCoreWebVitals,
  ...nextTypescript,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "docs/**",       // nested docs sub-project — lints itself, and its .next build output must never be linted here
    "tournament/**", // static standalone page
  ]),
  {
    // Style-debt rules downgraded to warnings — the codebase predates the linter
    // being functional. Errors are reserved for rules that catch real bugs
    // (react-hooks/*, next/*). Ratchet these back to "error" as the debt is paid.
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-require-imports": "warn",
      "@typescript-eslint/no-this-alias": "warn",
      "react/no-unescaped-entities": "warn",
      // React-Compiler-era diagnostics — flag intentional, working patterns here
      // (OG-image try/catch fallbacks, cosmetic Date.now() labels, ArcatFace's
      // module UID counter). Keep visible as warnings; rules-of-hooks stays error.
      "react-hooks/error-boundaries": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/globals": "warn",
      // `<a href>` → <Link> swaps are a follow-up UX improvement, not a bug
      "@next/next/no-html-link-for-pages": "warn",
    },
  },
])

export default eslintConfig
