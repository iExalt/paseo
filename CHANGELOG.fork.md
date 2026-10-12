# Changelog

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
