# Roadmap

This roadmap is directional. It does not promise dates or a compliance certification.

## v0.1.0 — initial release

- CLI, GitHub Action, local Markdown and GitHub issue/PR context
- Vitest, Jest, and pytest detection
- Isolated base/head test execution and inspectable Markdown/JSON evidence
- OpenAI semantic mapping and opt-in generated tests
- Threat model, fixtures, CI, and clean-room adoption checks

## After initial release

- Collect maintainer feedback on false links, quiet test runners, config ergonomics, and report usefulness.
- Add test result adapters only where they make a specific execution claim more reliable.
- Consider additional ecosystems such as Go and Rust when there is a maintained fixture and CI coverage.
- Consider local provider implementations without changing deterministic evidence collection.
- Improve GitHub report retention and artifact ergonomics without broadening token permissions.

## Out of scope for this tool

- General AI code review, patch generation, security scanning, or autonomous merge decisions
- Compliance certification or formal proof claims
- A hosted requirements database or replacement for issue/test management platforms
