# CriteriaTrace report

**Schema:** 1  
**Repository:** temporary CriteriaTrace repository snapshot  
**Base:** `1926ffcdd9d33846733e45ccd2d0e1da21934df0`  
**Head:** `aac70ce41dd623d1f3d57213ce3b41dd7aef5e95`  
**Generated:** 2026-09-27T17:20:36.419Z

## Summary

| Status         | Count |
| -------------- | ----: |
| VERIFIED       |     1 |
| PARTIAL        |     0 |
| UNVERIFIED     |     0 |
| MISSING        |     0 |
| NOT_APPLICABLE |     0 |

## Traceability matrix

| Criterion                                                                                                            | Origin   | Status       | Implementation                                                                                | Tests                                                                                                                        | Reason                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------- | -------- | ------------ | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **AC-98** Git status evidence reports whether the working tree is clean and identifies tracked or untracked changes. | explicit | **VERIFIED** | `src/cli.ts:251-254` (lexical)<br>`src/git.ts` (lexical)<br>`src/verify.ts:225-228` (lexical) | `tests/self-dogfood.mjs:9-12` (explicit-id)<br>`tests/git.test.ts:6-9` (lexical)<br>`tests/verify.test.ts:167-170` (lexical) | Test output identifies an explicitly tagged criterion test and head passed (exit 0); the configured base suite failed (exit 1). |

## Executions

| ID        | Revision       | Command                       | Result        | Duration |
| --------- | -------------- | ----------------------------- | ------------- | -------: |
| base-test | `1926ffcdd9d3` | `node tests/self-dogfood.mjs` | FAIL (exit 1) |    64 ms |

<details>
<summary>base-test output</summary>

```text
file://[temporary workspace]/tests/self-dogfood.mjs:7
import { repositoryGitState } from '../src/git.ts';
         ^^^^^^^^^^^^^^^^^^
SyntaxError: The requested module '../src/git.ts' does not provide an export named 'repositoryGitState'
    at #asyncInstantiate (node:internal/modules/esm/module_job:327:21)
    at async ModuleJob.run (node:internal/modules/esm/module_job:431:5)
    at async node:internal/modules/esm/loader:643:26
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5)

Node.js v24.19.0

```

</details>

| head-test | `aac70ce41dd6` | `node tests/self-dogfood.mjs` | PASS (exit 0) | 140 ms |

<details>
<summary>head-test output</summary>

```text
✔ AC-98 reports clean, tracked-change, and untracked Git states (72.271833ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 74.178375

```

</details>

## Sources

- **markdown:** docs/examples/self-dogfood/spec.md

## Limitations

- Sanitized example: temporary repository and archive paths were redacted after execution.

> A CriteriaTrace status summarizes collected links and process results. It does not prove the change is bug-free or replace review.
