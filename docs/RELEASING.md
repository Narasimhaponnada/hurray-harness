# Releasing

Each new version on `main` is released on its own: the package is built on GitHub, attached to a GitHub release, and published to npm when an npm token is set.

## Once: let GitHub publish to npm

1. Sign in at [npmjs.com](https://www.npmjs.com) (create an account if needed, and turn on two-factor authentication).
2. Create a token: profile picture → **Access Tokens** → **Generate New Token** → **Granular Access Token**. Give it **Read and write** permission on packages, and an expiry.
3. In GitHub, open the repository's **Settings → Secrets and variables → Actions → New repository secret**. Name it `NPM_TOKEN` and paste the token.

Without the secret, releases still work: the package is attached to the GitHub release, and npm is skipped.

After the first publish, you can replace the token with npm **trusted publishing** (package settings on npmjs.com → Trusted publisher → GitHub Actions, workflow `release.yml`) and delete the secret.

## Each release

Releases happen on their own. Bump the version and push to `main`:

```bash
npm version patch --no-git-tag-version   # or minor / major: updates package.json and the lock file
git commit -am "Release 0.1.3" && git push
```

On every push to `main`, the Release workflow reads the version in `package.json`. When that version has no release yet, it checks the types, runs the tests, packs, creates the GitHub release `vX.Y.Z` with the `.tgz` attached, and publishes to npm with provenance (once the `NPM_TOKEN` secret exists). A push that leaves the version alone releases nothing.

To run it by hand: **Actions → Release → Run workflow**.

## Checks on every push

The CI workflow runs the type check and tests on Linux, Windows and macOS with Node 22 and 24, then installs the packed package and runs `hh --help`.
