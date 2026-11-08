# Contributing

## Workflow

1. Every change starts with an issue: a bug report or a feature request.
2. Work on a branch named after the issue. `gh issue develop <issue> --checkout`
   creates `<issue>-<title>`.
3. Open a pull request against `main`. The _Tickets_ check links the issue
   (`Closes #<issue>`); a pull request without a ticket fails.
4. CI runs on every pull request. When all checks are green, _Auto-merge_
   squash-merges it. Open the pull request as a draft while it is not ready.
5. The merge closes the issue. `main` always holds the latest valid state
   (trunk-based development).

## Versions and releases

- Versions follow [Semantic Versioning](https://semver.org) and exist only as
  git tags (`vMAJOR.MINOR.PATCH`).
- CI tags every merge to `main` with the next patch version.
- A release bundles the changes since the previous one: run
  _Actions → Release → Run workflow_ and pick `minor` or `major`. It tags
  `main` and publishes a GitHub release listing the merged pull requests and
  closed tickets.

## Development

No build step, no runtime dependencies. Node 26 (see `.nvmrc`).

```sh
npm ci
npm run dev      # wrangler pages dev on http://localhost:8792
npm run check    # Biome + tests, as in CI
node scripts/browser-check.mjs http://localhost:8792   # headless Chrome smoke test
```

The browser smoke test signs in with deliberately wrong credentials, so it
never drives a real vacuum. The service worker's cache names are stamped with
a content hash on deploy (`scripts/stamp-sw.mjs`), so there is nothing to
bump; a new file the app needs offline goes into `SHELL` (or `ASSETS` for
icons) in `public/sw.js`.
