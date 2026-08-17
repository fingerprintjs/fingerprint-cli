# Releasing

Releases are automated. You never run `npm publish`, never bump a version by hand, and never touch
an npm token — there isn't one. Your only job is to describe your change in a changeset and merge
two PRs.

## Shipping a change

### 1. Add a changeset to your PR

From your feature branch:

```bash
pnpm changeset
```

It asks for a bump type and a summary, then writes a randomly-named file into `.changeset/`:

```markdown
---
"fingerprint": minor
---

Detect Nuxt projects and install the Vue SDK.
```

Commit that file as part of your PR. The summary becomes the CHANGELOG entry verbatim, so write it
for someone upgrading the CLI, not for a reviewer reading the diff.

The random filename (`olive-pandas-repeat.md`) is meaningless — it exists so two open PRs never
collide on the same file.

**A PR with no changeset releases nothing.** That's the correct outcome for CI tweaks, tests, and
docs. It is the wrong outcome for a user-facing fix, and nothing will warn you.

### Picking the bump type

The CLI is pre-1.0, which means the ordinary semver rules do not apply yet:

| Change | Bump | `0.1.0` becomes |
| --- | --- | --- |
| Bug fix, internal change | `patch` | `0.1.1` |
| New feature **or a breaking change** | `minor` | `0.2.0` |
| — do not use — | `major` | `1.0.0` |

Breaking changes get `minor`, not `major`. Changesets applies `semver.inc()` with no special handling
for `0.x`, so a `major` changeset ships **`1.0.0`** — a public commitment to a stable command surface.
Reserve it for when someone deliberately decides to make that promise.

When several changesets are pending, the **highest** bump wins and they collapse into one release —
three patches and a minor produce a single minor version with all four summaries in the CHANGELOG.

## What happens after you merge

Merging to `main` does **not** publish. There are two steps, and a human gate between them.

### 2. A release PR opens by itself

`.github/workflows/release.yml` runs on every push to `main`. If changesets are pending, a bot opens
a PR titled **`Release [changeset]`** that:

- deletes the `.changeset/*.md` files it consumed,
- bumps `version` in `package.json`,
- writes the entries into `CHANGELOG.md`.

This PR is where the version number first becomes visible. Review it as a release note — if the
version looks wrong, fix the changeset in a separate PR rather than editing this one, since it is
regenerated on every subsequent push to `main`.

The bot that opens it is an unprivileged GitHub App that can do nothing but open this PR.

### 3. Merging the release PR publishes

Merging it leaves no pending changesets, which flips the workflow into publish mode. Precisely: on
each push to `main` the workflow checks for pending changesets, and if there are none it looks for a
git tag matching the current `package.json` version. No changesets **and** no `v<version>` tag means
"this version was versioned but never shipped" — so it publishes and tags.

That publish job is pinned to the repo's **`production` environment**, so it pauses for manual
approval before it can reach npm. Approve it in the Actions run and it publishes to the `latest` tag.

Because the tag is what marks a version as shipped, deleting a release tag will cause that version to
be published again on the next push to `main`. Don't delete release tags.

## There is no npm token

Publishing uses **npm trusted publishing** — OIDC. At publish time the GitHub Actions job mints a
short-lived identity token, and npm verifies it came from this repository and from the workflow file
`release.yml` before accepting the upload.

**So don't go looking for an `NPM_TOKEN` secret. There isn't one, and its absence is not a bug.**
Nothing needs rotating, nothing can leak from CI logs, and a stolen repository secret cannot publish
on your behalf. This is the single most confusing thing about this setup for anyone who has released
an npm package the traditional way.

Two consequences worth knowing:

- **npm provenance is forced on.** Every published tarball carries a signed attestation linking it to
  the exact commit and workflow run that built it, recorded in a public transparency log. Users can
  verify it with `npm audit signatures`. Provenance requires the repository to be **public** —
  publishing from a private repo fails.
- **The workflow filename is part of the credential.** npm validates the *calling* workflow's
  filename. Renaming `.github/workflows/release.yml` breaks publishing until the trusted publisher
  entry on npmjs.com is updated to match.

### One-time setup

Already done for this repo, listed so it can be reproduced or debugged:

- Repository is public (required by provenance).
- Repo variables `APP_CLIENT_ID` and `RUNNER_APP_CLIENT_ID` — the client IDs of the privileged and
  unprivileged GitHub Apps.
- `APP_PRIVATE_KEY` as a secret on the **`production`** environment (this is what makes the approval
  gate meaningful), and `RUNNER_APP_PRIVATE_KEY` as a repo secret.
- A trusted publisher registered on npmjs.com for the `fingerprint` package, pointing at
  `fingerprintjs/fingerprint-cli` and the workflow file `release.yml`.
- `publishConfig.registry` in `package.json` — the shared release workflow does not pass a registry
  URL to `setup-node`, so npm needs it stated explicitly.

Credentials are provisioned by the DX team; npm ownership sits with the package maintainers.

## Troubleshooting

**No release PR appeared, and it published straight away instead.** The `RUNNER_APP_CLIENT_ID` repo
variable is unset. When it is empty the shared workflow skips the review-PR step entirely and runs
version and publish in a single job, so a merge to `main` ships immediately. Set
`RUNNER_APP_CLIENT_ID` to restore the two-step flow.

**No release PR appeared, and nothing published.** The merged PR had no changeset. Add one in a
follow-up PR to `main`.

**Publish failed on authentication.** Usually one of: the trusted publisher on npmjs.com does not
match the repo or the `release.yml` filename; the repo is private so provenance cannot be generated;
or `id-token: write` was dropped from `release.yml`. That permission has to be declared in *our*
workflow — reusable workflows inherit permissions from the caller, so the shared workflow cannot
grant it to itself.

**The run is sitting idle.** It is waiting on `production` environment approval. Approve it from the
workflow run page.
