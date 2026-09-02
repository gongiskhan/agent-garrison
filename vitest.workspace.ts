import { configDefaults, defineWorkspace } from "vitest/config";

// Two projects, one config.
//
// Most of the ~600 suites are cheap and run best fully parallel. About thirty
// are not: each launches a real Chromium (directly through playwright, through
// browser-default's server, or through a nested `playwright test`), and several
// bind FIXED loopback ports that they refuse to share (tests/helpers/port-free).
// Under the default forks pool all of them landed on the machine at once, on
// top of the other workers, and starved: hooks timed out at 15-30s while every
// test inside them passed, and a timed-out afterAll left its fixture server
// alive on a fixed port, which then failed every later suite that wanted it.
// They pass, reliably, one at a time.
//
// So the Chromium suites form their own project with `singleFork`: vitest runs
// them after the parallel body has finished, in one worker, one file at a time,
// on an otherwise idle machine. Two consequences worth knowing:
//   - `singleFork` disables module isolation BETWEEN those files. Source files
//     are still re-evaluated per suite, but `process.env` is the one real
//     process env, so tests/setup-single-fork.ts restores it between files.
//   - The heavy tail is serial, so the full run is a few minutes longer than
//     the parallel body alone. That is the price of a green run.
//
// A new suite that launches Chromium belongs in this list. A suite that only
// spawns node processes (scheduler, own-port servers without a browser) does
// not - those are cheap enough to stay parallel.
const BROWSER_FIXTURE_SUITES = [
  "tests/browser-assert-viewport.test.ts",
  "tests/browser-observe.test.ts",
  "tests/browser-persistent-profile.test.ts",
  "tests/claude-chat-input-lifecycle-browser.test.ts",
  "tests/claude-chat-session-events-browser.test.ts",
  "tests/conversation-view.test.ts",
  "tests/drill-adversarial-run.test.ts",
  "tests/drill-authoring-api.test.ts",
  "tests/drill-authoring-e2e.test.ts",
  "tests/drill-curation-e2e.test.ts",
  "tests/drill-evidence-capture-e2e.test.ts",
  "tests/drill-evidence-feedback-e2e.test.ts",
  "tests/drill-fixture-app.test.ts",
  "tests/drill-gate-ui.test.ts",
  "tests/drill-gate.test.ts",
  "tests/drill-graduation-e2e.test.ts",
  "tests/drill-judge-helper.test.ts",
  "tests/drill-mobile-e2e.test.ts",
  "tests/drill-picker-live.test.ts",
  "tests/drill-plan-progress.test.ts",
  "tests/drill-results-e2e.test.ts",
  "tests/drill-run-e2e.test.ts",
  "tests/drill-selftest.test.ts",
  "tests/drill-spotter-capture-e2e.test.ts",
  "tests/drill-states-e2e.test.ts",
  "tests/drill-ux-e2e.test.ts",
  "tests/kanban-card-conversation.test.ts",
  "tests/kanban-history.test.ts",
  "tests/z1-end-to-end.test.ts"
];

export default defineWorkspace([
  {
    extends: "./vitest.config.ts",
    test: {
      name: "unit",
      include: ["tests/**/*.test.ts"],
      exclude: [...configDefaults.exclude, ...BROWSER_FIXTURE_SUITES]
    }
  },
  {
    extends: "./vitest.config.ts",
    test: {
      name: "browser-fixtures",
      include: BROWSER_FIXTURE_SUITES,
      // Appended to the base setupFiles by `extends` (arrays concatenate), so
      // this runs after tests/setup.ts for every file in the project.
      setupFiles: ["./tests/setup-single-fork.ts"],
      poolOptions: { forks: { singleFork: true } }
    }
  }
]);
