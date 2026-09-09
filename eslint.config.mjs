import globals from "globals";
import react from "eslint-plugin-react";

/**
 * Minimal config with one job: catch identifiers that are used but never
 * defined. Vite compiles such a file happily and the error only surfaces in
 * the browser as a blank page — that shipped twice (isSameText, then four
 * declarations lost to an aborted edit), so `npm run check` now runs this.
 */
export default [
  {
    files: ["src/**/*.{js,jsx}", "scripts/**/*.js", "server.local.js", "netlify/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node }
    },
    // Without this, ESLint cannot see that a component referenced only in JSX
    // is actually used, and no-unused-vars floods with false positives.
    plugins: { react },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: {
      "no-undef": "error",
      // A const used before its declaration throws at runtime but compiles
      // fine — the same class of blank-page bug as no-undef.
      "no-use-before-define": ["error", { functions: false, variables: true }],
      "no-dupe-keys": "error",
      "no-unreachable": "error",
      "no-const-assign": "error",
      // A filtered list computed and then never used means the UI is rendering
      // the unfiltered one — a filter that silently does nothing. That shipped
      // twice (openIssues, then the cycles table).
      "react/jsx-uses-vars": "error",
      "react/jsx-uses-react": "error",
      "no-unused-vars": ["error", { args: "none", varsIgnorePattern: "^_|^React$" }]
    }
  }
];
