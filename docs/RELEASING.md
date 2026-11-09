# Releasing

Each version tag builds the package on GitHub, attaches it to a GitHub release, and publishes it to npm when an npm token is set.

## Once: let GitHub publish to npm

1. Sign in at [npmjs.com](https://www.npmjs.com) (create an account if needed, and turn on two-factor authentication).
2. Create a token: profile picture → **Access Tokens** → **Generate New Token** → **Granular Access Token**. Give it **Read and write** permission on packages, and an expiry.
3. In GitHub, open the repository's **Settings → Secrets and variables → Actions → New repository secret**. Name it `NPM_TOKEN` and paste the token.

Without the secret, releases still work: the package is attached to the GitHub release, and npm is skipped.

After the first publish, you can replace the token with npm **trusted publishing** (package settings on npmjs.com → Trusted publisher → GitHub Actions, workflow `release.yml`) and delete the secret.

## Each release

```bash
npm version patch          # or minor / major: updates package.json and makes the tag
git push --follow-tags     # the Release workflow does the rest
```

The workflow checks the types, runs the tests, checks that the tag matches `package.json`, packs, creates the GitHub release with the `.tgz` attached, then publishes to npm with provenance.

## Checks on every push

The CI workflow runs the type check and tests on Linux, Windows and macOS with Node 22 and 24, then installs the packed package and runs `hh --help`.
