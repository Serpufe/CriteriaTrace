# Changelog

Notable changes to CriteriaTrace are recorded here.

## Unreleased

- Require a live Docker backend for Linux isolation CI, run a controlled hostile PR through the real Action, and check exact base/head SHAs, token scope, event rejection, and forged verification output.
- Report a disappeared container as unavailable and add a regression for that fail-closed behavior.
- Match GitHub Enterprise remotes to the configured API host even when GitHub Actions supplies `GITHUB_API_URL`.
- Document mutable image tags and record the pulled digest in CI.
- Default repository command execution now requires a local restricted Docker container; unavailable backends fail closed with static evidence. Added explicit `--trust-repo`, `--no-exec`, and `--allow-network` policies.
- Added container process/resource limits, immediate output-limit termination, cleanup confirmation, and adversarial isolation tests.
- Repository-controlled stdout and exit codes now yield at most `PARTIAL`, including base-fails/head-passes reports.
- Restricted Git subprocess environment and removed Action auto-fetch through repository configuration.

## [0.1.0] — initial release candidate

Prepared for initial public release; not yet published.

- Added CLI commands for init, inspect, verify, doctor, and an offline regression demo.
- Added strict versioned YAML configuration, local Markdown and GitHub issue sources, and explicit/inferred criterion origins.
- Added deterministic Git candidate collection, Vitest/Jest/pytest detection, isolated base/head command execution, and versioned JSON/Markdown reports.
- Added clean/dirty working-tree detail to `doctor`, and narrowed test candidates and explicit-ID markers to avoid treating support files or incidental ID text as direct evidence.
- Added OpenAI Responses API structured mapping and opt-in generated tests, plus a deterministic provider for tests and demo.
- Added a Node 24 GitHub Action with job summary, report outputs, optional single-comment update, and fork-safe key handling.
- Hardened GitHub API destination checks, pinned OpenAI requests to the official endpoint, bounded config and requirement inputs, redacted credentials before provider/report output, escaped untrusted Markdown, and enforced a zero generated-test limit.
- Closed additional evidence and input bypasses: command arguments cannot by themselves establish `VERIFIED`, configured test arguments run unchanged, repository filesystem monitors are disabled during Git inspection, temporary HOME is outside archived content, origin URL query and fragment are omitted, and criterion/redaction work is bounded.
- Made `init --force` replace the config path atomically so a repository symlink cannot redirect the write outside the checkout.
- Closed second-pass credential disclosure paths: startup failures now redact reported command arguments, and complete or truncated PEM/PGP private key blocks are removed from collected text.
- Restricted Action execution to the `pull_request` event; other events with pull request payloads no longer reach repository command execution.
- Added CI, fixtures, security model, and maintainer documentation.
