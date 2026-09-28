# CriteriaTrace

**Trace every acceptance criterion to code, tests, and executable evidence.**

CriteriaTrace builds a reviewable path from a requirement to changed implementation, candidate tests, and the actual exit results of test commands. It reports gaps instead of turning a code match or model opinion into proof.

> **Illustrative offline run:** AC-1 was linked to `src/export.js` and an explicitly tagged test. The repository-controlled test failed on base and exited 0 on head; this is candidate evidence, not independent proof.
>
> | Criterion                                     | Status      | Evidence                                         |
> | --------------------------------------------- | ----------- | ------------------------------------------------ |
> | AC-1 — UTF-8 filenames survive archive export | **PARTIAL** | `tests/export.test.js`; base exit 1, head exit 0 |
>
> The captured Markdown and JSON from `npm run demo` are in [`docs/examples/demo-run`](docs/examples/demo-run/). The demo executes its own fixed temporary fixture in trusted host mode with the deterministic mock provider; archive paths are shortened in the saved example, and hashes and durations come from that run.

## What it does

Given a local Markdown task, GitHub issue, or pull request, CriteriaTrace:

1. preserves author-written criteria and labels model-decomposed criteria as inferred;
2. compares base and head with Git and finds changed source and candidate test files;
3. optionally asks OpenAI to map criteria to those allowlisted files or draft isolated tests;
4. runs configured tests in a restricted local Docker container when available and records command, revision, exit code, duration, and bounded output;
5. writes versioned JSON and a Markdown traceability matrix.

The deterministic mock provider and demo need no API key. Model output can suggest file links; it cannot choose commands, file paths outside the scanned set, or a test result.

## Quick start

Node.js 20.19+, 22.13+, or 24+ and Git are required. Node 24 is the primary development and Action runtime. Until the first registry release, install from source:

```sh
git clone https://github.com/Serpufe/criteriatrace.git
cd criteriatrace
npm ci
npm run build
npm link
criteriatrace --help
```

In a repository to analyze, initialize the strict config and set its base revision and test commands:

```sh
criteriatrace init
criteriatrace doctor
criteriatrace inspect task.md --base origin/main --head HEAD
criteriatrace verify task.md --base origin/main --head HEAD --format json --output reports/trace.json
```

For execution, start a local Docker engine and pull `node:24-alpine` or `python:3.13-alpine` as appropriate. CriteriaTrace never pulls an image automatically. If the test suite needs dependencies, set `commands.setup`. Setup runs inside the same restricted container policy as tests; network is disabled by default, so dependencies must already be available or network must be enabled explicitly. The original checkout is never mounted into the container.

```yaml
version: 1
provider:
  name: openai
  model: gpt-5.5
verification:
  base: origin/main
  counterfactual: true
  generatedTests: false
commands:
  setup: [npm, ci, --ignore-scripts]
  test: [npm, test]
  # Optional: generated test runner, also receives a repository-relative file path.
  generatedTest: [node, node_modules/vitest/vitest.mjs, run, '{testFile}']
limits:
  commandTimeoutSeconds: 300
  maxCommandOutputBytes: 100000
  maxContextBytes: 80000
  maxFiles: 500
  maxFileBytes: 50000
  maxGeneratedTests: 3
policy:
  failOn: [MISSING, UNVERIFIED]
```

The real starter file documents every field and defaults `generatedTests` to false. Unknown keys, malformed YAML, and invalid values fail with a path-specific error. Config files and combined requirement sources are limited to 1 MiB; a run accepts at most 500 criteria and IDs of at most 64 characters. Configured command arguments have count and size limits. Commands are argument arrays, never shell strings, and run with their configured arguments; report copies are redacted. Do not place secrets in command arguments. The isolated backend supports macOS and Linux with a local Docker Unix socket. Windows has no isolated backend; use `--no-exec` or explicitly trusted host mode.

## CLI

