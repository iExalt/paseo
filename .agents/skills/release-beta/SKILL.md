---
name: release-beta
description: The fork (iExalt/paseo) has no beta channel. Use when the user says "release beta", "cut a beta", "ship a beta", "beta release", or "/release-beta", to explain that and offer a stable release instead. Never use docs/upstream/release.md or npm `release:beta:*` scripts.
user-invocable: true
---

# Release beta (fork)

The fork ships stable releases only. It publishes no npm packages and has no beta dist-tag, beta
updater channel or beta workflow. The beta flow in `docs/upstream/release.md` and the root
`release:beta:*` npm scripts are upstream's; never follow or run them.

Tell the user there is no beta channel. If they want to test before release, offer a dry run of
`release.yml` (see [GitHub workflows § Release procedure](../../../docs/GITHUB_WORKFLOWS_STATUS.md#release-procedure))
or a stable release through the `release-stable` skill.
