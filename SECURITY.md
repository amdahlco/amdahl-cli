# Security policy

## Reporting a vulnerability

Please do not report security issues in public GitHub issues, discussions or
pull requests.

Email **security@amdahl.ai** with a description of the issue, the steps to
reproduce it, and the version of `@amdahl/cli` you used (`amdahl --version`).
You can also use GitHub's private vulnerability reporting on this repository
(Security, Report a vulnerability).

We will acknowledge your report, keep you updated while we investigate, and
credit you in the release notes if you want.

## Supported versions

We fix security issues in the latest release of `@amdahl/cli`. Upgrade with
`npm i -g @amdahl/cli@latest`, or run `npx @amdahl/cli@latest`.

## Verifying a release

Every release is published from this repository's `publish.yml` workflow with
an npm provenance attestation. Run `npm audit signatures` in a project that
depends on `@amdahl/cli` to verify it.
