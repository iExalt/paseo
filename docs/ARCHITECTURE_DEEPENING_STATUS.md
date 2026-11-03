# Architecture deepening status

Last updated: 2026-11-03

## Purpose

Tracks the seven deepening refactors from the 2026-11-03 architecture review
(kept outside the repository at `.scratch/architecture-review-2026-11-03.html`
in the owner's checkout; evidence checked at `f7d0538e0`). Each item ends in
its own behaviour-preserving PR to `dev`. Module names go into the fork
[glossary](GLOSSARY.md) as each lands. Terms follow the deep-module vocabulary:
module, interface, depth, seam, adapter, leverage, locality.

## Snapshot

| Field          | Status                                                                                  |
| -------------- | --------------------------------------------------------------------------------------- |
| Baseline       | `dev` at `374eac209`                                                                    |
| Current item   | 3, Fork updater controller                                                              |
| Required CI    | dev push run 41531769754: plan start to required 3m44s; slowest lane `workspaces` 3m10s |
| Release impact | None; no item publishes a release                                                       |

## Items

| #   | Module                  | State   | PR                                               | Notes                                                                                                                                                                                                                                                                                                 |
| --- | ----------------------- | ------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4   | Routine lane            | merged  | [#320](https://github.com/iExalt/paseo/pull/320) | Steps declare their lane; one lane table owns shards and prerequisites                                                                                                                                                                                                                                |
| 5   | Dependency fingerprint  | merged  | [#321](https://github.com/iExalt/paseo/pull/321) | Rescoped (owner chose "Shrink it", 2026-11-03): one key CLI for both `ci.yml` jobs; Nix filter and release-please untouched; no Nix test                                                                                                                                                              |
| 6   | Release asset catalog   | merged  | [#322](https://github.com/iExalt/paseo/pull/322) | New catalog absorbs `release-manifest.mjs` `assetNames`; desktop delta naming stays in shipped `paseo-nix-update-delta.mjs`; one release dry run approved                                                                                                                                             |
| 3   | Fork updater controller | merged  | [#323](https://github.com/iExalt/paseo/pull/323) | One controller over a native port; proven on Cuttlefish at 638fde03b (2026-11-03): update available, permission screen and back, relaunch keeps the download, installer cancel and signer rejection both retry the staged APK; installed is unproven (locally signed)                                 |
| 2   | Notification policy     | merged  | [#324](https://github.com/iExalt/paseo/pull/324) | Fork-owned `notification-policy.ts` takes both broadcast decisions and the rule and mute writes; push-title parsing moved to protocol                                                                                                                                                                 |
| 1   | Notification dismissal  | merged  | [#325](https://github.com/iExalt/paseo/pull/325) | One driver over two plans; desktop and browser sends move out of upstream `os-notifications.ts`; Android proven on the S24U at f8309b491 (2026-11-03): pushes read elsewhere clear on open, questions clear when answered, an unread thread holds them; a backgrounded app clears on return, not live |
| 7   | Reading position        | planned |                                                  | Interaction with upstream `bottomAnchorController` written down before building                                                                                                                                                                                                                       |

## Review corrections to the cards

- Item 5: the review's premise of one normalisation for CI, release pin and
  Nix did not hold. Nix filters the lockfile at eval time (`nix/package.nix`),
  release-please only runs `scripts/update-nix.sh`, and the version-bump test
  already existed (`.github/scripts/android-cache-pin.test.mjs`). The owner
  chose to shrink the item instead of dropping it.
- Item 6: a partial catalog already existed (`release-manifest.mjs`
  `assetNames`), and desktop delta naming already had one shipped owner.
  `release-nix.sh` runs before Node is set up, so it stays out of scope.
- Item 1: the daemon's title strings had already left `caught-up.ts` (#324).
  Of the 53 tests the card counted, 34 are table tests over pure plans and
  stay; only the 19 driver and send tests were piecewise. The shade port the
  card drew would share only "dismiss these ids" across native, desktop and
  browser, so the seam sits between one driver and its two plans instead.
- Item 3: the tables did not disagree on permission. Row busy leaves it out so
  Continue stays pressable, a background check treats it as in progress, and
  the icon offers to continue from it: three different questions, kept as three
  named predicates. The real duplicate was the "error with a staged APK" rule,
  which now has one owner.
- Item 4: the "every step lands in one lane" property test already existed;
  the change removes name decoding rather than adding that test.
