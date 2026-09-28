# Positioning and adjacent tools

**Research checked: 2026-09-27.** This is a comparison of public product descriptions, not an independent product or security evaluation. Features and positioning may change.

## Adjacent categories

| Category                            | Public positioning                                                                                                                                                                                                                                                                                                                   | CriteriaTrace's scope                                                                                                                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requirements traceability platforms | Trace.Space describes a connected requirements platform linking requirements through implementation and tests, with cross-tool integrations, approvals, compliance evidence, and AI gap detection for regulated teams. [Trace.Space for software](https://www.trace.space/industries/software)                                       | CriteriaTrace does not manage a lifecycle requirements database, approval chain, control catalog, or organization-wide audit history. It creates a repository-local, change-scoped evidence report from Git revisions and executable commands. |
| AI code review platforms            | Qodo describes pull request analysis for bugs, logic gaps, missing tests, compliance, and other review concerns; its platform also discusses test generation and code suggestions. [Qodo platform overview](https://www.qodo.ai/formerly-qodo-merge/) [Qodo review platform](https://www.qodo.ai/blog/qodo-ai-code-review-platform/) | CriteriaTrace does not grade general code quality or produce patches. It asks the narrower question: which stated acceptance criteria have traceable implementation and test candidates, and what did the configured commands actually return? |
| Test and issue management           | Test management and issue systems record cases, requirements, ownership, and execution in their own workflows.                                                                                                                                                                                                                       | CriteriaTrace reads local Markdown and GitHub issue/PR context, then packages point-in-time Git and process evidence as JSON/Markdown. It is not a new test case database or replacement for those systems.                                    |

## Differentiation without novelty claims

End-to-end requirement traceability already exists in mature platforms. CriteriaTrace should not claim to invent requirement-to-code-to-test mapping. Its intended niche is a small, repo-native CLI and GitHub Action for maintainers who want a change-scoped trace without first adopting a separate requirements platform.

The product's useful distinction is the evidence boundary:

```text
authored or explicitly inferred criterion
  → changed Git path
  → candidate test path
  → process result on base and/or head
  → inspectable report with gaps
```

Lexical and model links remain candidates. Git revision facts and process exit codes remain deterministic. A report that lacks a test link or a test output that does not identify the relevant candidate stays partial or unverified. The tool does not turn semantic plausibility into a proof claim.

## Product implications

- Keep setup to one config file, a CLI, and one Action.
- Make JSON stable and useful to CI consumers; keep Markdown readable by maintainers.
- Prefer local Markdown/GitHub context over mandatory synchronization into another service.
- Keep generated tests opt-in, inspectable, temporary, and labeled advisory.
- Treat compliance platforms and code review agents as complements with broader jobs, not targets to attack or replace.

## Sources

- [Trace.Space: AI-native software requirements traceability](https://www.trace.space/industries/software)
- [Qodo: current platform and product names](https://www.qodo.ai/formerly-qodo-merge/)
- [Qodo: AI code review platform](https://www.qodo.ai/blog/qodo-ai-code-review-platform/)
