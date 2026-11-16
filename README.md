# RenewalRadar

[![CI](https://github.com/RahilSahu/renewalradar/actions/workflows/ci.yml/badge.svg)](https://github.com/RahilSahu/renewalradar/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

A local-first subscription and bill tracker: see your monthly burn and never get surprised by a renewal again.

RenewalRadar tracks every recurring charge in one place: streaming, SaaS, utilities, insurance, domains, the gym. It shows what you actually spend per month once weekly, quarterly, and yearly bills are normalized, what is about to renew, and every charge coming in the next 90 days. There is no account and no server. Everything runs in your browser and your data never leaves your device.

**Live demo:** https://renewalradar-phi.vercel.app: click "Load demo data" to explore it with fictional items.

![RenewalRadar dashboard showing demo data](docs/dashboard.png)

*The screenshot above is the real app running with the built-in fictional demo data.*

## Features

- Add, edit, and delete items with a name, amount, currency (INR, USD, EUR, GBP), billing cycle (weekly, monthly, quarterly, half-yearly, yearly, one-time), category, next renewal date, an optional payment label such as the card that gets charged, optional notes, and an active or paused status.
- Dashboard stat cards: monthly burn and yearly cost normalized per currency (currencies are never mixed into one total), the active item count, and the amount actually due in the next 30 days, per currency.
- Renewing soon list with effective renewal dates: recurring items roll forward automatically, and badges flag overdue one-time items in red and anything due within 7 days in amber.
- Upcoming charges: every projected charge for the next 90 days, grouped by month with per-currency totals.
- Category breakdown as a bar chart of normalized monthly spend, with a currency switcher.
- Search and category filter chips. Paused items are excluded from every total but stay listed, visually muted.
- Empty state with one-click demo data (7 fictional items) so you can see the dashboard before entering anything real.
- Export your data to JSON and import it back, with strict validation and a clear error if a file is bad. A bad file never half-loads.
- Dark, responsive interface that stays readable and overflow-free from small phones (280 px) to desktop.

## Privacy

RenewalRadar is local-first by design:

- All data is stored in your browser's localStorage, on your device only.
- There is no backend, no account, no analytics, and the page makes no network requests after it loads.
- Export and import happen entirely on your device.

Two consequences worth knowing: clearing your browser's site data deletes your tracker, so export a backup now and then; and anyone with access to your browser profile can see the data, so do not put passwords or card numbers in the notes field. See [SECURITY.md](SECURITY.md) for the full model.

## Run it locally

No build step and no dependencies. Any static file server works:

```bash
git clone https://github.com/RahilSahu/renewalradar.git
cd renewalradar
python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` directly from disk also works in most browsers.

## Usage

1. Click **Add item** and enter the subscription or bill: what it costs, how often it renews, and the next renewal date.
2. The dashboard updates immediately: burn rate at the top, renewals sorted by urgency, and a 90 day lookahead of charges.
3. Pause items you have cancelled but want to keep a record of. They stop counting toward every total.
4. Use **Export JSON** for backups and **Import JSON** to restore or move to another browser. Imports replace the current items after a confirmation, and only after the whole file validates.

## Development

All logic lives in `core.js` as pure functions (date and cycle math with month-end clamping and leap years, renewal projection, per-currency totals, validation). It runs in the browser as `window.RenewalCore` and in Node via `module.exports`, so the test suite exercises the exact code the UI ships. `app.js` is DOM and storage only.

```bash
npm test   # node --test, no dependencies to install
```

The suite currently has 39 tests covering cycle stepping (including Jan 31 clamping and Feb 29 yearly renewals), normalization factors, effective-next rolling, 90 day occurrence generation, per-currency totals with paused and one-time items, days-left and badge boundaries, filtering, breakdown shares, and validation failures.

## Project structure

```
index.html          page markup
styles.css          dark theme, responsive to 280 px
core.js             pure logic, shared by the UI and the tests
app.js              DOM rendering and localStorage state
tests/core.test.js  node:test suite for core.js
```

## Roadmap

Honest future ideas, none of which are in v1.0.0:

- Optional per-item reminder offsets (for example, warn 3 days before a yearly charge).
- Multiple named lists (personal, family, business) in one browser.
- A yearly calendar view of charges.

## License

MIT. See [LICENSE](LICENSE).
