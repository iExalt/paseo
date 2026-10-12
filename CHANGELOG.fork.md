# Changelog

## 0.1.0 (2026-10-12)


### Features

* **ci:** bind release PR checks to exact checkout receipts ([57786d5](https://github.com/iExalt/paseo/commit/57786d5481f94499ed3f6ff96924d6963ec25d4e))
* **ci:** guard independent release proposals with scoped App identity ([679209f](https://github.com/iExalt/paseo/commit/679209f378b1c065f23c27c49a24477bbcb0b8ba))


### Bug Fixes

* **ci:** make completed feasibility probes manual-only ([8eec80e](https://github.com/iExalt/paseo/commit/8eec80e5eefbb406c793eea338924a5e753231aa))
* **ci:** preserve bootstrap evidence across unreachable history ([121258c](https://github.com/iExalt/paseo/commit/121258cb637f557baadf49f70540c76407465cc6))
* **ci:** preserve release engine changelog formatting ([07b997d](https://github.com/iExalt/paseo/commit/07b997d79e0b50298a1dec0ee8952c971666ad9f))
* **ci:** verify release proposals under rebase-only merge policy ([f8c8ef6](https://github.com/iExalt/paseo/commit/f8c8ef6256bcd179a9514c35bfd8a0f5d7a0c9ef))
* **plugins:** preserve API compatibility across fork version reset ([e674ae2](https://github.com/iExalt/paseo/commit/e674ae2f5bad8808eb4d77e5367e10a22319846a))
* rehearse proposal refresh ([6c1437e](https://github.com/iExalt/paseo/commit/6c1437e3611cb244ca449de8d8177f77087f8816))

## Fork changelog

This history belongs to the independent iExalt/paseo release lineage. Upstream
history remains in CHANGELOG.md.

## Unreleased

The first fork release targets 0.1.0. It requires manual migration from historical
`paseo-fork-*` builds. New clients use signed fork semver releases for upgrade
ordering; historical numeric release metadata is retained only for explicit local
recovery. No 0.1.0 release has been published yet.
