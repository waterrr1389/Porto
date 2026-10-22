# Agent rules

Read `ARCHITECTURE.md` first. It defines the modules, their contracts and the
invariants; this file only covers how to work in the repository.

## Code

- To use a module, read its entry file (`name.ts` or `name/index.ts`) and nothing else. If that is not enough
  to use it correctly, fix the module's interface or doc comments rather than
  reaching into its implementation.
- New logic goes into `src/core/` as a pure function unless it needs I/O.
  Edge code (adapters, http, effects, views) stays thin; adapters are covered
  by HTTP-level tests, not unit tests.
- Do not modify `vendor/yomitan`. If Yomitan's behaviour must change, wrap it in
  `adapters/dictionary`.
- Comments explain intent and constraints, not history.

## Verification

- `npm run check` (type check) and `npm test` must pass before every commit.
- Functional behaviour is verified through tests or the HTTP API, not through a
  browser.
- Visual results are assumed correct; the user checks them on the device and
  reports problems.
- After any change to media handling, ask the user to run the device
  checklist on iPad and iPhone: playback starts; seeking forward and back,
  including far ahead of what has buffered; subtitles stay aligned; playback
  resumes after toggling WireGuard; subtitles and panel stay visible in
  fullscreen (iPad) and with `playsinline` (iPhone).

## Commits

- Small commits, one intent per commit, so every commit builds and passes
  tests (keeps `git bisect` usable).
- Messages follow Conventional Commits 1.0.0, in English:
  `<type>(<scope>): <description>`, imperative, lower case, no trailing
  period, at most 72 characters. Types: `feat`, `fix`, `refactor`, `perf`,
  `test`, `docs`, `build`, `chore`, `style`, `ci`. Scope is a module name
  such as `core/scan` or `adapters/media`. Use a body to explain why when the
  change is not self-evident; mark breaking API changes with `!` or a
  `BREAKING CHANGE:` footer.
- Keep history linear; rebase on top of remote changes.
- Never commit anything under `cache/`, `state/`, `vendor-build/` or media files.
