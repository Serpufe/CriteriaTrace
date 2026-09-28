# Architecture

CriteriaTrace is a TypeScript CLI and Node 24 GitHub Action around one deterministic verification service.

## Data flow

1. **Sources.** CLI Markdown, inline task text, GitHub issues, and PR title/body become versioned source records. Labeled criteria and bullets beneath requirement headings are explicit. OpenAI decomposition of unstructured prose creates separate inferred criteria. A run accepts at most 500 criteria and 64-character explicit IDs. GitHub issue lookup is HTTPS-only; public GitHub origins use the official API, and GitHub Enterprise API hosts must match the origin host.
2. **Revisions.** Git resolves base and head to commit IDs. Changed paths come from `git diff`; tracked paths come from `git ls-tree`. The working tree is not used as a head revision.
3. **Candidate collection.** Only changed source files and tracked test source files are read. Fixture data and common test support files are excluded. File count, per-file size, total collection, and model context are bounded. File paths from model output are discarded unless present in deterministic allowlists.
4. **Semantic mapping.** OpenAI uses the Responses API with Zod structured output for decomposition, candidate mapping, and optional test proposals. A deterministic lexical matcher remains available without a key. Both produce candidate links, never execution facts.
5. **Execution.** Each revision is exported with `git archive` into a temporary directory. The `ExecutionPolicy` in `src/runtime.ts` selects isolated Docker by default, explicitly trusted host execution, or no execution. In isolated mode the export is mounted read-only and copied into a container tmpfs; the host checkout is never mounted. Missing Docker/image fails closed. Command arrays run with `shell: false`, an environment allowlist, finite timeout, process/container cleanup, and a hard captured-output cap.
6. **Reporting.** One `TraceReport` is rendered as schema-versioned JSON or Markdown. Candidate links and repository-controlled exit/output can yield at most `PARTIAL`; untrusted output cannot establish `VERIFIED`.

The Action checks the event name before reading a pull request payload. Only `pull_request` is accepted, including when another event contains a `pull_request` object.

Common credential patterns, complete or truncated PEM/PGP private key blocks, and known secret environment values are redacted from source context, subprocess output, and serialized reports. Reported command arguments are redacted on normal exit and startup failure. The redactor is a safety net, not a complete secret scanner. OpenAI requests are pinned to the official API endpoint, and remote URL credentials, query, and fragment are removed from report metadata. Git inspection uses a minimal environment without global/system configuration; status disables fsmonitor and diff/object reads disable external diff and textconv. The Action does not fetch missing commits.

Configuration parsing rejects non-file config paths, files above 1 MiB, NUL bytes in command arguments, and command arrays above the documented argument limits. Combined requirement sources are also capped at 1 MiB.

## Modules

| Module                | Responsibility                                                     |
| --------------------- | ------------------------------------------------------------------ |
| `src/criteria.ts`     | Explicit criterion parsing and source-level fallback               |
| `src/config.ts`       | Strict YAML schema and starter config                              |
| `src/git.ts`          | Revision, diff, object reads, and temporary archives               |
| `src/mapper.ts`       | Test/source classification and lexical candidates                  |
| `src/provider.ts`     | OpenAI Responses API and deterministic provider interface          |
| `src/execute.ts`      | Framework detection, revision export and command selection         |
| `src/runtime.ts`      | Execution policy, Docker/host process control and output limits    |
| `src/verify.ts`       | Shared inspect/verify orchestration and statuses                   |
| `src/report.ts`       | Versioned JSON and escaped Markdown renderers                      |
| `src/cli.ts`          | CLI surface                                                        |
| `src/action/index.ts` | GitHub PR event, issue context, summary, outputs, optional comment |

## Boundaries

- Model output can suggest a candidate path only from a deterministic allowlist; it never selects a revision, command, or host path.
- A repository-controlled test runner can lie in its output and exit code. It cannot grant `VERIFIED`, even if base fails and head exits 0.
- Default isolated mode requires a local Docker Unix socket and a previously pulled image selected by a fixed multi-platform index digest. It uses `--network none`, a read-only image/source mount, separate bounded tmpfs work and temp directories, nonroot uid, dropped capabilities, no new privileges, seccomp default, and CPU, memory, process, time, and output limits. A lost container is reported unavailable. See [SECURITY.md](../SECURITY.md) for guarantees and residual risks.
- `--trust-repo` deliberately returns to host execution with filtering and best-effort process group control. `--no-exec` provides static evidence only. Neither mode is called isolated.
- Temporary Git exports are data copies and cleanup units, never the isolation boundary.

## Extension points

Additional providers implement `SemanticProvider`. Framework adapters extend `detectFramework` and the command selection in `executeRevision`. They must preserve argument-array execution, bounded output, cleanup, and deterministic report semantics.