```text
criteriatrace init [--force]
criteriatrace doctor [--format text|json]
criteriatrace inspect [spec] [--issue <number>] [--text <task>] [--base <rev>] [--head <rev>]
criteriatrace verify [spec] [--issue <number>] [--text <task>] [--base <rev>] [--head <rev>]
  [--format markdown|json] [--output <path>] [--trust-repo | --no-exec] [--allow-network]
criteriatrace demo [--output-dir <path>]
```

`inspect` collects candidate evidence but never executes repository code. `verify` defaults to isolated execution. If the local Docker engine or required image is unavailable, it records an unavailable execution and continues with static evidence. `--no-exec` skips commands; `--trust-repo` explicitly permits host execution with a filtered environment but without host isolation. `--allow-network` enables container bridge networking and only applies to isolated mode. No mode inherits provider or GitHub tokens into repository commands. Local issue lookup uses the `origin` GitHub remote and `GITHUB_TOKEN` or `GH_TOKEN` when available:

```sh
criteriatrace verify --issue 184 --base origin/main --head HEAD --format json -o trace.json
criteriatrace verify --text "AC-1: preserve UTF-8 filenames" --base HEAD~1 --head HEAD
```

Stable exit codes:

| Code | Meaning                                                             |
| ---: | ------------------------------------------------------------------- |
|  `0` | Report written and configured status policy passed                  |
|  `1` | One or more criterion statuses match `policy.failOn`                |
|  `2` | Invalid input, configuration, source, or Git revision               |
|  `3` | A head command failed, timed out, exceeded output, or could not run |

`doctor` reports the detected repository, runtime, framework, config, provider availability, Git state, and GitHub Action context. Its JSON `git.dirty` field is `true` when tracked or untracked working tree changes exist.

`init --force` replaces the config path atomically, including when an existing path is a symlink; it does not write through that symlink.

## GitHub Action

The Action reads pull request metadata, the exact event base and head commits already present in checkout, and issue references in the PR body. It does not fetch missing commits from repository-controlled Git configuration. It writes a Markdown job summary, a versioned JSON report, and outputs the report paths. Fork PRs never receive the OpenAI key; comments are disabled by default and never written for forks.

```yaml
name: CriteriaTrace
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: read
  issues: read
jobs:
  trace:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
      - run: docker pull node:24-alpine # Use python:3.13-alpine for pytest projects.
      - id: trace
        uses: Serpufe/criteriatrace@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: criteriatrace-evidence
          path: ${{ steps.trace.outputs.json-report-path }}
```

Configure the project test and setup arrays so archived base/head copies can run them. To enable the optional one-comment update, set `comment: true`, pass `github-token`, and grant only the required comment permission (`issues: write` or `pull-requests: write`). Use `pull_request`; the Action rejects every other event, including `pull_request_target` and review events whose payload also contains a pull request. For forks, GitHub withholds repository secrets and CriteriaTrace also disables the key explicitly.

## Sources and criteria

Explicit IDs and bullets under `Acceptance criteria`, `Requirements`, or `Expected behavior` are preserved as **explicit**. When an OpenAI provider decomposes unstructured task prose, those new atomic criteria are **inferred**. Without a provider, unstructured text remains one explicit source-level requirement. GitHub Action sources retain their issue or PR URL. A requirement with the exact `[N/A]` marker is reported as `NOT_APPLICABLE`; a model cannot apply that marker.

OpenAI receives only criterion text and bounded snippets from changed source and candidate test files. Paths returned by the model are accepted only if they were in that collected file set. Model explanations and test source remain untrusted. No telemetry is collected.

## Statuses

Statuses are deterministic descriptions of collected evidence. Repository-controlled commands can never independently grant `VERIFIED`.

| Status           | Meaning                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `VERIFIED`       | Reserved for future independent evidence; current repository commands do not grant it.                                                 |
| `PARTIAL`        | Candidate implementation and test links exist, and the head command exited 0. The command and its output remain repository-controlled. |
| `UNVERIFIED`     | A changed implementation candidate exists, but no test was linked or the head command did not exit 0.                                  |
| `MISSING`        | No changed implementation candidate was found.                                                                                         |
| `NOT_APPLICABLE` | The source explicitly uses `[N/A]`; a human should review that designation.                                                            |

