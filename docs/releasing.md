# Releasing CriteriaTrace

## Version and Action tags

The first public version is **0.1.0**. The CLI, report schema, and Action inputs are usable but may still need incompatible user-experience changes. SemVer `0.y.z` communicates that initial-development contract; tests alone do not establish a stable `1.0.0` API.

The package version, CLI `--version`, changelog entry, and exact Action tag must agree. Create `v0.1.0` only after review of the release candidate. Treat exact version tags as immutable: never force-move or reuse one. Consumers should use `Serpufe/CriteriaTrace@v0.1.0` or its full commit SHA. Do not create floating `v0` or `v0.1` tags for the first release. A moving compatibility tag can be considered later with an explicit maintenance policy.

## Sandbox image policy

`src/images.ts` is the single runtime source of truth:

| Runtime | Pinned reference                                                                             |
| ------- | -------------------------------------------------------------------------------------------- |
| Node    | `node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1`     |
| Python  | `python:3.13-alpine@sha256:79e7a9b9ff1cbceff819f856fb374477792a5967759d94df266de7b7b4120e6f` |

These are multi-platform index digests resolved from Docker Hub on 2026-09-28. The tag tells a reader the intended runtime line; Docker selects the exact digest, including its architecture-specific manifest. The release workflow and Linux CI pull both pinned references; a user running pytest must pre-pull the pinned Python reference locally. CriteriaTrace itself never pulls and sets `--pull=never`. If a pinned digest disappears or has no manifest for the host architecture, execution reports unavailable; it never switches to a newer tag or executes on the host.

Docker documents [pulling by digest](https://docs.docker.com/reference/cli/docker/image/pull/) for this immutable-reference behavior.

Review image updates at least monthly and before each release. Run `docker buildx imagetools inspect node:24-alpine` and `docker buildx imagetools inspect python:3.13-alpine`, record the current index digest and supported platforms, then change `src/images.ts` in a PR. Read upstream release notes and scan the candidate image under the project's normal dependency review. Pull the proposed digest on Linux, run the full CI and controlled isolated tests, and verify `doctor` reports it available. Update the exact examples in README and this document in the same PR. Merge only after review; there is no automatic runtime image update.

## Candidate and package gates

`.github/workflows/release-candidate.yml` runs on manual dispatch or an exact `v*` tag. It checks out the event commit with no persisted credentials, uses locked dependencies, checks format/lint/types, builds and compares the committed Action bundle, tests with a real pinned Linux Docker image, audits dependencies, packs, computes SHA-256, and uploads the tarball plus manifest. It has `contents: read` only and **does not publish**.

Before creating a tag, run the same checks in a clean checkout and install the generated tarball in an unrelated temporary Git repository. Check `--help`, `--version`, `init`, `inspect`, `verify --no-exec`, the Docker-unavailable path, and isolated execution where Docker is available. Inspect `npm pack --json` for unexpected files, paths, secrets, and credentials. The npm tarball contains the CLI/library and documentation; the GitHub Action is consumed from the repository tag, where its committed bundle lives.

## Manual publication

Publication is a maintainer decision after the release PR is integrated and its candidate hash is accepted:

```sh
git switch main
git pull --ff-only
npm ci --ignore-scripts
npm run build
npm test
npm pack
shasum -a 256 criteriatrace-0.1.0.tgz
git tag -a v0.1.0 -m 'CriteriaTrace 0.1.0'
git push origin v0.1.0
```

Compare the local hash with the reviewed candidate; if the repository commit changes, rebuild and revalidate the candidate. The tag triggers the release-candidate workflow, which must pass before uploading or publishing anything. Verify the npm name, account ownership, and package access again. The first publication needs an authenticated maintainer account with the registry's required 2FA; do not put an npm token in this repository. From the reviewed tarball, the manual command is `npm publish --access public ./criteriatrace-0.1.0.tgz`. Create the GitHub Release for `v0.1.0` manually and attach the same tarball and SHA-256 manifest. Then verify installation from the registry and the Action from the tag.

After the package exists on npm, configure an npm trusted publisher for the repository and a dedicated reviewed publish workflow. GitHub-hosted OIDC publishing avoids persistent npm tokens and can provide provenance for a public package from a public repository. Do not enable automatic publication until that trust relationship and workflow are independently reviewed.

See [npm's trusted publishing requirements](https://docs.npmjs.com/trusted-publishers/) before configuring that future workflow.
