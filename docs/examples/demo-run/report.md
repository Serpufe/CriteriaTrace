# CriteriaTrace report

**Schema:** 1  
**Repository:** temporary demo fixture \(removed after execution\)  
**Base:** `69e1b49d4122b23d96e1b76ec6dccefe14590152`  
**Head:** `d205f6828fecadc8cff521bd5e48e3c1ae9ad89a`  
**Execution:** trusted; network host-policy  
**Generated:** 2026-09-28T06:05:47.684Z

## Summary

| Status | Count |
| --- | ---: |
| VERIFIED | 0 |
| PARTIAL | 1 |
| UNVERIFIED | 0 |
| MISSING | 0 |
| NOT_APPLICABLE | 0 |

## Traceability matrix

| Criterion | Origin | Status | Implementation | Tests | Reason |
| --- | --- | --- | --- | --- | --- |
| **AC\-1** UTF\-8 filenames survive archive export\. | explicit | **PARTIAL** | `src/export.js:1-1` (lexical) | `tests/export.test.js:3-6` (explicit\-id) | The repository\-controlled base command exited 1 and head exited 0\. This is candidate evidence, not independent verification\. |

## Executions

| ID | Revision | Command | Result | Duration |
| --- | --- | --- | --- | ---: |
| base\-test | `69e1b49d4122` | `node --test` | FAIL (exit 1) | 82 ms |

<details>
<summary>base\-test output</summary>

```text
✖ AC-1 preserves UTF-8 filename (0.6525ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 46.420084

✖ failing tests:

test at tests/export.test.js:6:1
✖ AC-1 preserves UTF-8 filename (0.6525ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  
  + 'caf.zip'
  - 'café.zip'
        ^
  
      at TestContext.<anonymous> (file://[temporary workspace]/tests/export.test.js:7:10)
      at Test.runInAsyncScope (node:async_hooks:227:14)
      at Test.run (node:internal/test_runner/test:1382:25)
      at Test.start (node:internal/test_runner/test:1242:17)
      at startSubtestAfterBootstrap (node:internal/test_runner/harness:387:17) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 'caf.zip',
    expected: 'café.zip',
    operator: 'strictEqual',
    diff: 'simple'
  }

```

</details>

| head\-test | `d205f6828fec` | `node --test` | EXIT 0 (repository command) | 81 ms |

<details>
<summary>head\-test output</summary>

```text
✔ AC-1 preserves UTF-8 filename (0.305833ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 46.191416

```

</details>

## Sources

- **markdown:** Demo acceptance specification

## Limitations

- This deterministic report was generated from a temporary fixture with the mock semantic provider\.

> A CriteriaTrace status summarizes collected links and process results. It does not prove the change is bug-free or replace review.
