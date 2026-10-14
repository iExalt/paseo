# Changelog

## [0.1.2](https://github.com/iExalt/paseo/compare/paseo-v0.1.1...paseo-v0.1.2) (2026-10-14)


### Features

* **ci:** recover failed candidate jobs by rerunning them in the same run ([591f37c](https://github.com/iExalt/paseo/commit/591f37cbf694d94610b5a8b0e726082dea6642aa))


### Bug Fixes

* **ci:** bind publish checks to fresh draft bytes ([f3c8064](https://github.com/iExalt/paseo/commit/f3c80649b3c1051f00c7ed2c91fd5bf151c414ba))
* **ci:** prefetch only the fixed outputs the Nix build will build ([ab6b9e8](https://github.com/iExalt/paseo/commit/ab6b9e89a40d5094b27bd0a125887857b5e89154))
* **ci:** refresh the dependency cache only from the current dev head ([42ce214](https://github.com/iExalt/paseo/commit/42ce2144705c02efd0ec26131f315483573456b5))
* **ci:** refuse carried grants once a candidate is no longer live ([1bb0fe9](https://github.com/iExalt/paseo/commit/1bb0fe9f77164ea943ccc17f50648cb1ad1169f8))
* **ci:** require release sources to change their release configuration ([dc79a6c](https://github.com/iExalt/paseo/commit/dc79a6cbb228b32b1b535f2a0db8b27ab927b6ec))
* **ci:** retry hash-pinned Nix fetches before candidate builds ([9e86318](https://github.com/iExalt/paseo/commit/9e863181409baefb772be439884526a9d8eaf0a6))
* **ci:** retry npm fetches when refreshing the dependency cache ([043f160](https://github.com/iExalt/paseo/commit/043f160f8202c2fc96be4e1c8b8ebec34d51f055))
* **ci:** start candidate and deep runs only for release changes ([7d63781](https://github.com/iExalt/paseo/commit/7d63781f66e86785a770cdf87a77ea1c327c034f))
* **ci:** widen limits with under 25% observed headroom ([5b6ede7](https://github.com/iExalt/paseo/commit/5b6ede7f1f1b9190ce97453403deb64221beef4e))
* **nix:** bound updater fetches and keep the running version visible ([35af442](https://github.com/iExalt/paseo/commit/35af4427ef02fd4af15768eaea94e81052fb7cfb))
* **nix:** check desktop updates without the rate-limited releases API ([2270b08](https://github.com/iExalt/paseo/commit/2270b08b74369306285e74eedc4caee131e1b7d1))


### Performance Improvements

* **ci:** let predecessor caches for different platforms prewarm together ([40060ee](https://github.com/iExalt/paseo/commit/40060eef479720467c4d639f1c80605db4e1d5b9))
* **ci:** restore installed dependencies in routine lanes ([ea33b42](https://github.com/iExalt/paseo/commit/ea33b421b8d4071997402513c2d8e0587ca3c9bf))
* **ci:** shard app units and use four vitest workers per lane ([3222fac](https://github.com/iExalt/paseo/commit/3222facab2656418bb9756aaec667d070172e17a))


### Miscellaneous Chores

* **release:** release 0.1.2 ([24838d3](https://github.com/iExalt/paseo/commit/24838d3ef9554e70bdf73539185c9c7a4a308739))

## [0.1.1](https://github.com/iExalt/paseo/compare/paseo-v0.1.0...paseo-v0.1.1) (2026-10-13)


### Bug Fixes

* **ci:** test upgrades from sanitized 0.1.0 history ([5898f92](https://github.com/iExalt/paseo/commit/5898f92646d4a2985de10f9e4259601cb54dcc16))

## 0.1.0 (2026-10-12)


### Features

* **ci:** admit paired native receipts after signing and runtime proof ([6c667c2](https://github.com/iExalt/paseo/commit/6c667c2edef69e5973c374597b0142513f603a65))
* **ci:** admit product receipts from trusted artifact transfers ([26d5a63](https://github.com/iExalt/paseo/commit/26d5a6346e7eab6bfb2175cf28f1fd683bcdac66))
* **ci:** admit signed Linux Nix artifacts through trusted transfer ([e21e501](https://github.com/iExalt/paseo/commit/e21e501323c61c62b54cb9eb34167f16646626f1))
* **ci:** authenticate immutable candidate draft authority ([972bafe](https://github.com/iExalt/paseo/commit/972bafe3d58b5be09ce298daf8cd5abe027160c4))
* **ci:** authenticate paired builds and native runtime attempts ([bf47459](https://github.com/iExalt/paseo/commit/bf474592eb084cb76eb629eb48a897e062f3018c))
* **ci:** bind release PR checks to exact checkout receipts ([57786d5](https://github.com/iExalt/paseo/commit/57786d5481f94499ed3f6ff96924d6963ec25d4e))
* **ci:** coordinate and sign complete unpublished candidate matrix ([39c2f70](https://github.com/iExalt/paseo/commit/39c2f7050a8825e4736dc7810c4c41fe857d9260))
* **ci:** export and verify signed Linux Nix candidate closures ([fd42bbd](https://github.com/iExalt/paseo/commit/fd42bbd431bbcb53f1c353c0ddd720fe9399dcd6))
* **ci:** export exact native candidate product packages ([247ff3f](https://github.com/iExalt/paseo/commit/247ff3f50c3e2656ac6748b04551b23d91d176ec))
* **ci:** gate workers and require the complete candidate matrix ([123cbd4](https://github.com/iExalt/paseo/commit/123cbd4e93b405315c9d8a93d932f9d90416ef8d))
* **ci:** guard independent release proposals with scoped App identity ([679209f](https://github.com/iExalt/paseo/commit/679209f378b1c065f23c27c49a24477bbcb0b8ba))
* **ci:** isolate trusted candidate issuance and retries ([0ead83b](https://github.com/iExalt/paseo/commit/0ead83b09d9dbc89e7ecde4ffaabc919e0c8a64e))
* **ci:** stream immutable packages within admitted attempts ([7d4feb6](https://github.com/iExalt/paseo/commit/7d4feb67f3a2bacc870eecfab25e5ff51fac8f55))
* **ci:** verify every candidate routine and deep lane ([d45683f](https://github.com/iExalt/paseo/commit/d45683fd3ef08b4541917294c997bc557806f77f))


### Bug Fixes

* **ci:** activate pinned hosted Node through mise ([9e4b5e5](https://github.com/iExalt/paseo/commit/9e4b5e5fb7c326af9526de3b1615588d83e3dcd5))
* **ci:** align native workers with coordinator authority ([70f6fed](https://github.com/iExalt/paseo/commit/70f6fed5fcdbb88240bc5e3edefe7422b40537e1))
* **ci:** align verification dependency request bounds ([5cf5d20](https://github.com/iExalt/paseo/commit/5cf5d2043e30c7aaa2d1f6f009a0747bbe8b1577))
* **ci:** bind candidate authority to source version graph ([4e41229](https://github.com/iExalt/paseo/commit/4e41229043d0b156af5bd79c5b1e7b6d31e8d1e4))
* **ci:** bind candidate run branch to original merged event ([2aef637](https://github.com/iExalt/paseo/commit/2aef63740062a53f903ab1bd0db91aa7150d37af))
* **ci:** bind invoked native controls and reject unexpected job topology ([c0013d6](https://github.com/iExalt/paseo/commit/c0013d6f6be6019a4a67b9c5b375b8fc35cb2356))
* **ci:** bound stalled dependency requests ([25f7027](https://github.com/iExalt/paseo/commit/25f702751eda09d3fc32cf41e54dfaa988e9c527))
* **ci:** clean Linux signing key after interrupted exports ([45c5be1](https://github.com/iExalt/paseo/commit/45c5be1981b8d41c023621cc4231f24e9fb6c640))
* **ci:** make completed feasibility probes manual-only ([8eec80e](https://github.com/iExalt/paseo/commit/8eec80e5eefbb406c793eea338924a5e753231aa))
* **ci:** preserve bootstrap evidence across unreachable history ([121258c](https://github.com/iExalt/paseo/commit/121258cb637f557baadf49f70540c76407465cc6))
* **ci:** preserve release engine changelog formatting ([07b997d](https://github.com/iExalt/paseo/commit/07b997d79e0b50298a1dec0ee8952c971666ad9f))
* **ci:** read candidate target from supported release API ([2f8c4a1](https://github.com/iExalt/paseo/commit/2f8c4a1ca543ff0a8855ee4a020b2e0e82ef8c26))
* **ci:** reconcile every draft asset across candidate retries ([a63bfae](https://github.com/iExalt/paseo/commit/a63bfaed8e70b77d41c51579645ff0809e8cd108))
* **ci:** reject invalid root execution before issuing authority ([3ae0813](https://github.com/iExalt/paseo/commit/3ae08139ee6f3dbda495fabb08f39e389827f5d2))
* **ci:** reject preexisting candidate transport tags ([84886a0](https://github.com/iExalt/paseo/commit/84886a065dc2d2b2415d4516e43c9d4013b59875))
* **ci:** verify release proposals under rebase-only merge policy ([f8c8ef6](https://github.com/iExalt/paseo/commit/f8c8ef6256bcd179a9514c35bfd8a0f5d7a0c9ef))
* **plugins:** preserve API compatibility across fork version reset ([e674ae2](https://github.com/iExalt/paseo/commit/e674ae2f5bad8808eb4d77e5367e10a22319846a))
* **releases:** isolate fork tags from inherited upstream history ([1ddf306](https://github.com/iExalt/paseo/commit/1ddf306d401a217153d3c8aa21beca229d141650))
* **server:** cover new directories before enumerating their files ([f264f06](https://github.com/iExalt/paseo/commit/f264f064d8644be3b03a1236aeefa5feba44edfd))


### Performance Improvements

* **ci:** batch fresh lifecycle checks and reuse immutable authority ([a0d2a59](https://github.com/iExalt/paseo/commit/a0d2a598c9a508961117ff0ad2f9b24ce412a594))

## Fork changelog

This history belongs to the independent iExalt/paseo release lineage. Upstream
history remains in CHANGELOG.md.

## Unreleased

The first fork release targets 0.1.0. It requires manual migration from historical
`paseo-fork-*` builds. New clients use signed fork semver releases for upgrade
ordering; historical numeric release metadata is retained only for explicit local
recovery. No 0.1.0 release has been published yet.
