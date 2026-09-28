# Self-dogfood evidence

CriteriaTrace ran the explicit AC-98 specification against a temporary Git snapshot of this repository. The base revision lacked `repositoryGitState`; the head revision reports clean, tracked-change, and untracked states. The same test command returned exit 1 on base and exit 0 on head, and the report marked the criterion `VERIFIED`.

The snapshot let this run use real Git revisions without writing to the workspace's read-only `.git` directory. The deterministic mock provider was used, so no API request was made. Only temporary repository and archive paths were redacted from the saved JSON and Markdown; criterion links and execution results are unchanged.
