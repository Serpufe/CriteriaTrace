# Changelog

Notable user-facing changes to CriteriaTrace are recorded here.

## [0.1.0] — release candidate

- CLI: `init`, `doctor`, static `inspect`, evidence-producing `verify`, and an offline `demo`; versioned JSON and Markdown reports retain exact base/head revisions and limitations.
- GitHub Action: pull-request-only execution, job summary, report outputs, optional same-repository comment, and explicit read-only default permissions.
- Isolation: Docker execution is the default; repository code runs with no network, a read-only source export, limited resources, and no host secret environment. `--no-exec`, `--trust-repo`, and `--allow-network` are explicit choices.
- Reproducibility: Node and Python sandbox images are pinned by digest; the Action bundle is checked into Git and verified in CI; npm package contents and clean tarball installation are release gates.
- Evidence integrity: repository-controlled commands and model suggestions cannot grant `VERIFIED`; missing Docker or image availability fails closed.
- Known limits: Docker and its image are trusted components; macOS isolated execution lacks a live CI gate; Windows has no isolated backend; results still need human review. See [SECURITY.md](SECURITY.md).

The first public release remains unpublished until the maintainer completes the manual release steps.
