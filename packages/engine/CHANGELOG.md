# Changelog

## [0.9.0](https://github.com/spec-engine/spec-engine/compare/v0.8.1...v0.9.0) (2026-10-23)


### Features

* **check:** report MIGRATION_PENDING for a SPEC.json that still carries livesIn or verifiedIn ([1608e2c](https://github.com/spec-engine/spec-engine/commit/1608e2cc90c16c84cfbe5684f34b0bd89d7fb0f7))
* **check:** report STATEMENT_RULES and add spec lint ([99c4d4c](https://github.com/spec-engine/spec-engine/commit/99c4d4cf02f075a75f728c0fc388617290767c15))
* **engine:** derive implementing and verifying sites from tags; retire livesIn and verifiedIn ([746b149](https://github.com/spec-engine/spec-engine/commit/746b1497264e0a945c939a90478388e464f561aa))
* **engine:** refuse a statement that breaks an enabled rule at authoring time ([f2d8a50](https://github.com/spec-engine/spec-engine/commit/f2d8a50cfa475fdad1bd777f783c789587023e92))
* **engine:** supersede, move, and deprecate apply the retag ([044e7d7](https://github.com/spec-engine/spec-engine/commit/044e7d75a5113bc11301ff877c4db35f40710128))
* **init:** install the agent surface and bundle it in the npm payload ([2b57084](https://github.com/spec-engine/spec-engine/commit/2b5708443b25e2127212c90464ecccacfbcbdee1))


### Bug Fixes

* **check:** warn when --ci runs without --base on a tree equal to HEAD ([e8518c2](https://github.com/spec-engine/spec-engine/commit/e8518c22cad2f28510ee2a0637ff197453898628))
* **engine:** a statement rule graded warning writes and reports instead of refusing ([d4cd014](https://github.com/spec-engine/spec-engine/commit/d4cd0142c680afa0f770f17091bf8f6313d6315d))
* **engine:** scrub inherited GIT_* repository variables from git spawns ([bee8ca5](https://github.com/spec-engine/spec-engine/commit/bee8ca53cabd7e7ddf5dd926837efa9f0a71d3f3))
* **init:** strip this repository's doc tags from the installed agent reference ([e4b67ec](https://github.com/spec-engine/spec-engine/commit/e4b67ec5c7f9faa46fe37b65f336e4e97a090c63))
* **spec:** renumber GUARD-030 to GUARD-031, the id is taken on main by [#78](https://github.com/spec-engine/spec-engine/issues/78) ([4338c77](https://github.com/spec-engine/spec-engine/commit/4338c773f37241a96d8e9afb296f209d4a02d856))
* **spec:** renumber the agent-payload DIST-019 to DIST-020, the id is taken by the agent-reference successor ([d41eb1e](https://github.com/spec-engine/spec-engine/commit/d41eb1e5784e4072f2d9e8ab82d587a2d6314988))

## [0.8.1](https://github.com/spec-engine/spec-engine/compare/v0.8.0...v0.8.1) (2026-10-22)


### Bug Fixes

* piped --json delivered whole; lone-repo root files keyed platform-relative ([#71](https://github.com/spec-engine/spec-engine/issues/71)) ([5b90acf](https://github.com/spec-engine/spec-engine/commit/5b90acf31d2c598fce809ea24852bc886119c286))

## [0.8.0](https://github.com/spec-engine/spec-engine/compare/v0.7.3...v0.8.0) (2026-10-22)


### Features

* **engine:** verifiedIn names the test file expected to prove a requirement ([#70](https://github.com/spec-engine/spec-engine/issues/70)) ([529db11](https://github.com/spec-engine/spec-engine/commit/529db11a288e5aaea1d05cb659720be46b6b1a20))
* **scanner:** read .yml, .yaml, and .astro sources and open .github/ ([#65](https://github.com/spec-engine/spec-engine/issues/65)) ([84fee7b](https://github.com/spec-engine/spec-engine/commit/84fee7b6a794770884a3aaba34850b327d5f1e37))


### Bug Fixes

* **engine:** name a lone repository's column root when its directory is spec-engine ([#66](https://github.com/spec-engine/spec-engine/issues/66)) ([3779bbb](https://github.com/spec-engine/spec-engine/commit/3779bbb42c4dd79b51da7d446358e024f3ba0a61))
* **query:** match a hyphenated word instead of parsing it as FTS5 syntax ([#67](https://github.com/spec-engine/spec-engine/issues/67)) ([1c164b2](https://github.com/spec-engine/spec-engine/commit/1c164b29fd42cc7fe28db8263b5e873e6bbfe5e6))

## [0.7.3](https://github.com/spec-engine/spec-engine/compare/v0.7.2...v0.7.3) (2026-10-21)


### Bug Fixes

* **deps:** update @modelcontextprotocol/sdk to 1.32.0 [security]; align zod to 4.4.3 ([#63](https://github.com/spec-engine/spec-engine/issues/63)) ([94b57fe](https://github.com/spec-engine/spec-engine/commit/94b57fe209e6bbcfe01de7d991f024542bad82bf))

## [0.7.2](https://github.com/spec-engine/spec-engine/compare/v0.7.1...v0.7.2) (2026-10-21)


### Bug Fixes

* **deps:** update dependency hono to v4.13.11 [security] ([#56](https://github.com/spec-engine/spec-engine/issues/56)) ([b7b925c](https://github.com/spec-engine/spec-engine/commit/b7b925cf01585d01e72deaad14b17697ea4c697d))

## [0.7.1](https://github.com/spec-engine/spec-engine/compare/v0.7.0...v0.7.1) (2026-10-21)


### Features

* **grammar:** one-promise lint in EARS; spec domain grammar; every domain at error ([#53](https://github.com/spec-engine/spec-engine/issues/53)) ([ef25646](https://github.com/spec-engine/spec-engine/commit/ef25646d8349e434c48778c8738ac6d9eb0b5024))
* **surfaces:** spec_req, spec_amend, spec_move on MCP; POST /api/requirements/:id/move ([#51](https://github.com/spec-engine/spec-engine/issues/51)) ([7c794d8](https://github.com/spec-engine/spec-engine/commit/7c794d839a0441eb3e88174362412be8ceefd39a))


### Bug Fixes

* **git,api:** refuse hyphen-led refs; 422 with rows when a write's reindex refuses ([#52](https://github.com/spec-engine/spec-engine/issues/52)) ([a58b8f5](https://github.com/spec-engine/spec-engine/commit/a58b8f586534733be8398be0c562afc9b654d743))


### Continuous Integration

* **release:** release-please opens the release PR; publish runs on its release; Renovate keeps pins current ([#50](https://github.com/spec-engine/spec-engine/issues/50)) ([503c813](https://github.com/spec-engine/spec-engine/commit/503c81341a0033d08983185d277473efc7385ab1))
