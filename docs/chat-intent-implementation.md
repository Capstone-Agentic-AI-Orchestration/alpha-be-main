# Contextual chat intent and authorization

Status: implemented locally on `feat/orchestration-execution-20261028`. This is not an installed desktop release or a production deployment.

## Result

The browser sends the user's original message and the review's run ID, revision, plan version and evidence-loaded state. It no longer decides whether a phrase is approval. The server interprets ordinary wording in the context of the pending review and recent conversation. A few explicit, fully targeted commands remain an optional fast path.

Plan consent and publication consent remain separate. At plan review, natural replies such as “yes, do it” or “I approve this plan” can start the existing plan. At publication review, a generic “yes” needs clarification; the user must express the consequence, such as pushing the reviewed changes and opening the pull request. This does not require one exact phrase.

The interpreter proposes a constrained intent. It has no repository roots or MCP grants, starts without a resumed model session, and has a 60-second deadline without tool-denial retries. Native response schemas are used by Claude and Codex; other adapters must still produce a response that passes server validation. Malformed output, provider failure, cancellation, mismatched targets and ambiguous pending actions cannot authorize dispatch.

The existing authorization boundary still checks workspace role, project, conversation, current revision, plan version, stored plan availability and specialist access. Publication retains the existing validated-checkpoint checks. A second pending decision is checked again before execution. The model cannot choose another run, revise scope, grant a permission or substitute a new plan.

Human messages and their outcomes are saved. Concurrent retries share one decision operation, and later retries return the saved receipt even after build state changes. Success wording comes from the scheduler's returned state, including blocked and failed outcomes.

Normal Orchestrator routing now uses an `alpha_chat_v1` structured response for answers, planning, delegation and previews. The native schema removes the dependency on a hidden `ALPHA_ROUTE` line for the default Orchestrator. The legacy parser remains for compatibility with existing specialist replies. Invalid structured responses explicitly report that nothing was dispatched.

## Files and integration

- Backend changes are in `Alpha-v2/alpha-be-execution-redesign`.
- Matching frontend changes are in `Alpha-v2/alpha-fe-cosmo-orchestration`: `ChatView`, review-context transport, and review-panel wording/tests. That checkout contains pre-existing unrelated work; it was not reset or committed as part of this change.
- Both sides must ship together to enable context-only review messages. No active desktop restart, bundle replacement, push, merge or release was performed.
- Existing paused/recovery UI shortcuts were not replaced by a new recovery engine. This change concerns approval interpretation and Orchestrator action routing.

## Evidence and limits

See [verification details](verification/chat-intent/VERIFICATION.md). The real-model checks use synthetic messages and an isolated Alpha database; they never dispatch real builds or publish anything.

Passing a finite evaluation does not prove perfect language understanding. Model/provider changes should rerun these evaluations. Server authorization and checkpoint validation remain necessary even when the interpreter classifies a message correctly. The runtime evidence here covers the installed Anthropic CLI using its `sonnet` alias; it does not establish live parity for every supported provider or the installed desktop UI.
