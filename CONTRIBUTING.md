# Contributing to RenewalRadar

Thanks for your interest. RenewalRadar is intentionally small: a dependency-free static web app with all logic in one pure core module. Please keep it that way.

## Ground rules

- No runtime dependencies, no build step, no backend. If a change needs a library, it probably belongs in a different project.
- All date, money, and validation logic belongs in `core.js` as pure functions, so it stays testable in Node. The UI in `app.js` should not reimplement math.
- User data must never leave the browser. Do not add analytics, remote fonts, CDN assets, or any network calls.
- Every behavior change needs tests. Run `npm test` before opening a pull request and make sure the suite is green.

## Development

You only need Node 20 or newer for the tests, and any static file server (or just opening `index.html`) for the UI.

```bash
npm test
```

## Pull requests

- Keep changes focused and describe the user-visible effect.
- Note how you tested: the test count before and after, and the widths you checked the layout at (280, 412, 768, and 1366 px are the reference widths; there must be no horizontal overflow at any of them).
- Do not commit screenshots with real personal data. Demo data in screenshots must be the built-in fictional demo items.