Base/head exit codes and test output remain visible in the report for human review. A malicious repository can fabricate both, including a base-fails/head-passes pattern.

## Supported test setups

| Framework | Detection                              | Default command                                  |
| --------- | -------------------------------------- | ------------------------------------------------ |
| Vitest    | `vitest` in package dependencies       | `node node_modules/vitest/vitest.mjs run`        |
| Jest      | `jest` in package dependencies         | `node node_modules/jest/bin/jest.js --runInBand` |
| pytest    | pytest config or Python test filenames | `python3 -m pytest -q`                           |

Set `commands.test` to use the repository's preferred script. Set `commands.generatedTest` when the default adapter cannot select a generated test file. These commands run in each temporary snapshot and need any required `commands.setup` first.

## OpenAI and generated tests

Set `OPENAI_API_KEY` or pass the Action input. The provider uses the official JavaScript SDK, Responses API parsing, a configurable model, and strict Zod schemas. If the key is absent or a request fails, CriteriaTrace records a limitation and falls back to lexical candidate matching.

Generated tests require `verification.generatedTests: true`, an OpenAI key, and a supported/configured generated test runner. Their source is included in the JSON and Markdown reports and runs under the same execution policy as other repository commands. They are never written to the original checkout. Generated test source and its runner are executable code.

## Security and privacy

By default, potentially hostile repository commands run only in a restricted local Docker container. The selected Git revision is exported to a temporary host directory and mounted read-only; the container copies it to a private tmpfs before running. The real checkout, HOME, Docker socket, and other host files are not mounted. Host environment variables and provider keys are not passed into the container. Network is disabled unless `--allow-network` is set. The process, memory, CPU, filesystem, timeout, and output limits are described in [SECURITY.md](SECURITY.md).

If Docker or the required image is unavailable, `verify` records that no command ran. `--no-exec` intentionally analyzes without commands. `--trust-repo` opts into host execution with a filtered environment; it has no filesystem or network isolation. A temporary Git archive alone is not a sandbox. Only bounded criteria and selected source/test snippets may be sent to OpenAI when enabled. CriteriaTrace has no telemetry.

## What CriteriaTrace does not prove

- A passing command does not prove that every relevant behavior is correct.
- A model or lexical match does not prove that a file implements the criterion.
- A generated test can be incomplete or wrong, even when it passes.
- A process exit code does not prove coverage, test quality, or absence of regressions outside the exercised cases.
- A temporary Git archive alone is not a security sandbox.
- Repository-controlled test output and exit status do not grant `VERIFIED`.

CriteriaTrace is not an AI code reviewer, patch generator, security scanner, formal proof system, or replacement for human review.

## Architecture

```text
Markdown / GitHub issue / pull request
                 │
       explicit and inferred criteria
                 │
     Git revisions + bounded file scan
                 │
      lexical or OpenAI candidate links
                 │
       isolated base/head commands
                 │
        versioned JSON + Markdown
```

The deterministic core owns Git facts, allowlists, command execution, exit codes, cleanup, and report status rules. The semantic provider only proposes decomposition and candidate mappings. The GitHub Action and CLI call the same verification service.

## Development

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm pack --dry-run
npm run demo
```

Tests include real temporary Git fixtures for regression, partial, missing, generated-test, malformed-config, unsupported-framework, ambiguous-source, provider-failure, and timeout paths. `npm run demo` needs no API key. A live OpenAI demo is the normal `verify` path with `OPENAI_API_KEY` and a configured OpenAI provider.

See [CONTRIBUTING.md](CONTRIBUTING.md), [docs/architecture.md](docs/architecture.md), [docs/positioning.md](docs/positioning.md), and [ROADMAP.md](ROADMAP.md).
