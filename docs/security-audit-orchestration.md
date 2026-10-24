# Security-led audit orchestration

Security & Code Quality owns independent task, security and dependency assessment. Other specialists can self-check their assigned work inside the approved repository, paths and tools. The Orchestrator decides assignments and subsequent work; specialists return evidence instead of dispatching one another.

For dependency remediation, the approved flow is Security baseline evidence, a scoped implementation owner, independent Security review and re-audit, then functional validation. A baseline that finds vulnerabilities is successful evidence collection. It is not a security pass. Final acceptance requires current lockfile-bound evidence from independent Security verification; passing tests and self-checks cannot replace it.

The built-in `project_audit_dependencies` operation uses fixed npm commands, disables lifecycle scripts, bounds output and execution time, and supports cancellation. Only the assigned manifest and supported npm lockfile enter its temporary scan directory. A manifest without a lockfile may be resolved there without changing product files. Workspace, linked, non-registry and unsupported package-manager trees require separate scanner support rather than broader terminal permissions.

Persisted evidence identifies its task, repository, source commit, dependency hashes, scanner version, registry, policy and timestamp. Missing, altered, stale, failed or mismatched evidence cannot support a clean-audit claim. Registry and authentication errors remain setup blockers.

For older builds blocked by missing audit findings, **Plan with Security** preserves work and history and saves a new Markdown roadmap for review. The first milestone gathers repository-specific Security evidence. The Orchestrator plans remediation and independent verification from the accepted findings in the next milestone. Existing approvals and cancellation remain enforced.

Official instruction upgrades preserve customized personas and selected models. Chat build context and user-curated memory belong to the originating conversation. Neither shared project context nor a chat approval dropdown grants additional task capabilities.
