import nextConfig from "eslint-config-next";

// `eslint-config-next` exports an array of flat configs, so it is spread rather
// than called. Kept as the project's only lint preset so the CI gate lints with
// exactly the rules a `next lint` user would see.
const config = [
  ...nextConfig,
  {
    // `public/**` is served verbatim to the browser and includes the service
    // worker, which is a plain worker script with worker globals (`self`,
    // `caches`, `fetch`) rather than application code — it is exercised by
    // `tests/unit/pwa.test.ts`, not by the app lint preset.
    // The Playwright run artifacts are generated output too: `playwright-report/`
    // and `blob-report/` ship a bundled HTML viewer, so linting them reports
    // hundreds of errors in vendored code and buries the real ones. They are
    // gitignored, but `eslint .` does not read `.gitignore`, so a contributor who
    // follows the visual-test instructions and then lints would hit them.
    ignores: [
      ".next/**",
      ".cache/**",
      "node_modules/**",
      "vendor/**",
      "public/**",
      "playwright-report/**",
      "blob-report/**",
      "test-results/**",
    ],
  },
];

export default config;
