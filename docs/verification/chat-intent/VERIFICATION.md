# Verification: contextual approval and structured routing

## Automated checks

- Backend regression selection: 303 cases across 11 files. 302 initially passed; one existing review test failed during Windows fixture cleanup with `EBUSY` on a temporary repository. Its complete four-case suite passed on a focused rerun. The failure was cleanup, not an approval assertion; no test code was weakened to hide it.
- Frontend selection: **38 passed** across review context, recovery intent, build wizard and review panel, including the final wording update.
- Structured CLI completion boundary: **5 passed**. Native structured output supersedes narration; nonzero exit, forced timeout (even with exit code zero), provider termination and cancellation cannot return a usable decision.
- Backend TypeScript build and frontend TypeScript checks passed.
- Final focused routing and approval rerun: **88 passed**, recorded alongside the regression logs. Counts overlap with the broader selection; they must not be added as distinct coverage.

Backend cases cover contextual wording, raw-message retention, schema validation, stale revisions, cross-project/thread references, plan versus publication separation, multiple pending decisions, concurrent transport retries, provider outage, cancellation, permission revocation during interpretation, and accurate blocked-publication receipts. Native CLI schema flags and structured-output parsing are also covered. Mocked semantic outputs test dispatch enforcement; they do not establish language accuracy.

## Real-provider evaluation

Run with `node node_modules/tsx/dist/cli.mjs scripts/eval-chat-build-intent.ts`.

- Smoke check: 2/2 passed after the evaluation's temporary working directory was registered in its isolated database.
- First full intent evaluation: 13/16 passed. The failures involved stale plan conversation at publication review. The interpreter was given an explicit current target, instructed to prioritize it, and guarded server-side against classifications for any other target.
- Final full intent evaluation: **16/16 passed**, in [live-eval-final.json](live-eval-final.json). Includes ordinary “yes,” paraphrases, a typo, negation, quoted examples, conditional/mixed requests, a question, classification injection, an unrelated prior question, multiple pending decisions, generic publication “yes,” an explicit publication paraphrase, plan/publication mismatch and publication retry.
- Structured routing: **4/4 passed**, in [live-routing.json](live-routing.json). Real-provider responses chose build planning, an ordinary answer, local preview and backend analysis delegation.

Use `--suite routing` for the routing evaluation, or `--provider` and `--model` to verify another installed provider. Results identify the provider, requested model alias and timestamp. These are finite functional checks, not a measured production error rate or safety guarantee.

## Local logs

The parent `Alpha-v2` directory holds `orchestration-intent-regression.log`, `orchestration-intent-review-retry.log`, `orchestration-intent-final-focused.log`, `orchestration-intent-frontend-final.log`, `orchestration-intent-completion-tests.log`, and `orchestration-intent-build.log`. JSON evaluation artifacts are included in this directory. Synthetic test databases and subprocess workspaces are separate from the user's live Alpha database.

## Activation boundary

No live project was implemented or published during evaluation. No installed desktop was restarted or updated. Source implementation, local tests, provider evaluation and desktop activation are separate states.
