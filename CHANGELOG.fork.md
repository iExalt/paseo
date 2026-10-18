# Changelog

## [0.10.0](https://github.com/iExalt/paseo/compare/paseo-v0.9.0...paseo-v0.10.0) (2026-10-18)


### Features

* **cli:** choose queue, steer or interrupt for agent sends to a running agent ([#192](https://github.com/iExalt/paseo/issues/192)) ([5bd53f9](https://github.com/iExalt/paseo/commit/5bd53f93cf473b0d62699685325257cee2239527))
* **codex:** include native subagent threads in chat cost ([#193](https://github.com/iExalt/paseo/issues/193)) ([3ad767d](https://github.com/iExalt/paseo/commit/3ad767d5554ba87648d27f208ceee0d75e12735f))
* **skills:** add update-nix-paseo skill for staging and activating fork releases ([#191](https://github.com/iExalt/paseo/issues/191)) ([376b4d6](https://github.com/iExalt/paseo/commit/376b4d6403b7dd42bbb70d94da50edb7f226ab49))


### Bug Fixes

* **app:** match tab close confirmations to mobile layout ([#189](https://github.com/iExalt/paseo/issues/189)) ([36bb237](https://github.com/iExalt/paseo/commit/36bb237ae62b86295d3e907d54b561776e8f2bde))

## [0.9.0](https://github.com/iExalt/paseo/compare/paseo-v0.8.0...paseo-v0.9.0) (2026-10-18)


### Features

* show API spend by provider in Settings &gt; Usage ([#187](https://github.com/iExalt/paseo/issues/187)) ([983f3f5](https://github.com/iExalt/paseo/commit/983f3f5bac2cffc80ddc5837c601c7213fb4e456))


### Bug Fixes

* **ci:** run releases on dev so the next one reads their Android caches ([#186](https://github.com/iExalt/paseo/issues/186)) ([baa39ef](https://github.com/iExalt/paseo/commit/baa39efd14fc272423155d1b495751d76320df8f))

## [0.8.0](https://github.com/iExalt/paseo/compare/paseo-v0.7.0...paseo-v0.8.0) (2026-10-17)


### Features

* keep, report and show agent session cost ([#184](https://github.com/iExalt/paseo/issues/184)) ([0c730a4](https://github.com/iExalt/paseo/commit/0c730a47fbcad16cdf7cdd7087c248b8816599da))

## [0.7.0](https://github.com/iExalt/paseo/compare/paseo-v0.6.0...paseo-v0.7.0) (2026-10-17)


### Features

* **app:** copy session ID from workspace menus ([#172](https://github.com/iExalt/paseo/issues/172)) ([868ac7b](https://github.com/iExalt/paseo/commit/868ac7bd60163672eae0e84695431c50e8023002))
* **app:** fold finished subagents out of the subagents track ([#177](https://github.com/iExalt/paseo/issues/177)) ([f513d0b](https://github.com/iExalt/paseo/commit/f513d0beba9fcb57c45f42c27729194e4f7cb7b2))


### Bug Fixes

* **app:** fire the first tap in Android bottom sheets ([#178](https://github.com/iExalt/paseo/issues/178)) ([f7fa329](https://github.com/iExalt/paseo/commit/f7fa32946b2bc3dba82906f269b9547b4b50d948))
* **app:** keep the find code block unwrapped so marking a match does not shift it ([#181](https://github.com/iExalt/paseo/issues/181)) ([faf5215](https://github.com/iExalt/paseo/commit/faf5215d96c71e723ae8e49b3b186499547e3346))
* **app:** let the Android soft keyboard Return insert a newline ([#174](https://github.com/iExalt/paseo/issues/174)) ([0a63f57](https://github.com/iExalt/paseo/commit/0a63f5703bd060161838061c5de35a567158c423))
* **app:** read sheet focus from expo-router so compact sheets open ([#182](https://github.com/iExalt/paseo/issues/182)) ([9df6b7b](https://github.com/iExalt/paseo/commit/9df6b7be8cb67f3815460ae2a9fb2cc452699947))
* **app:** steer instead of interrupting when a send skips the queue ([#175](https://github.com/iExalt/paseo/issues/175)) ([486ff1c](https://github.com/iExalt/paseo/commit/486ff1cffd9308fb7457f366e8dacfa0ac761a4f))
* **app:** stop the settings icon flash on Android ([#179](https://github.com/iExalt/paseo/issues/179)) ([5287c2b](https://github.com/iExalt/paseo/commit/5287c2b44379836a4411584dd892cce5dddd5e44))
* **ci:** allow runner swap on release tag pushes ([#168](https://github.com/iExalt/paseo/issues/168)) ([ea76afd](https://github.com/iExalt/paseo/commit/ea76afd4dd1597ea4beb6572c7d3cf59129af8b1))
* **ci:** deflake rebase-dev rerere and repair submission browser specs ([#183](https://github.com/iExalt/paseo/issues/183)) ([9747c6b](https://github.com/iExalt/paseo/commit/9747c6b9880d4b50b5aa3c5fca8135ad376d67a8))
* **ci:** unblock rebase-dev on current dev and upstream ([#164](https://github.com/iExalt/paseo/issues/164)) ([421cefb](https://github.com/iExalt/paseo/commit/421cefb728e12c841fbf278367da8f3cdbe7aa56))
* **server:** rewind Claude conversations in place instead of forking ([#173](https://github.com/iExalt/paseo/issues/173)) ([935c093](https://github.com/iExalt/paseo/commit/935c09372b142807727f94a5c64180fc49813c2e))

## [0.6.0](https://github.com/iExalt/paseo/compare/paseo-v0.5.0...paseo-v0.6.0) (2026-10-17)


### Features

* **app:** close desktop and mobile parity gaps ([#161](https://github.com/iExalt/paseo/issues/161)) ([669d95c](https://github.com/iExalt/paseo/commit/669d95cd2b4cce80655d79555258b31955add7fa))


### Bug Fixes

* **desktop:** install the Nix app as a real /Applications copy ([#163](https://github.com/iExalt/paseo/issues/163)) ([bd240c0](https://github.com/iExalt/paseo/commit/bd240c0f8385fc4b26e8ed6aeaff96663e48d782))
* **server:** defer a steer the provider cannot take instead of interrupting ([#165](https://github.com/iExalt/paseo/issues/165)) ([dd7346c](https://github.com/iExalt/paseo/commit/dd7346ca153182677afe4995c32b5226f282780e))

## [0.5.0](https://github.com/iExalt/paseo/compare/paseo-v0.4.2...paseo-v0.5.0) (2026-10-16)


### Features

* **app:** show Android fork updates in the sidebar and remember them ([2754cfb](https://github.com/iExalt/paseo/commit/2754cfb4a6a9cfa5dde054f5f978365ec941e6a3))

## [0.4.2](https://github.com/iExalt/paseo/compare/paseo-v0.4.1...paseo-v0.4.2) (2026-10-16)


### Performance Improvements

* **app:** draw plain SVG icons straight to the hardware canvas on Android ([ca00020](https://github.com/iExalt/paseo/commit/ca0002056368bafebf85300d2444430fb32d93b5))
* **app:** load older chat history two screens before the top on mobile ([9512251](https://github.com/iExalt/paseo/commit/951225129c55f726f6341d56f8403af93b365ed5))
* **app:** skip Reanimated work for events no worklet handles on Android ([9678cbb](https://github.com/iExalt/paseo/commit/9678cbb480ccd09e09eb6812aaa473f4acfc84f9))

## [0.4.1](https://github.com/iExalt/paseo/compare/paseo-v0.4.0...paseo-v0.4.1) (2026-10-16)


### Bug Fixes

* **desktop:** offer a newer release over a stale staged download ([4da57a7](https://github.com/iExalt/paseo/commit/4da57a7c0b69aec37086f861fb04433c91923dfe))

## [0.4.0](https://github.com/iExalt/paseo/compare/paseo-v0.3.2...paseo-v0.4.0) (2026-10-16)


### Features

* **app:** keep running status rings still under reduced motion ([b973bd7](https://github.com/iExalt/paseo/commit/b973bd73fa4c8767d31106a4cdaf3155d52c73c8))


### Bug Fixes

* **app:** report a lost replica directory read as a miss ([0bc7f83](https://github.com/iExalt/paseo/commit/0bc7f838f518c5f98b39e12739415d050906478f))
* **app:** report unanswerable replica directory reads as misses ([c635af9](https://github.com/iExalt/paseo/commit/c635af90643cc23ec896c038116e09e8e5dc2e02))
* **app:** retry a failed replica index load and handle scan errors ([1b6efaf](https://github.com/iExalt/paseo/commit/1b6efafaf733ac3fb79e1fea18b02ab059600d50))
* **app:** scope replica cache read conflicts to the rows being read ([a0bd352](https://github.com/iExalt/paseo/commit/a0bd35228bf8eaf5a8a242a833a8d911c89ab0f6))


### Performance Improvements

* **app:** apply non-layout animated props without a shadow-tree commit on Android ([622cbaf](https://github.com/iExalt/paseo/commit/622cbafd8220fb3e31f57796b20d30bc0abed46c))
* **app:** commit the stream state and timeline cursor in one store write ([7b01025](https://github.com/iExalt/paseo/commit/7b0102552acaea5586627b06e94cb9a5b312f1d6))
* **app:** count replica row bytes with a native encoder ([5bcdeeb](https://github.com/iExalt/paseo/commit/5bcdeeba39d0b37253109248d4a5ed933ff6db4f))
* **app:** drop per-row component and query churn from chat rows ([6df8687](https://github.com/iExalt/paseo/commit/6df86876941eead2b230c52b0ae2bcf6a19ab6f3))
* **app:** index replica rows by size without loading payloads ([b85da98](https://github.com/iExalt/paseo/commit/b85da9814c1c97c53e448c45aeb02d149cdda9cc))
* **app:** join the live head into replica timelines only when persisting ([bac7296](https://github.com/iExalt/paseo/commit/bac72967fbb8ead75d3bec17e83762a1ed51cdef))
* **app:** keep chat presentation caches warm across ticks and remounts ([3b707b1](https://github.com/iExalt/paseo/commit/3b707b1f23651e5a48676da11868c408ef9f0c64))
* **app:** restore timeline tasks without copying the history ([5b7cb22](https://github.com/iExalt/paseo/commit/5b7cb22781788ecc64fae8dc19df9bdd9cecc47b))
* **app:** skip collapsed project status rescans on stream commits ([f42fc7f](https://github.com/iExalt/paseo/commit/f42fc7f5126cc67bd259a83ec49e08b5b0905a1c))
* **app:** skip per-frame selector rescans for agent visibility, subagents and favicon ([69a489b](https://github.com/iExalt/paseo/commit/69a489b75b14ffcf8246c0ef26da9700c989c967))
* **app:** skip the definition re-parse for blocks that cannot be definitions ([4e7fa81](https://github.com/iExalt/paseo/commit/4e7fa8112c192c3e90705e5c6e9a0eba94c63758))
* **app:** stop hidden chats from rendering on their agent's stream commits ([0c804eb](https://github.com/iExalt/paseo/commit/0c804ebc200d04911a7210cfcee2a682c8e4e6f9))
* **app:** stop hidden status rings from driving a per-frame UI-thread commit ([50bda1b](https://github.com/iExalt/paseo/commit/50bda1bfe977559b96eda5781de46efb6cfa580b))
* **app:** trim per-render and per-persist history scans ([09da314](https://github.com/iExalt/paseo/commit/09da314cbca3e74451a91ddd1e7929dc928939b4))
* **relay:** add a sliced NaCl box open that yields between slices ([a4649a9](https://github.com/iExalt/paseo/commit/a4649a91ba6aa59fbbd08da96c574f7047a10645))
* **relay:** decode base64 frames with the runtime's native decoder ([1713e3b](https://github.com/iExalt/paseo/commit/1713e3bab0fcaf80f4993021672ff202167a679a))
* **relay:** decrypt large frames in slices behind an ordered receive chain ([03ce16e](https://github.com/iExalt/paseo/commit/03ce16e1c8d09647fcdbd1bf570424a9bbdaae77))

## [0.3.2](https://github.com/iExalt/paseo/compare/paseo-v0.3.1...paseo-v0.3.2) (2026-10-16)


### Bug Fixes

* **app:** spin the update icon and show transfer progress on its button ([671b571](https://github.com/iExalt/paseo/commit/671b571a0fb4b94eb9f530771b5bd5c17dfede82))

## [0.3.1](https://github.com/iExalt/paseo/compare/paseo-v0.3.0...paseo-v0.3.1) (2026-10-16)


### Bug Fixes

* **app:** style Transfer preferences like the other About rows ([77c4bb6](https://github.com/iExalt/paseo/commit/77c4bb68a5baf4e32c6bcbbd82b39c612a04e402))

## [0.3.0](https://github.com/iExalt/paseo/compare/paseo-v0.2.2...paseo-v0.3.0) (2026-10-16)


### Features

* **desktop:** one-button Nix updates with an hourly background download ([4cc0b0a](https://github.com/iExalt/paseo/commit/4cc0b0a8f6ddb6dc211e76d3463e606fa3c4367e))


### Bug Fixes

* **ci:** read every page of the proposal PR history ([83de49c](https://github.com/iExalt/paseo/commit/83de49c19c67a0ca9ee5483cd4ed37fce67fb15b))
* **desktop:** run one Nix update flow at a time ([befbcff](https://github.com/iExalt/paseo/commit/befbcff6b2770482846c3330cf3c1ce6782aeca7))

## [0.2.2](https://github.com/iExalt/paseo/compare/paseo-v0.2.1...paseo-v0.2.2) (2026-10-15)


### Bug Fixes

* **app:** hide decorative SVGs from accessibility with web-safe props ([c823dff](https://github.com/iExalt/paseo/commit/c823dffbd1a467d1d66fb0c56a07af3b66cd0264))
* **app:** stop showing the worktree setup callout ([bf31f96](https://github.com/iExalt/paseo/commit/bf31f961a4e9938ab4fba784616a61372fcdcd46))
* **app:** stop withUnistyles forwarding uniProps to DOM elements on web ([96f079e](https://github.com/iExalt/paseo/commit/96f079e75d1c38a6c572b97c361a0e01083ab23a))
* **ci:** wait out a stale proposal ref read after the push ([95ebcde](https://github.com/iExalt/paseo/commit/95ebcde9c496156cf20ab3870533dc42bdb45df5))


### Performance Improvements

* **nix:** bundle the macOS web export with two Metro workers ([2bdfc6d](https://github.com/iExalt/paseo/commit/2bdfc6dc08d2d3acb7535756dbcbbbbf5a677fa5))

## [0.2.1](https://github.com/iExalt/paseo/compare/paseo-v0.2.0...paseo-v0.2.1) (2026-10-15)


### Features

* **app:** default first-use send to queue and tool calls to summary ([52b653d](https://github.com/iExalt/paseo/commit/52b653d1751afdea1e63b062e6a0e2c74a2a056a))


### Bug Fixes

* **ci:** count every asar extraction failure in the macOS smoke ([eb19932](https://github.com/iExalt/paseo/commit/eb19932c9478dbecf166e020dcb0bf1bae945d98))
* **ci:** parse retry-after without a pipeline ([225c370](https://github.com/iExalt/paseo/commit/225c3701294a91fd8e9992fe0c95984a6d718d05))
* **ci:** report GitHub's response when creating a release or asset fails ([51b77d1](https://github.com/iExalt/paseo/commit/51b77d1d8f8d3330cbb5519e74ed1ebb72daeab5))
* **ci:** resend the release payload from a file on a create retry ([7e39089](https://github.com/iExalt/paseo/commit/7e390898d4164886ca6bc28f9add788355d886d6))
* **ci:** upload ccache debug logs only when packing succeeded ([942f117](https://github.com/iExalt/paseo/commit/942f117ab1a6aaf7dc779b81c9de00ecf2b4155f))
* **nix-update:** register only the active bundle and prune old generations ([b69859c](https://github.com/iExalt/paseo/commit/b69859c98c13887e6571b8e4e9d36dd2dfb38b51))


### Documentation

* **ci:** explain how to ship a release at a chosen version ([bf4e4d2](https://github.com/iExalt/paseo/commit/bf4e4d22b26b51f8be5fe831f04411db167bfa06))

## [0.2.0](https://github.com/iExalt/paseo/compare/paseo-v0.1.4...paseo-v0.2.0) (2026-10-15)


### Features

* **ci:** derive the release boundary from the latest signed release ([8bdc5fd](https://github.com/iExalt/paseo/commit/8bdc5fd1173c0d63a80537c1e19482395cc40fce))
* **protocol:** accept two-cell fork release manifest schema 3 ([4727d61](https://github.com/iExalt/paseo/commit/4727d61cb3acc857aa0e3793381aefe9eb41f840))


### Performance Improvements

* **ci:** attest Linux predecessor caches and key them on the fixture alone ([9ab7fac](https://github.com/iExalt/paseo/commit/9ab7fac797ac35ea30173e0959a438003894d4c2))
* **ci:** attest Windows predecessor caches and key them on the fixture alone ([af76c56](https://github.com/iExalt/paseo/commit/af76c56325268ac60a660b6c6f85ac611eb82ad4))


### Miscellaneous Chores

* release 0.2.0 ([c283986](https://github.com/iExalt/paseo/commit/c283986612fd1d0c34ceb6dc279bff03ea16cbec))

## [0.1.4](https://github.com/iExalt/paseo/compare/paseo-v0.1.3...paseo-v0.1.4) (2026-10-15)


### Bug Fixes

* **ci:** degrade candidate cache failures to a miss ([e29298c](https://github.com/iExalt/paseo/commit/e29298c0a652676fa324522a83317055cfd561aa))
* **ci:** fetch Electron in the lane that runs the desktop units ([b3d289a](https://github.com/iExalt/paseo/commit/b3d289a8b7b97d0e3cb5d87a2310f3d4b6f984ec))
* **ci:** key the Android build cache on the lock alone ([8cb5517](https://github.com/iExalt/paseo/commit/8cb551762b4a4592e2002f4684c977bafb955852))
* **ci:** read the ccache version Ubuntu 24.04 ships ([05bbbe0](https://github.com/iExalt/paseo/commit/05bbbe0a1852e5dc0dd29e432286d3376acffb72))
* **ci:** revoke Dev Drive trust when Defender detaches ([5899667](https://github.com/iExalt/paseo/commit/5899667c929b8fa56c722c4f88c2ed9f0611c782))
* **desktop:** sign the Nix macOS bundle as Paseo so notifications deliver ([faeb8e8](https://github.com/iExalt/paseo/commit/faeb8e8110f3ed6f9901bccbaa17a0c13827ee5a))


### Performance Improvements

* **ci:** balance server test shards by recorded duration ([30b3a49](https://github.com/iExalt/paseo/commit/30b3a494a3fd2afcc6352e0c1821a9e3be4f1d50))
* **ci:** compile the fork APK's native code through an attested ccache ([70ac61a](https://github.com/iExalt/paseo/commit/70ac61afb518bd5bef690bcac52ee1ec004fbb47))
* **ci:** issue signing, import and cross-check grants alongside their producers ([7bd0fbe](https://github.com/iExalt/paseo/commit/7bd0fbe9af4948846d598d4cc04f0ec8afa42f8c))
* **ci:** order shard ties by code unit, not locale ([e14ff89](https://github.com/iExalt/paseo/commit/e14ff89ad5905d0f223711d3f68a659b19010964))
* **ci:** restore attested installed dependencies for Windows arm64 candidates ([851bff1](https://github.com/iExalt/paseo/commit/851bff14ec3c10643ef22868dffdca3218445ba2))
* **ci:** reuse attested Gradle build outputs for the fork APK ([a76f747](https://github.com/iExalt/paseo/commit/a76f747db88ce8ed4f70a3d62a7b8072189e7869))
* **ci:** start native candidate builds alongside re-verification ([089472f](https://github.com/iExalt/paseo/commit/089472f8a0886e145acc3ff74421a929c9b71b4d))
* **ci:** trust the Windows arm64 build Dev Drive ([9f64b94](https://github.com/iExalt/paseo/commit/9f64b94fd675c9c4c91d8f5ce8b1db0d326f4bff))
* **ci:** verify candidate draft assets four at a time ([bea6d1d](https://github.com/iExalt/paseo/commit/bea6d1d9436d6c8014990ad086d7c90cd424124e))

## [0.1.3](https://github.com/iExalt/paseo/compare/paseo-v0.1.2...paseo-v0.1.3) (2026-10-14)


### Bug Fixes

* **ci:** install Electron before parallel desktop units ([4385eda](https://github.com/iExalt/paseo/commit/4385eda742a038a2b130060bccd0f4145b8ee135))
* **release:** wait for the pulls API to report the pushed proposal head ([9f99ffe](https://github.com/iExalt/paseo/commit/9f99ffea89eb873d243979c5140c5620f4c30668))


### Performance Improvements

* **ci:** keep one dependency cache across runner image rollouts ([b1792e5](https://github.com/iExalt/paseo/commit/b1792e5e6a22fe3edb6c7fd5d4e0f467ef601391))

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
