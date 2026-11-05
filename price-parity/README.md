# Price parity test

Drives the agent-view comparator funnel in a real browser and checks that two funds loaded from the same rate file show customers the same prices and benefits.

- **Expected fund:** loaded with the existing rate file import (CPS locally, Phoenix in dev).
- **Actual fund:** loaded with the Snowflake sync (itsmy locally, Phoenix Snowflake Sync in dev).

The rate file is the checklist. Every price row in it must show up on screen for both funds, with the same values.

Moved here from `comparator-need-analysis-3` (IS-701) so it can be run without access to the app repo. It only drives a running comparator through the browser; it uses no app code.

## Setting up on your machine

You need read access to `Itsmy-Group/data_team_poc_misc`, nothing else from ItsMy's code. A dev run drives the deployed dev slot, so you don't run the comparator yourself.

**1. Install Node 22 or later and Yarn 1.** Check with `node -v` and `yarn -v`. If Yarn is missing:

```bash
npm install -g yarn
```

**2. Clone the repo and install.** Every later command runs from the `price-parity` folder.

```bash
git clone git@github.com:Itsmy-Group/data_team_poc_misc.git
cd data_team_poc_misc/price-parity
yarn install
```

`yarn install` also downloads the Chrome that Puppeteer drives. Packages come from the public registry, pinned in `.yarnrc`, so no CodeArtifact login is needed.

**3. Check the install.** All tests should pass:

```bash
yarn test
```

**4. Add the three gitignored pieces.** None of them are in git, because they hold lead ids, customer prices or passwords. Ask whoever runs the tool today to send them privately (not in a shared channel):

