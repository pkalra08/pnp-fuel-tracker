# PnP Fuel Tracker

The engine and weekly data job behind the Part n Parcel Canadian Fuel Surcharge Tracker.

## What is here

- `fuel-engine.js` — the rate math. Encodes each carrier's published methodology (band tables and formulas) and derives the current fuel surcharge from government and public price feeds. Pure functions, no I/O.
- `fetch-and-build.js` — the weekly job. Pulls the price feeds, runs the engine, and writes `fuel-rates.json`. Falls back to last-known values per carrier if a source fails.
- `.github/workflows/fuel-update.yml` — runs the job every Monday and commits the refreshed `fuel-rates.json`.
- `fuel-tracker.html` — the embeddable widget. Reads `fuel-rates.json` and renders the table.
- `DEPLOY.md` — plain-language setup guide.

## Data sources (all free, all public)

- NRCan Canadian diesel (UPS Standard within Canada, FedEx Intra-Canada, Purolator)
- EIA US on-highway diesel (UPS Standard to US, FedEx Ground International)
- EIA US Gulf Coast jet fuel (UPS Express family, FedEx Express International, Loomis Worldwide)
- Canpar public endpoint (Canpar Domestic, Loomis Domestic)
- Canada Post published page (Canada Post services)

## Maintenance

Near zero. UPS and FedEx rates are computed from formulas and wide band tables, so they do not need routine refresh. Glance at the UPS and FedEx published pages once a quarter to confirm neither carrier has restructured its formula. If a price source ever fails, the affected row shows its last known value with a yellow indicator and the run reports the error.
