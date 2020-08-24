# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [6.0.0-beta.1] - 2020-08-24

### Changed

- Update to latest Redis client library.

## [6.0.0-beta.1] - 2020-08-23

### Changed

- Updated to TypeScript 4.
- Tests can now be run using `npm test`.

## [6.0.0-alpha.8] - 2020-08-19

### Added

- Full native TypeScript support.
- Linting using `eslint`.
- Code formatting using `prettier`.

### Changed

- The `cache-manager` library has been removed, and replaced with direct access to Redis and an LRU cache.
- Cache construction options have changed, if you choose to construct a cache manually (which is no longer encouraged).
- You should use `cache.wrap` and `cache.get` to acccess the cache.
- Locking has been totally rewritten.
- The test suite has been replaced with the excellent 4.x test suite, ported to `mocha`.

### Fixed

- Quite a few minor bugs have been fixed. Some new ones have probably been added.

### Removed

- A subtantial number of implementation details have been removed from the public API.