| What | Where it goes | Holds |
| --- | --- | --- |
| Configs, e.g. `dev.json`, `dev-inc-a.json` | `config/` | Comparator address, Zoho lead id, funds, which rate files to check. See [Config](#config) |
| Rate files (`.xlsx`) | `rate-files/` | The prices to check. Each config lists the ones it needs |
| Basic-auth login for the dev slot | `.env.local` in this folder | `PRICE_PARITY_AUTH_USER` / `PRICE_PARITY_AUTH_PASSWORD`, plus `PRICE_PARITY_EXPECTED_AUTH_*` and `PRICE_PARITY_ACTUAL_AUTH_*` for [two-environment runs](#comparing-two-environments) |

`.env.local` looks like this:

```
PRICE_PARITY_AUTH_USER='<user>'
PRICE_PARITY_AUTH_PASSWORD='<password>'
```

**5. Try one search.** A visible Chrome opens, walks the funnel once and writes a report under `output/`:

```bash
yarn price-parity --config dev --search VIC/single/hospital
```

The last line says `Report: PASS` or `Report: FAIL`. A setup problem (no config, missing rate file, wrong login, lead not loading) stops it straight away with a message. Once one search works, run the full sweep with `yarn price-parity --config dev`. It takes about 1.5 hours. On a Mac the run keeps the machine awake itself (it starts `caffeinate` until the run ends), but closing the lid on battery still sleeps it, so leave the lid open or plug in.

## Running against a local comparator

Only for a `local` config. Both apps must be running:

- **comparator-legacy** (Django) on `http://127.0.0.1:8000`.
- **comparator-need-analysis-3** on `http://localhost:3000`, in agent view. In `.env`:

  ```
  VIEW_TYPE="agent"
  CORPORATE_ID=1
  ITSMY_API_URL=http://127.0.0.1:8000/api
  PACKAGE_SEARCH_ULTATE_ENDPOINT=""
  USE_OKTA_AUTHENTICATION=false
  ```

  A blank `PACKAGE_SEARCH_ULTATE_ENDPOINT` sends searches to local Django instead of the Rust search service.

In the Django admin:

- The corporate lists both test funds in its available funds, and both funds' prices carry the distribution flags that corporate needs. The script stops if a fund is missing from the fund filter.
- The lead in config exists. The script stops if the lead's date of birth doesn't load.
- Each fund's prices are current on the run date. If a fund's rate file window has ended, the funnel shows its future price instead, and every row differs.

Put the rate files in `rate-files/` (gitignored, along with `output/`).

## Config

Configs live in `config/<name>.json`. `local` is the default. It is gitignored, so start one from the example:

```bash
cp config/local.example.json config/local.json
```

| Field | What it is |
| --- | --- |
| `baseUrl` | The comparator-3 address. Leave it out in [two-environment mode](#comparing-two-environments) |
| `leadId` | The Zoho lead (opportunity) id to open. Leave it out in two-environment mode |
| `expectedFund`, `actualFund` | `{ "code": "cps", "name": "see-u by HBF" }`. The name is what the fund filter and the cards show. In two-environment mode each also has its own `baseUrl` and `leadId` |
| `rateFiles` | Rate files in the order they were loaded, relative to the config folder |
| `priceDate` | Optional, default today. Per key, the row available that day that started latest is checked |
| `profile` | The full sweep's customer: `age`, `rebateTier` (`none`, `base`, `tier1`–`tier3`), `lhcAge` (`null` for no loading) |
| `variationFile` | Optional. Extra searches × profiles that check the rebate and LHC maths |
| `headless` | Optional, default `false` (a visible browser) |
| `slowMo` | Optional, default `0`. Milliseconds added before every browser action in a visible browser, e.g. `250` for filming |
| `screenshots` | Optional. `issues` (default) or `all` |
| `searches` | Optional. Narrows the run, e.g. `["VIC/single/hospital"]` |
| `expectedNameDifferences` | Optional. Name pairs that differ on purpose, as `[{ "expected": "<expected fund's name>", "actual": "<actual fund's name>" }]`, the names exactly as the cards show them (the rate file's Price Name). Add `"code": "S3P-V"` to limit an entry to one product. A listed pair doesn't fail the row; any other name difference does |

No credentials go in config. Keep real lead ids in `local.json` or `dev.json`, which stay out of git.

A deployed slot (e.g. `https://poom-slot-1.itsmydev.com.au`) asks for a basic-auth login, which the script can't type into. Put the login in this folder's `.env.local` (or `.env`), both gitignored:

```
PRICE_PARITY_AUTH_USER='<user>'
PRICE_PARITY_AUTH_PASSWORD='<password>'
```

The script reads `.env.local` first, then `.env`. A variable already exported in your shell wins over both.

## Running it

```bash
yarn price-parity --config dev
```


## Running to test dev instance
```bash
yarn price-parity --config dev --slow-mo 200
```

Runs the full sweep (one search per state × membership type × cover type in the rate file), then the variation set. Locally that is 84 + 36 searches and takes about 1.5 hours.

| Option | What it does |
| --- | --- |
| `--config dev` | Uses `config/dev.json` |
| `--lead <id>` | Uses another lead, e.g. when one expires. Refused in two-environment mode |
| `--expected-lead <id>`, `--actual-lead <id>` | Two-environment mode only: replaces one side's lead |
| `--headless` | No visible browser, for unattended runs |
| `--slow-mo 250` | Waits 250 ms before every click, keypress and page action so a recording can follow it. A run takes much longer |
| `--screenshots all` | A whole-page screenshot for every search, not only failing and sample-pass ones |
| `--search VIC/single/hospital` | Runs only that search. Repeatable |
| `--set full-sweep` or `--set variations` | Runs one set on its own |
| `--rerun output/local-20261019-143012` | Runs only the searches that errored or had a row that didn't match in that run, and writes their new results back into that run's folder, so its report shows every search with its latest result. Takes the run folder or its `results.json`, and uses that run's config unless `--config` is given. If a re-run stops part way, `--rerun` the same folder again |
| `--resume output/local-20261020-111137` | Carries on a run that stopped part way (e.g. the network dropped). Keeps the searches it finished, runs the errored and unreached ones, and writes into the same folder, so there is one combined `results.json` and report. Uses that run's lead, rate files, price date, sets and searches unless the command line overrides them. In two-environment mode, `--resume` and `--rerun` both keep each side's `baseUrl` and lead from that run |
| `--rate-file <path>`, `--price-date <YYYY-MM-DD>` | Overrides the config |
| `--keep-open` | Leaves a visible browser on the last search |
| `--report-only output/local-20261019-143012` | Writes a fresh `report-<time>.xlsx` and `summary-<time>.html` from that run's `results.json`, without the browser |

A search that fails is retried once in a fresh tab, then recorded as an error, and the run carries on. If Chrome itself crashes or its window is closed (`Connection closed.`), a new browser is opened for that side, for the retry and every later search. A setup problem (an app not reachable, the lead not loading, a fund missing from the filter) stops the run with a message.

## Testing a price increase

List the full load and its increments in `rateFiles`, in the order they were loaded, and set `priceDate` inside the increment's window:

```json
"rateFiles": ["../rate-files/itsmy_FullLoad.xlsx", "../rate-files/itsmy_RR26_INC_A_price_adjustment.xlsx"],
"priceDate": "2026-10-23"
```

Each product is checked against its latest-starting price on that date, so the increment's rows are checked at their new price and the rest at the full load price. The start-up line says how many rows come from each file, e.g. `672 from itsmy_FullLoad.xlsx, 84 from itsmy_RR26_INC_A_price_adjustment.xlsx (84 moved)`.

Each row's **previous premium** is the price it took over from: the same product's latest earlier-starting price, from an earlier file on a tie. Its **movement**:

| Movement | Meaning |
| --- | --- |
| increase / decrease | Changed by more than 1 ¢ |
| rounding | Changed by 1 ¢. Listed apart, as the test plan needs a named sign-off for these |
| unchanged | Same price as before |
| new product | In a later file with no earlier price |
| not in increment | From the first file, nothing before it |

Movement describes the run; it doesn't pass or fail a row. A row still passes only when both cards show the file's premium.

## Comparing two environments

Use this when the two funds sit on different comparators, e.g. Phoenix on **prod** (expected) against `phoenix test` on **dev** (actual). Give each fund its own `baseUrl` and `leadId`, and leave the top-level ones out:

```json
{
  "expectedFund": { "code": "pho", "name": "Phoenix Health Fund", "baseUrl": "http://localhost:3001", "leadId": "<prod-lead-id>" },
  "actualFund": { "code": "<phoenix-test-code>", "name": "Phoenix Test", "baseUrl": "http://localhost:3000", "leadId": "<dev-lead-id>" },
  "rateFiles": ["../rate-files/phoenix_prod_FullLoad.xlsx"],
  "variationFile": "../scenarios/variations.json",
  "profile": { "age": 40, "rebateTier": "base", "lhcAge": null }
}
```

Use the codes and names each environment's fund filter shows. Either both funds have a `baseUrl` or neither does. A config with only one, or with a top-level `baseUrl` or `leadId` as well, is refused.

What changes in this mode:

- Each side gets its own browser, opened on its own lead and filtered to its own fund. Every search runs on both sides at once, so a search takes as long as the slower side and the two are read together. With `headless` off the two windows open slightly offset.
- Any card from another fund on a tab counts as unexpected, since each tab is filtered to one fund.
- A failed search closes **both** tabs and retries both. Errors name the side, e.g. `localhost:3001 (expected): Lead 123 did not load into the needs analysis form`, and the Errors sheet shows it.
- Card screenshots come from the tab the card was read on. Whole-page screenshots are taken of both tabs and labelled with the fund and environment.
- The report's run details show both environments and both leads.

Everything else (the comparison, rate files, scenarios, reports, `--rerun`, `--resume`, `--report-only`) works as usual.

### Two comparator-3 instances

comparator-3 reads its backend from env at startup, so each environment needs its own instance:

| Instance | Port | `ITSMY_API_URL` | `ITSMY_API_KEY` | `ITSMY_ENVIRONMENT` |
| --- | --- | --- | --- | --- |
| dev | 3000 | `https://dev.itsmy.com.au/api` | not used | `local` |
| prod | 3001 | prod API (through Kong) | prod key | `staging` |

- **Dev:** `local` sends API paths unchanged, and dev Django answers directly with no Kong key.
- **Prod:** needs the Kong path mappings, which only apply when `ITSMY_ENVIRONMENT` isn't `local` and an API key is set. Don't use `production`: the product name renders as a dropdown button there, and the card reader may not read it.
- **Both:** `VIEW_TYPE="agent"`, a `CORPORATE_ID` whose corporate lists the fund, `PACKAGE_SEARCH_ULTATE_ENDPOINT` set the way that environment searches, `USE_OKTA_AUTHENTICATION=false`, and `ITSMY_MEDIA_HOST` matching the API host.

Running the second instance: copy the repo to a second folder (`git worktree add ../comparator-prod` works), put the prod values in that copy's `.env.local`, then start it on port 3001:

```bash
yarn dev -p 3001
```

Deployed slots work too. If both sides need a basic-auth login, put one per side in `.env.local`. A side without its own login falls back to `PRICE_PARITY_AUTH_*`:

```
PRICE_PARITY_EXPECTED_AUTH_USER='<user>'
PRICE_PARITY_EXPECTED_AUTH_PASSWORD='<password>'
PRICE_PARITY_ACTUAL_AUTH_USER='<user>'
PRICE_PARITY_ACTUAL_AUTH_PASSWORD='<password>'
```

### Prod safety

- **One lead for the whole run.** Use one agent-view lead agreed with the CRM owner. The script never creates leads.
- **Off-hours only.** Each search costs prod Django about 13 seconds. Never run during a rate-rise load window.
- **Record prod's latest price load job id for the fund before and after the run.** If it changed, re-run the searches it affects.
- **Smoke first.** Run 2–3 searches with `--search` before the full sweep, so a data mismatch shows in minutes, not hours. The **Missing** sheet is where a load problem shows first.
- **Read-only.** The script only fills the needs-analysis form, opens the comparison, filters funds and reads cards. It never clicks save-quote, application or any other button that writes. Check `selectors` in `src/funnelDriver.js` before the first prod run.
- **Prod date window.** If the fund's prod prices have expired on the run date, prod shows its future price and every row differs. Check before running.

## Reading the report

The command exits 0 whenever a run finishes and writes its report, so a FAIL report still ends in yarn's `Done`; the `Report: PASS` or `Report: FAIL` line gives the result. It exits 1 only when the run stops early or no report could be written.

Each run gets its own folder, `output/<config>-<timestamp>/`. The report files carry the time they were generated (e.g. `report-20261020-093707.xlsx`), so two workbooks open in Excel side by side and a `--report-only` rebuild never overwrites an earlier one:

- `summary-<time>.html`: open this first. It has:
  - PASS or FAIL and a one-line verdict
  - the headline counts
  - **What was checked**: one line per field (product name, price, base premium, rebate, LHC, discounts, hospital items, extras benefits) with how many rows were the same or differed
  - a coverage grid of every state × membership type × cover type
  - the differences, missing rows, errors, screenshot thumbnails and run details

  **Print or save as PDF** gives an A4 landscape copy to share.
- `report-<time>.xlsx`, with these sheets:
  - **Summary**: the same cover page.
  - **All rows**: one line per rate file row, with every field for both funds side by side and a ✓ or ✗ per field. Benefit items show as a count, e.g. "40/40 same".
  - **Benefits**: each product's hospital and extras items for both funds, one line per item.
  - **Differences**, **Missing**, **Unexpected** and **Errors**: the detail behind a FAIL.
  - **Expected differences**: each listed product rename, with how many rows showed it. A rename marked "Not seen in this run" is on the list but no card showed it, so check the list.
  - **Price movement** (only when an increment is loaded): one line per product and movement, with the change in $ and %, and how many of those rows matched on both funds. **All rows** and **Variation rows** also get Previous premium, Change, Change %, Movement and Source file, and the Summary sheet and HTML page get the counts per movement.
  - **Variation differences** and **Variation rows**: the variation set, kept apart.
  - **Evidence**: thumbnails in four groups (failing cards, failed searches, sample passes, whole pages), each with a label and a link to the full-size file. **Whole pages** has the full comparison page for each failing search (up to 20 embedded) and for each sample pass (up to 8, spread over membership and cover types).
- `screenshots/`: the evidence, linked from the report:
  - **Failing:** both funds' cards for each row that differs, is missing or is unexpected, with the price breakdown open, each followed by that card's **selected items** (its Selected Hospital Item(s) and Selected Extras Item(s) column from the detailed view, one per product since items don't change with the excess). Up to 100 are shown in the report; the rest are only linked.
  - **Failed searches:** the whole page.
  - **Sample passes:** one matching pair of cards, with their selected items, from up to 6 full sweep searches and 2 variation searches, each a different membership and cover type.
  - **Whole pages:** the full comparison page for every failing search and every sample-pass search. `--screenshots all` adds one for every other search too; those extras are linked from results.json but not embedded.
- `results.json`: everything the run found. `--rerun` and `--report-only` read it.

A run passes only when nothing is off: no differences, missing rows, duplicates, unexpected cards, unread prices, breakdowns or benefits, or errored searches, and the run finished.

What each row status means:

| Status | Meaning |
| --- | --- |
| match | Both funds show the same values, and each base premium equals the rate file's gross premium |
| difference | Both funds show the row, but a value differs. The Differences sheet names the field, both values and the delta. Field `rate file` means a base premium is off the file, even if both funds agree |
| missing (one fund) | The rate file row has no card for that fund |
| missing both | Neither fund shows the row |
| not sold (closed), hidden on both | A **pass**. Neither fund shows the row, and the rate file marks it `Product Status` closed with `Fund Channel` false. comparator-legacy never shows a closed price to a new customer, so hiding it is correct. If either fund does show it, the row is reported as missing for the other fund instead |
| duplicate | More than one card matches the row |
| unexpected | A card matches no rate file row |
| breakdown not read | The prices match, but a card's price breakdown (base premium, rebate, LHC, discounts) never opened on hover, even on a second try, so those fields weren't compared. Listed on the **Missing** sheet; `--rerun` checks it again |
| price not read | Neither card shows a price the script could read |
| benefits not read | A card's hospital or extras items weren't found in the detailed view, so they weren't compared |

Cards are paired by fund product code, state, membership type, cover type and excess, so a renamed product still pairs. The product name is then compared like any other field (ignoring extra spaces), unless the rename is listed in `expectedNameDifferences`. Money is compared to the cent.

A rate file cell the script can't read (a premium, excess or date) stops the run with the file and row number. Products with no price on the price date are listed at the start and not checked; a card shown for one counts as unexpected.

Not compared: extras waiting periods and limits, which only render while a benefit row is expanded, and future-dated prices.

## Tests

```bash
yarn test
```

The pure modules (rate file, scenarios, comparator, card reader, report data, reporter, run results, config) have unit tests. The funnel driver has none; the CPS vs itsmy run is its acceptance test.
