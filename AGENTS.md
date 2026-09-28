# CriteriaTrace repository instructions

## Project boundaries

- Keep the deterministic evidence collector separate from semantic provider output.
- Never let model output choose a command, revision, or unallowlisted path.
- Do not describe temporary Git archives as sandboxes.
- Keep API keys out of reports, test subprocess environments, fixtures, and commits.
- Do not enable generated tests by default or write them into the user's checkout.
- Preserve the exact base/head revisions and report limitations when evidence is absent.

## Source map

- `src/criteria.ts`, `config.ts`, `git.ts`, `mapper.ts`, `provider.ts`, `execute.ts`, `verify.ts`, `report.ts`
- `src/cli.ts` and `src/action/index.ts` are the product entry points.
- `tests/fixtures/` contains Git repository source fixtures. The test helper creates their commits in a temporary directory.
- `action/dist/index.js` is the checked-in bundled GitHub Action entry point. Update it with `npm run build` when Action source/dependencies change. Preserve `action/dist/licenses.txt`.

## Verification

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

`npm run demo` exercises a real base-fails/head-passes fixture without an API key. Do not claim a live OpenAI call unless one was made with a user-provided key. Use a temporary repository for behavior experiments and remove it in `finally`.

## Changes

- Add behavior tests for status, command, or config changes.
- Update README, SECURITY.md, docs/architecture.md, and CHANGELOG.md when public behavior changes.
- Keep CI actions pinned to full commit SHAs.
- Do not publish to npm, GitHub Marketplace, or create a release without explicit maintainer authorization.
