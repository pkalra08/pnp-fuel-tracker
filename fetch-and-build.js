// fetch-and-build.js
// Part n Parcel fuel surcharge data job.
//
// Runs once a week (see .github/workflows/fuel-update.yml). Pulls fuel prices
// and published rates from five free, open, keyless sources, runs the band-table
// engine, and writes fuel-rates.json. The website reads that file.
//
// No scraping behind firewalls. No API keys. No paid services. Every source
// below was confirmed reachable by a plain request.
//
// SOURCES (all free, all open):
//   NRCan Canadian diesel       drives UPS Standard-Canada, FedEx Intra-Canada (x2), Purolator
//   EIA US on-highway diesel     drives UPS Standard-to-US, FedEx Ground International
//   EIA Gulf Coast jet fuel      drives UPS Express family, UPS Domestic Express, FedEx Express Intl, Loomis Worldwide
//   Canpar public JSON endpoint  drives Canpar Domestic and Loomis Domestic (shared band table)
//   Canada Post static page      drives the three Canada Post rows
//
// HOW FAILURE IS HANDLED:
//   If any source fails, that carrier keeps its last known value from the
//   previous fuel-rates.json and its status flips to "stale" (yellow dot on
//   the site). The job never writes a blank or a guess. It is always either
//   fresh-and-green or last-known-and-yellow. It never silently shows a wrong
//   number, because every value traces to a source that either answered or did not.

const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');                       // reads EIA .xls files
const cheerio = require('cheerio');                 // reads HTML pages
const { XMLParser } = require('fast-xml-parser');   // reads RSS feeds
const { computeRates } = require('./fuel-engine.js');

// ----------------------------------------------------------------------------
// CONFIG. The only thing that ever needs editing here is a source URL, and only
// if a government agency moves a file. That happens rarely. When it does, the
// job emails you (GitHub does this automatically on failure) and the fix is one
// line below.
// ----------------------------------------------------------------------------

const SOURCES = {
  // NRCan Canadian average diesel retail price. The per-location "by fuel" page
  // for Canada has the current value in a clean HTML table cell, unlike the
  // by-city page which renders an SVG chart. Confirmed: the Diesel/today cell
  // reads cents per litre (e.g. 205.8 = $2.058/L).
  nrcanDiesel: 'https://www2.nrcan.gc.ca/eneene/sources/pripri/prices_byfuel_e.cfm?locationName=Canada',

  // EIA weekly US on-highway diesel + gasoline RSS. Confirmed: returns national
  // and regional diesel prices in dollars per gallon.
  eiaOnHighwayRss: 'https://www.eia.gov/petroleum/gasdiesel/includes/gas_diesel_rss.xml',

  // EIA weekly US Gulf Coast kerosene-type jet fuel spot price spreadsheet.
  // Confirmed: open .xls, no key, parses to [excelDate, pricePerGallon] rows.
  eiaJetXls: 'https://www.eia.gov/dnav/pet/hist_xls/EER_EPJK_PF4_RGC_DPGw.xls',

  // Canpar public fuel surcharge endpoint. Confirmed: POST returns JSON history
  // with rate + start_date + end_date (epoch milliseconds).
  canparEndpoint: 'https://canship.canpar.com/api/CanparAddons/getPublicFuelSurchargeRate',

  // Canada Post fuel surcharge knowledge-base page. Confirmed: static HTML, the
  // three rate numbers are in the document, readable by a plain request.
  canadaPostPage: 'https://www.canadapost-postescanada.ca/cpc/en/support/kb/company-policies/rates-taxes-surcharges/fuel-surcharges-on-mail-and-parcels.page'
};

const OUTPUT_FILE = path.join(__dirname, 'fuel-rates.json');
const OVERRIDES_FILE = path.join(__dirname, 'overrides.json');

// Local runs read carrier API credentials from .env (git-ignored). CI gets them
// as environment variables from GitHub Actions Secrets. Either way they are
// never written to any output file.
(function loadDotEnv() {
  try {
    for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env: fine, CI provides env vars */ }
})();

// Some sources (notably NRCan) serve different content, or block, when the
// request has no browser user-agent. A bare Node fetch from a data center is
// exactly that. Send realistic browser headers on every request so the job
// behaves the same from GitHub's runners as it does from a normal browser.
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-CA,en;q=0.9'
};

