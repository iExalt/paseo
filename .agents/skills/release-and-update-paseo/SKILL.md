---
name: release-and-update-paseo
description: Cut a fork (iExalt/paseo) release by merging the release-please PR, wait until GitHub publishes it as Latest, then install it on this Mac with update-nix-paseo. Use for "release and update", "ship and install", "cut X.Y.Z and update Paseo", or "/release-and-update-paseo".
user-invocable: true
---

# Release and update Paseo

This skill chains two others. Load each one when you reach it and follow its rules;
the steps here only add the hand-off between them.

## 1. Merge the release PR

Follow `release-stable` steps 1 to 4. A request that names the version approves
that version. Otherwise quote the PR's version and its `deep (*)` check results,
and ask before merging. Record the version, the PR number and its `mergedAt` time.

## 2. Wait for the release to publish

Release-please tags `paseo-vX.Y.Z`, opens a draft release and dispatches
`release.yml` on `dev` as `github-actions[bot]`. Find the oldest such run created
at or after `mergedAt`; the API lists runs newest first. Filter on the triggering actor: a manual dispatch, such as a
dry run or a re-dispatch after a failure, is also a `workflow_dispatch` run. The
dispatch can lag the merge by a few minutes, so poll for up to 10 minutes:

```zsh
gh api 'repos/iExalt/paseo/actions/workflows/release.yml/runs?event=workflow_dispatch&per_page=10' \
  --jq '.workflow_runs[] | select(.triggering_actor.login == "github-actions[bot]")
        | [.id, .created_at, .status, .conclusion] | @tsv'
```

With no run after 10 minutes, inspect the `dispatch` job of the `release-please.yml`
run on the merge commit, report it and stop.

The run shares the `paseo-release` concurrency group, so it may queue behind an
earlier one. Recent release runs took 20 to 25 minutes. Watch it in the background
with a 60-minute bound, and wait for the watcher's exit instead of polling:

```zsh
gh run watch <run-id> -R iExalt/paseo --exit-status --interval 60
```

On failure, follow `release-stable` step 5 and stop before updating. On success,
require both checks to pass:

- `gh release view paseo-vX.Y.Z -R iExalt/paseo --json isDraft,publishedAt` shows
  `isDraft: false`.
- `gh api repos/iExalt/paseo/releases/latest --jq .tag_name` prints `paseo-vX.Y.Z`.
  The Nix updater reads this endpoint.

## 3. Update this Mac

Follow `update-nix-paseo` for version X.Y.Z. The updater resolves Latest through the
github.com redirect, which can lag the API by a moment. If `upd check` reports a
latest release other than X.Y.Z, run it once more after a minute, then stop and
report; do not stage an older release.

When this agent is the only one running, `update-nix-paseo` ends the turn and
verifies the daemon after a wakeup. The report written after that wake is this
skill's final report.

## 4. Report

Give the version, PR, merge commit, release URL, `release.yml` run ID and duration,
then the `update-nix-paseo` report: app and daemon versions before and after, and
any upgrade still pending.
