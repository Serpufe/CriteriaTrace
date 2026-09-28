# Contributing

Thanks for helping make CriteriaTrace useful and honest about its evidence.

## Development setup

Use Node 24 and Git. From a checkout:

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run demo
```

The test suite builds temporary Git repositories; it does not need an OpenAI key. To manually try semantic mapping, set `OPENAI_API_KEY` in your local shell and use a test repository without sensitive source.

## Changes

- Keep Git facts, command results, and model suggestions distinct.
- Add or update behavior tests and realistic fixtures for user-visible changes.
- Preserve strict config validation and argument-array subprocess execution.
- Document new data sent to a model provider and any new execution boundary.
- Keep generated tests opt-in and temporary.
- Update `CHANGELOG.md` and public docs when behavior or CLI contracts change.

Open a PR with the problem, behavior change, verification commands, and known limitations. Do not include API keys, private source, or fabricated model evidence. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and [SECURITY.md](SECURITY.md).