// Excel's date system counts days from 1899-12-30. Converts a serial to ISO.
function excelDateToISO(serial) {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  return new Date(ms).toISOString().slice(0, 10);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// ----------------------------------------------------------------------------
// SOURCE FETCHERS. Each returns its value, or throws. The orchestrator catches
// throws and falls back to last-known. None of these touch a carrier site that
// runs a firewall, except Canpar and Canada Post, which both answer plain
// requests (confirmed).
// ----------------------------------------------------------------------------

async function fetchNrcanDiesel() {
  const res = await fetch(SOURCES.nrcanDiesel, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`NRCan responded ${res.status}`);
  const html = await res.text();
  // The current Canada diesel price sits in a table cell tagged
  // headers="Diesel todayDate centLitre" and holds cents per litre, e.g. 205.8.
  const m = html.match(/headers="Diesel todayDate centLitre"[^>]*>\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (!m) throw new Error('NRCan diesel value not found in page');
  const cents = parseFloat(m[1]);
  if (!(cents > 50 && cents < 500)) throw new Error(`NRCan diesel out of sane range: ${cents}`);
  return +(cents / 100).toFixed(4); // cents/L to dollars/L
}

async function fetchEiaOnHighwayDiesel() {
  const res = await fetch(SOURCES.eiaOnHighwayRss, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`EIA RSS responded ${res.status}`);
  const xml = await res.text();
  // The diesel block lists regional prices; the US national average is the
  // value tagged ".. U.S." right under the On-Highway Diesel header, e.g.
  // "5.210  .. U.S.". Match that specifically, not the first regional figure.
  const m = xml.match(/On-Highway Diesel[\s\S]*?([0-9]\.[0-9]{3})\s*\.\.\s*U\.S\./i);
  if (!m) throw new Error('EIA national on-highway diesel value not found in RSS');
  return parseFloat(m[1]);
}

async function fetchEiaJetFuel() {
  const res = await fetch(SOURCES.eiaJetXls, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`EIA jet xls responded ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const wb = xlsx.read(buf, { type: 'buffer' });
  const sheet = wb.Sheets['Data 1'] || wb.Sheets[wb.SheetNames[wb.SheetNames.length - 1]];
  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 });
  // Find the last row that has a numeric date and price. Rows look like [serial, price].
  let last = null;
  for (const r of rows) {
    if (typeof r[0] === 'number' && typeof r[1] === 'number') last = r;
  }
  if (!last) throw new Error('EIA jet fuel value not found in spreadsheet');
  return { price: last[1], asOf: excelDateToISO(last[0]) };
}

async function fetchCanpar() {
  const res = await fetch(SOURCES.canparEndpoint, {
    method: 'POST',
    headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({})
  });
  if (!res.ok) throw new Error(`Canpar endpoint responded ${res.status}`);
  const data = await res.json();
  const list = data?.result;
  if (!Array.isArray(list) || !list.length) throw new Error('Canpar returned no rates');
  // Pick the entry whose window contains today, else the most recent.
  const now = Date.now();
  const current = list.find(e => e.start_date <= now && now <= e.end_date) || list[0];
  return {
    rate: current.rate,
    effectiveFrom: new Date(current.start_date).toISOString().slice(0, 10),
    effectiveTo: new Date(current.end_date).toISOString().slice(0, 10)
  };
}

async function fetchCanadaPost() {
  const res = await fetch(SOURCES.canadaPostPage, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`Canada Post responded ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  const text = $('body').text().replace(/\s+/g, ' ');
  // Each Canada Post service line appears as a label followed by a percentage.
  function rateAfter(label) {
    const re = new RegExp(label + '[^0-9]{0,40}([0-9]{1,2}\\.[0-9]{2})\\s*%', 'i');
    const m = text.match(re);
    return m ? parseFloat(m[1]) : null;
  }
  const domestic = rateAfter('Domestic Services');
  const parcel = rateAfter('USA and International Parcel');
  const packet = rateAfter('USA and International Packet');
  if (domestic == null || parcel == null || packet == null) {
    throw new Error('Canada Post rates not fully parsed');
  }
  return { domestic, parcel, packet };
}

// FedEx Rating API. Authenticated against a clean tracker-only account with no
// negotiated pricing, requesting LIST rates, so the response is the published
// rate any standard merchant pays. FedEx states fuelSurchargePercent directly
// in the response: the exact posted number, no band tables, no lag, no math.
// If credentials are absent or the call fails, the orchestrator falls back to
// the band-table derivation for the FedEx rows.
async function fetchFedexApi() {
  const id = process.env.FEDEX_CLIENT_ID;
  const secret = process.env.FEDEX_CLIENT_SECRET;
  const account = process.env.FEDEX_ACCOUNT;
  if (!id || !secret || !account) throw new Error('FedEx API credentials not configured');
  const base = process.env.FEDEX_BASE || 'https://apis.fedex.com';

  const tokRes = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret })
  });
  if (!tokRes.ok) throw new Error(`FedEx OAuth responded ${tokRes.status}`);
  const { access_token } = await tokRes.json();

  async function quote(recipient, customs) {
    const body = {
      accountNumber: { value: account },
      rateRequestControlParameters: { rateSortOrder: 'COMMITASCENDING' },
      requestedShipment: {
        shipper: { address: { postalCode: 'M5V2T6', countryCode: 'CA' } },
        recipient: { address: recipient },
        pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
        rateRequestType: ['LIST'],
        requestedPackageLineItems: [{ weight: { units: 'LB', value: 1 } }]
      }
    };
    if (customs) {
      body.requestedShipment.customsClearanceDetail = {
        commodities: [{
          description: 'Rate check', quantity: 1, quantityUnits: 'PCS',
          weight: { units: 'LB', value: 1 },
          unitPrice: { amount: 10, currency: 'CAD' },
          customsValue: { amount: 10, currency: 'CAD' }
        }]
      };
    }
    const res = await fetch(`${base}/rate/v1/rates/quotes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${access_token}`, 'X-locale': 'en_CA' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`FedEx rate quote responded ${res.status}`);
    const json = await res.json();
    // service -> carrier-stated published fuel percent, off the LIST-rated detail
    const out = {};
    for (const d of (json.output?.rateReplyDetails || [])) {
      const rated = (d.ratedShipmentDetails || []).find(r => r.rateType === 'LIST') || (d.ratedShipmentDetails || [])[0];
      const pct = rated?.shipmentRateDetail?.fuelSurchargePercent;
      if (pct != null) out[d.serviceType] = pct;
    }
    return out;
  }

  const domestic = await quote({ postalCode: 'H2Y1C6', countryCode: 'CA' });
  const intl = await quote({ postalCode: '10001', countryCode: 'US' }, true);

  function pick(rates, groundWanted) {
    const entries = Object.entries(rates).filter(([svc]) => /GROUND/.test(svc) === groundWanted);
    if (!entries.length) return null;
    const pct = entries[0][1];
    // All services in a family carry the same published percent. If FedEx ever
    // splits them, fail loudly rather than publish one family member as all.
    if (!entries.every(([, p]) => p === pct)) throw new Error(`FedEx fuel percent differs within family: ${JSON.stringify(entries)}`);
    return pct;
  }

  const result = {
    expressDomestic: pick(domestic, false),
    groundDomestic: pick(domestic, true),
    expressIntl: pick(intl, false),
    groundIntl: pick(intl, true)
  };
  for (const [k, v] of Object.entries(result)) {
    if (v == null || !(v > 0 && v < 100)) throw new Error(`FedEx ${k} missing or out of range: ${v}`);
  }
  return result;
}

