# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] — 2026-06-11

### Added
- Unit test suite (Vitest) covering the security-critical pure modules: OAuth
  state codec, stateless DCR client store, redirect-URI allowlist/validation,
  tool input schemas, config parsing, and the chained token verifier (API-key path).
- `npm test` / `npm run test:watch` scripts and `vitest.config.ts`.
- Continuous integration workflow (lint + test + build) on pushes and PRs.
- ABAP service sources (`abap/`) and long-form docs (`docs_page/`).

### Changed
- API-key authentication now uses a constant-time comparison (hash + `timingSafeEqual`)
  instead of `===`, removing a timing side channel on the configured keys.
- OIDC verifier now logs a warning when `OIDC_AUDIENCE` is unset (audience is then
  not validated), making the weaker configuration explicit.
- Centralised the server version in `src/server/version.ts` (was duplicated).
- Tool descriptions are now sourced from the `TOOLS` registry, removing drift
  between `intent.ts` and `tools.ts`.
- Corrected stale doc comments ("3-scope model", "ARC-1") to match the
  authentication-only design.
- Fixed pre-existing lint violations so `npm run lint` passes clean.

## [0.1.0] — 2026-06-09

### Added
- Initial SAP Translation MCP server: 5 tools (`TranslateListLanguages`,
  `TranslateListTexts`, `TranslateGetTexts`, `TranslateSetTexts`, `TranslateCompare`)
  over the `ZCL_I18N_SERVICE` ABAP HTTP service.
- XSUAA OAuth proxy (stateless DCR + signed callback state), OIDC and API-key auth.
- BTP deployment (MTA), Destination + Connectivity (principal propagation).

[Unreleased]: https://github.com/ClementRingot/sap-translator/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/ClementRingot/sap-translator/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ClementRingot/sap-translator/releases/tag/v0.1.0
