# Price parity test

Drives the agent-view comparator funnel in a real browser and checks that two funds loaded from the same rate file show the same prices and benefits.

- **Expected fund:** loaded with the existing rate file import (CPS locally, Phoenix in dev).
- **Actual fund:** loaded with the Snowflake sync (itsmy locally, Phoenix Snowflake Sync in dev).

Every price row in the rate file must show up on screen for both funds with the same values. The tool only drives a running comparator through the browser; it uses no app code.

## Setup

Needs Node 22+ and Yarn 1 (`npm install -g yarn`).

```bash
git clone git@github.com:karina-itsmy/puppeteer-price-parity.git
cd puppeteer-price-parity
yarn install   # also downloads Puppeteer's Chrome
yarn test
```

Then add the gitignored pieces (ask whoever runs the tool today; send privately):

| What | Where |
| --- | --- |
| Configs, e.g. `dev.json` | `config/` (start from `config/local.example.json`) |
| Rate files (`.xlsx`) | `rate-files/` |
| Basic-auth login for deployed slots | `.env.local`: `PRICE_PARITY_AUTH_USER`, `PRICE_PARITY_AUTH_PASSWORD` |

`.env.local` is read first, then `.env`; exported shell variables win over both.

## Running

```bash
yarn price-parity --config dev --search VIC/single/hospital   # one search, to check setup
yarn price-parity --config dev                                # full sweep, ~1.5 hours
```

The full sweep runs one search per state × membership × cover type, then the variation set. On a Mac it keeps the machine awake, but closing the lid on battery still sleeps it.

| Option | What it does |
| --- | --- |
| `--config <name>` | Uses `config/<name>.json` (default `local`) |
| `--search VIC/single/hospital` | Runs only that search. Repeatable |
| `--set full-sweep` / `--set variations` | Runs one set only |
| `--lead <id>`, `--expected-lead`, `--actual-lead` | Overrides the lead (per side in two-environment mode) |
| `--headless`, `--slow-mo 250`, `--keep-open` | Browser visibility and pacing |
| `--screenshots all` | Whole-page screenshot for every search |
| `--rate-file <path>`, `--price-date <YYYY-MM-DD>` | Overrides the config |
| `--rerun <run folder>` | Re-runs only failed or errored searches, writing into that run's folder |
| `--resume <run folder>` | Continues a run that stopped part way |
| `--report-only <run folder>` | Rebuilds the report from `results.json` without a browser |

A failing search is retried once in a fresh tab, then recorded as an error. Setup problems (app unreachable, lead not loading, fund missing from the filter) stop the run.

## Config

| Field | What it is |
| --- | --- |
| `baseUrl`, `leadId` | Comparator address and Zoho lead id (omit in two-environment mode) |
| `expectedFund`, `actualFund` | `{ "code": "cps", "name": "see-u by HBF" }`, name as the fund filter shows it |
| `rateFiles` | Rate files in load order, relative to `config/` |
| `priceDate` | Optional, default today |
| `profile` | `age`, `rebateTier` (`none`, `base`, `tier1`–`tier3`), `lhcAge` (`null` for none) |
| `variationFile` | Optional extra searches × profiles for rebate and LHC maths |
| `headless`, `slowMo`, `screenshots`, `searches` | Optional run settings |
| `expectedNameDifferences` | Optional `[{ "expected": "...", "actual": "...", "code"?: "..." }]` renames that shouldn't fail |

No credentials go in config.

**Price increases:** list the full load and its increments in `rateFiles` in load order and set `priceDate` inside the increment window. Each product is checked at its latest price on that date, and the report adds a **Price movement** sheet (increase, decrease, 1 ¢ rounding, unchanged, new).

**Local comparator:** run comparator-legacy on `127.0.0.1:8000` and comparator-need-analysis-3 on `localhost:3000` with `VIEW_TYPE="agent"`, `CORPORATE_ID=1`, `ITSMY_API_URL=http://127.0.0.1:8000/api`, `PACKAGE_SEARCH_ULTATE_ENDPOINT=""`, `USE_OKTA_AUTHENTICATION=false`. The corporate must list both funds, the lead must exist, and both funds' prices must be current.

## Comparing two environments

When the funds sit on different comparators (e.g. prod Phoenix vs dev `phoenix test`), give each fund its own `baseUrl` and `leadId` and drop the top-level ones. Each side gets its own browser; searches run on both at once. Per-side logins go in `.env.local` as `PRICE_PARITY_EXPECTED_AUTH_*` / `PRICE_PARITY_ACTUAL_AUTH_*` (falling back to `PRICE_PARITY_AUTH_*`).

For two local comparator-3 instances, run dev on port 3000 (`ITSMY_ENVIRONMENT=local`) and prod on 3001 (`ITSMY_ENVIRONMENT=staging` with the prod API and Kong key; not `production`, which breaks card reading).

**Prod safety:**

- One agreed agent-view lead; the script never creates leads and never clicks anything that writes.
- Off-hours only, never during a rate-rise load window (~13 s of prod Django per search).
- Note prod's latest price load job id before and after; re-run affected searches if it changed.
- Smoke 2–3 searches with `--search` first.
- Check the fund's prod prices haven't expired on the run date.

## Reading the report

Each run writes `output/<config>-<timestamp>/`:

- `summary-<time>.html`: open first. PASS/FAIL, counts, per-field checks, coverage grid, differences and screenshots. Prints to A4 PDF.
- `report-<time>.xlsx`: All rows, Benefits, Differences, Missing, Unexpected, Errors, Expected differences, Variation sheets and Evidence.
- `screenshots/` and `results.json` (read by `--rerun` and `--report-only`).

The command exits 0 whenever a report is written; check the `Report: PASS` / `Report: FAIL` line. It exits 1 only if the run stops early.

| Status | Meaning |
| --- | --- |
| match | Same values on both funds, base premium equals the rate file |
| difference | A value differs (field `rate file` = base premium off the file) |
| missing / missing both | No card for one or both funds |
| not sold (closed), hidden on both | Pass: closed, non-channel row hidden by both |
| duplicate / unexpected | Several cards match a row / a card matches no row |
| breakdown / price / benefits not read | That part couldn't be read, so wasn't compared |

Cards pair on product code, state, membership, cover type and excess. Money compares to the cent. Not compared: extras waiting periods and limits, and future-dated prices.

## Tests

`yarn test` runs unit tests for the pure modules. The funnel driver has none; a real run is its acceptance test.
