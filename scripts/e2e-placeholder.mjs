#!/usr/bin/env node
/**
 * E2E placeholder.
 *
 * Per PRD §7 / design §15.1: all browser end-to-end and product acceptance
 * runs MUST be executed by a human on the user's real target sites
 * (e.g. CMA CGM) in real Chrome/Edge >= 125. Public demo sites, mocks and
 * local simulated pages do not count as acceptance evidence, so this project
 * intentionally does NOT script real-site automation.
 *
 * Real-browser verification is handed over to subtask 08 (manual acceptance).
 */
console.log(
  [
    "[e2e] Browser E2E is a MANUAL acceptance step (subtask 08).",
    "[e2e] Load dist/ as an unpacked extension in Chrome/Edge >= 125 and follow",
    "[e2e] .trellis/tasks/07-23-ai-crawler-helper-mvp/prd.md section 7 on the real target sites.",
    "[e2e] No automated browser E2E is executed here by design.",
  ].join("\n"),
);
