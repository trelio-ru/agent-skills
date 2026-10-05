/**
 * Minimal shared-browser ABI fixture for provider adapter tests.
 *
 * The provider suites must not recreate bootstrap or profile lifecycle logic.
 * They only need a stable host-shaped diagnostic response to prove that their
 * CLI delegates browser ownership to the common runtime module.
 */
export const inspectBrowserRuntime = () => ({
  runtimeReady: false,
  runtimeRoot: "<shared-browser-runtime-fixture>",
  playwrightPath: null,
  playwrightVersion: null,
});

export const defaultBrowserExecutable = () => "/fixture/chrome";