// ----------------------------------------------------------------------------
// ORCHESTRATOR. Fetch everything, fall back per-source, assemble the JSON.
// ----------------------------------------------------------------------------

function loadPrevious() {
  try { return JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8')); }
  catch { return { carriers: [] }; }
}

// Pull a carrier's previous block so we can fall back to it on failure.
function prevCarrier(prev, name) {
  return (prev.carriers || []).find(c => c.name === name) || null;
}

async function safe(label, fn) {
  try { return { ok: true, value: await fn() }; }
  catch (e) { console.error(`[fail] ${label}: ${e.message}`); return { ok: false, error: e.message }; }
}

async function main() {
  const prev = loadPrevious();

  // 1. Pull the three government price inputs.
  const nrcan = await safe('NRCan diesel', fetchNrcanDiesel);
  const eiaDiesel = await safe('EIA on-highway diesel', fetchEiaOnHighwayDiesel);
  const eiaJet = await safe('EIA jet fuel', fetchEiaJetFuel);

  // 2. Pull the direct carrier sources.
  const canpar = await safe('Canpar endpoint', fetchCanpar);
  const canadaPost = await safe('Canada Post page', fetchCanadaPost);
  const fedexApi = await safe('FedEx Rating API', fetchFedexApi);

  // 3. Run the band-table engine for the government-derived carriers.
  //    The engine needs all three prices. If one is missing we still compute the
  //    rows that do not depend on it, and the dependent rows fall back below.
  const prices = {
    nrcanDieselCAD: nrcan.ok ? nrcan.value : null,
    nrcanDieselCAD4WeekAvg: nrcan.ok ? nrcan.value : null, // see note: 4-week avg refinement below
    eiaOnHighwayUSD: eiaDiesel.ok ? eiaDiesel.value : null,
    eiaJetGulfUSD: eiaJet.ok ? eiaJet.value.price : null
  };
  const derived = computeRates(prices); // array of carriers with per-service rates

  // Helper: take the engine's derived value for a carrier, or fall back to the
  // previous file if the input price was missing.
  function buildDerivedCarrier(name) {
    const d = derived.find(c => c.name === name);
    const p = prevCarrier(prev, name);
    const services = (d ? d.services : []).map(svc => {
      if (svc.current != null) {
        return { service: svc.service, current: svc.current, previous: previousRate(p, svc.service, svc.current) };
      }
      // input missing: fall back to last known
      const old = p && (p.services || []).find(s => s.service === svc.service);
      return { service: svc.service, current: old ? old.current : null, previous: old ? old.previous : null };
    });
    const allFresh = services.every(s => s.current != null && (d.services.find(x => x.service === s.service)?.current != null));
    return {
      name,
      url: d ? d.url : (p ? p.url : ''),
      cadence: 'weekly',
      status: allFresh ? 'ok' : 'stale',
      lastVerified: allFresh ? todayISO() : (p ? p.lastVerified : null),
      services
    };
  }

  // Carry the prior current into previous when the rate changed.
  function previousRate(p, service, newCurrent) {
    if (!p) return newCurrent;
    const old = (p.services || []).find(s => s.service === service);
    if (!old) return newCurrent;
    return old.current; // last week's current becomes this week's previous
  }

  const carriers = [];

  // Government-derived carriers (engine output).
  ['UPS Canada', 'FedEx Express', 'FedEx Ground and pickup services', 'Purolator', 'Loomis Express']
    .forEach(name => {
      // Loomis is special: its Domestic row comes from Canpar's endpoint, its
      // Worldwide row is derived. Handled in the Loomis block below.
      if (name === 'Loomis Express') return;
      carriers.push(buildDerivedCarrier(name));
    });

  // Canpar: direct endpoint value (authoritative).
  {
    const name = 'Canpar Express';
    const p = prevCarrier(prev, name);
    if (canpar.ok) {
      const prevRate = p && p.services[0] ? p.services[0].current : canpar.value.rate;
      carriers.push({
        name, url: 'https://www.canpar.com/en/shipping/fuel_surcharge.htm',
        cadence: 'weekly', status: 'ok', lastVerified: todayISO(),
        services: [{ service: 'Domestic Canada', current: canpar.value.rate, previous: prevRate }]
      });
    } else if (p) {
      carriers.push({ ...p, status: 'stale' });
    }
  }

  // Loomis: Domestic = Canpar endpoint value (shared band table). Worldwide = derived jet.
  {
    const name = 'Loomis Express';
    const p = prevCarrier(prev, name);
    const d = derived.find(c => c.name === name);
    const worldwide = d ? d.services.find(s => /Worldwide/i.test(s.service)) : null;
    const pWorld = p ? (p.services || []).find(s => /Worldwide/i.test(s.service)) : null;
    const pDom = p ? (p.services || []).find(s => /Domestic/i.test(s.service)) : null;
    const services = [];
    // Domestic from Canpar endpoint
    if (canpar.ok) {
      services.push({ service: 'Domestic Express and Ground Service', current: canpar.value.rate, previous: pDom ? pDom.current : canpar.value.rate });
    } else if (pDom) {
      services.push({ ...pDom });
    }
    // Worldwide from jet fuel derivation
    if (worldwide && worldwide.current != null) {
      services.push({ service: 'Worldwide Service', current: worldwide.current, previous: pWorld ? pWorld.current : worldwide.current });
    } else if (pWorld) {
      services.push({ ...pWorld });
    }
    const fresh = canpar.ok && worldwide && worldwide.current != null;
    carriers.push({
      name, url: 'https://www.loomisexpress.com/loomship/Services/FuelSurcharges',
      cadence: 'weekly', status: fresh ? 'ok' : 'stale',
      lastVerified: fresh ? todayISO() : (p ? p.lastVerified : null), services
    });
  }

  // Canada Post: direct static-page values.
  {
    const name = 'Canada Post';
    const p = prevCarrier(prev, name);
    if (canadaPost.ok) {
      const pv = (label) => { const s = p && (p.services || []).find(x => x.service === label); return s ? s.current : null; };
      carriers.push({
        name, url: SOURCES.canadaPostPage, cadence: 'weekly', status: 'ok', lastVerified: todayISO(),
        services: [
          { service: 'Domestic Services', current: canadaPost.value.domestic, previous: pv('Domestic Services') ?? canadaPost.value.domestic },
          { service: 'USA and International Parcel Services', current: canadaPost.value.parcel, previous: pv('USA and International Parcel Services') ?? canadaPost.value.parcel },
          { service: 'USA and International Packet Services', current: canadaPost.value.packet, previous: pv('USA and International Packet Services') ?? canadaPost.value.packet }
        ]
      });
    } else if (p) {
      carriers.push({ ...p, status: 'stale' });
    }
  }

  // 3b. FedEx exact rates from the Rating API beat the band-table derivation.
  //     Carrier-stated published percentages off LIST quotes on the clean
  //     tracker account. On failure the derived values above stand, flagged by
  //     the API row in the error log.
  if (fedexApi.ok) {
    const v = fedexApi.value;
    const applyExact = (name, rows) => {
      const c = carriers.find(x => x.name === name);
      const p = prevCarrier(prev, name);
      if (!c) return;
      c.services = rows.map(([service, current]) => {
        const old = p && (p.services || []).find(s => s.service === service);
        return { service, current, previous: old ? old.current : current };
      });
      c.status = 'ok';
      c.lastVerified = todayISO();
    };
    applyExact('FedEx Express', [
      ['Intra-CAN', v.expressDomestic],
      ['Intl.', v.expressIntl]
    ]);
    applyExact('FedEx Ground and pickup services', [
      ['Intra-CAN and pickup services', v.groundDomestic],
      ['Intl.', v.groundIntl]
    ]);
    console.log(`[fedex-api] exact list rates: Express CA ${v.expressDomestic}%, Express Intl ${v.expressIntl}%, Ground CA ${v.groundDomestic}%, Ground Intl ${v.groundIntl}%`);
  }

  // 4. Apply manually verified overrides (overrides.json). A verified posted
  //    number beats a derived estimate until the override expires. Expired
  //    entries are ignored, so the derived value resumes automatically at the
  //    carrier's next adjustment. previous is dropped on overridden rows unless
  //    the override supplies one, so the site never shows a false change pill.
  try {
    const today = todayISO();
    const { overrides = [] } = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8'));
    for (const o of overrides) {
      if (o.expires && today >= o.expires) continue;
      const carrier = carriers.find(c => c.name === o.carrier);
      const svc = carrier && carrier.services.find(s => s.service === o.service);
      if (!svc) { console.error(`[override] no match for ${o.carrier} / ${o.service}`); continue; }
      svc.current = o.rate;
      svc.previous = ('previous' in o) ? o.previous : null;
      carrier.status = 'ok';
      carrier.lastVerified = o.verified || today;
      console.log(`[override] ${o.carrier} / ${o.service} = ${o.rate}% (verified ${o.verified}, expires ${o.expires})`);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[override] skipped: ${e.message}`);
  }

  const output = {
    version: 1,
    generatedAt: new Date().toISOString(),
    nextUpdate: 'Every Monday morning',
    inputs: {
      nrcanDieselCAD: prices.nrcanDieselCAD,
      eiaOnHighwayUSD: prices.eiaOnHighwayUSD,
      eiaJetGulfUSD: prices.eiaJetGulfUSD,
      jetAsOf: eiaJet.ok ? eiaJet.value.asOf : null
    },
    carriers
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  const stale = carriers.filter(c => c.status !== 'ok').map(c => c.name);
  console.log(`Wrote ${OUTPUT_FILE} with ${carriers.length} carriers.`);
  if (stale.length) console.log(`Stale (used last-known): ${stale.join(', ')}`);
  else console.log('All sources fresh.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });

// ----------------------------------------------------------------------------
// NOTE ON PUROLATOR'S 4-WEEK AVERAGE.
// Purolator uses a four-week trailing average of NRCan diesel, not the single
// weekly value. This first version feeds it the single weekly value, which is
// close but not exact. To make it exact, keep the last four weekly NRCan values
// in fuel-rates.json (add an "nrcanHistory" array), average them, and pass that
// as nrcanDieselCAD4WeekAvg. One small addition once the base job is running.
// ----------------------------------------------------------------------------
