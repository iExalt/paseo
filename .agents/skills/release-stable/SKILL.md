---
name: release-stable
description: Cut a fork (iExalt/paseo) release by merging the release-please PR on `dev`. Use when the user says "release", "cut X.Y.Z", "ship a release", "release stable", "promote", or "/release-stable". Never use docs/upstream/release.md, npm `release:*` scripts, tags or a release branch.
user-invocable: true
---

# Release stable (fork)

The fork releases from `dev` through release-please. `docs/upstream/release.md` and the root
`release:*`, `version:all:*` and `release:publish*` npm scripts are upstream's npm, EAS and store
process; never follow or run them. Follow the steps below and inspect
`.github/workflows/release.yml` for the current release pipeline.

1. Find the release PR and read its version from the title (`chore(dev): release X.Y.Z`):
   `gh pr list -R iExalt/paseo --label "autorelease: pending" --json number,title,url`.
   The version follows the conventional commits since the last `paseo-v*` tag; any `feat` bumps
   the minor. With no open PR, nothing releasable has landed since the last release; say so.
2. If the user named a different version, land a conventional commit on `dev` (through a PR) whose
   body ends with a `Release-As: X.Y.Z` footer, then wait for release-please to retitle the PR.
3. Check the PR's checks, including the `deep (*)` lanes, which run only on release PRs. If only
   `test`, `ci` or `docs` commits landed since the PR last updated, its checks test an old `dev`:
   run `gh pr update-branch <N> --rebase -R iExalt/paseo` and wait for the new checks.
4. Merging publishes the release. A request that names the version ("cut 0.20.0") approves that
   version; otherwise quote the PR's version and ask. Squash-merge the PR (merge commits are
   disabled). Do not bypass required checks.
5. Release-please tags `paseo-vX.Y.Z`, opens a draft release and dispatches `release.yml` on `dev`.
   Watch that run to completion with a bounded watcher, then confirm the release is published and
   marked Latest. On failure, inspect the failed job and `.github/workflows/release.yml` before retrying.
