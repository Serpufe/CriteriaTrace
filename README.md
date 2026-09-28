# CriteriaTrace

**Trace acceptance criteria to changed code, candidate tests, and recorded execution evidence.**

CriteriaTrace helps reviewers see which requirements have supporting evidence and which remain gaps. It does not turn a code match, model suggestion, or repository-controlled test result into independent proof.

CriteriaTrace builds a reviewable path from a requirement to changed implementation, candidate tests, and the actual exit results of test commands. It reports gaps instead of turning a code match or model opinion into proof.

> **Illustrative offline run:** AC-1 was linked to `src/export.js` and an explicitly tagged test. The repository-controlled test failed on base and exited 0 on head; this is candidate evidence, not independent proof.
>
> | Criterion                                     | Status      | Evidence                                         |
> | --------------------------------------------- | ----------- | ------------------------------------------------ |
> | AC-1 — UTF-8 filenames survive archive export | **PARTIAL** | `tests/export.test.js`; base exit 1, head exit 0 |
>
> The captured Markdown and JSON from `npm run demo` are in [the saved demo example](https://github.com/Serpufe/CriteriaTrace/tree/v0.1.0/docs/examples/demo-run). The demo executes its own fixed temporary fixture in trusted host mode with the deterministic mock provider; archive paths are shortened in the saved example, and hashes and durations come from that run.

## What it does

Given a local Markdown task, GitHub issue, or pull request, CriteriaTrace:

1. preserves author-written criteria and labels model-decomposed criteria as inferred;
2. compares base and head with Git and finds changed source and candidate test files;
3. optionally asks OpenAI to map criteria to those allowlisted files or draft isolated tests;
4. runs configured tests in a restricted local Docker container when available and records command, revision, exit code, duration, and bounded output;
5. writes versioned JSON and a Markdown traceability matrix.

The deterministic mock provider and demo need no API key. Model output can suggest file links; it cannot choose commands, file paths outside the scanned set, or a test result.

## Install and quick start

Node.js 24 and Git are required. The npm registry release is pending. To install the reviewed candidate tarball locally, run `npm install -g ./criteriatrace-0.1.0.tgz` from the directory containing it. After publication, the equivalent registry command is `npm install -g criteriatrace`.

In a Git repository with at least two commits:

```sh
criteriatrace init
criteriatrace doctor
criteriatrace inspect --text "AC-1: preserve the required behavior" --base HEAD~1 --head HEAD
criteriatrace verify --text "AC-1: preserve the required behavior" --base HEAD~1 --head HEAD --no-exec --format json --output trace.json
```

`init` creates `.criteriatrace.yml`; edit the base revision and command arrays for your project. `inspect` prints candidate links without executing code. The final command writes a versioned JSON report containing exact base/head commit IDs, criterion statuses, and limitations. `--no-exec` is useful before Docker is ready. The offline `criteriatrace demo` writes a self-contained example report with no API key.

For default isolated execution, start a local Docker engine and pre-pull the pinned image for your project's framework. CriteriaTrace never pulls images during verification. The current references are in [the image policy](docs/releasing.md#sandbox-image-policy). If tests need dependencies, configure `commands.setup`; it runs under the same isolation policy and has no network by default. The original checkout is never mounted into the container.

The starter config uses strict YAML with schema version 1. Configure `commands.test` as an argument array, for example `test: [npm, test]`, and optionally `setup: [npm, ci, --ignore-scripts]`. Unknown keys and invalid values fail with a field-specific error. Config files and requirement sources are bounded; generated tests are disabled by default.

## Platform support

| Platform | CLI                  | Default isolated execution                                                  |
| -------- | -------------------- | --------------------------------------------------------------------------- |
| Linux    | CI tested on Node 24 | Linux Docker CI tested                                                      |
| macOS    | CI tested on Node 24 | Supported with a local Docker Unix socket; no live macOS sandbox test in CI |
| Windows  | CI tested on Node 24 | No isolated backend; use `--no-exec` or explicitly trusted host execution   |

## CLI

```text
criteriatrace init [--force]
criteriatrace doctor [--format text|json]
criteriatrace inspect [spec] [--issue <number>] [--text <task>] [--base <rev>] [--head <rev>]
criteriatrace verify [spec] [--issue <number>] [--text <task>] [--base <rev>] [--head <rev>]
  [--format markdown|json] [--output <path>] [--trust-repo | --no-exec] [--allow-network]
criteriatrace demo [--output-dir <path>]
```

`inspect` collects candidate evidence but never executes repository code. `verify` defaults to **isolated execution**, the safe default. If the local Docker engine or required image is unavailable, it records an unavailable execution and continues with static evidence. `--no-exec` skips commands; `--trust-repo` explicitly permits host execution with a filtered environment but without host isolation. `--allow-network` enables container bridge networking and only applies to isolated mode. No mode inherits provider or GitHub tokens into repository commands. Local issue lookup uses the `origin` GitHub remote and `GITHUB_TOKEN` or `GH_TOKEN` when available:

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
jobs:
  trace:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
          persist-credentials: false
      - run: docker pull node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 # Python uses the pinned reference in docs/releasing.md.
      - id: trace
        uses: Serpufe/CriteriaTrace@v0.1.0 # Create this immutable tag at release
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: criteriatrace-evidence
          path: ${{ steps.trace.outputs.json-report-path }}
```

Configure the project test and setup arrays so archived base/head copies can run them. The basic Action needs no token input: the PR event supplies its metadata, and `contents: read` is for checkout. To read referenced issues in a private repository, pass `github-token` with `issues: read`. To enable the optional one-comment update, set `comment: true`, pass `github-token`, and grant `issues: write` or `pull-requests: write`. Use `pull_request`; the Action rejects every other event, including `pull_request_target` and review events whose payload also contains a pull request. For forks, GitHub withholds repository secrets and CriteriaTrace also disables the key explicitly.

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

See [CONTRIBUTING.md](CONTRIBUTING.md), [docs/architecture.md](docs/architecture.md), [docs/releasing.md](docs/releasing.md), [docs/positioning.md](docs/positioning.md), and [ROADMAP.md](ROADMAP.md).
