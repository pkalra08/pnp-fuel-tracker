// Tests whether ShipStation alone can power the fuel tracker.
// Answers three questions per connected carrier:
//   1. Does the rate response itemize fuel (rate_detail_type "fuel_charge")?
//   2. Do any rates come back flagged retail (negotiated_rate: false),
//      or only PnP's negotiated/discounted rates?
//   3. What fuel % does each service compute to (fuel / base)?
//
// Run: node test-shipstation-rates.js
// Reads SHIPSTATION_API_KEY from .env. Never prints the key.

const fs = require('fs');
const path = require('path');

function loadEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();

const KEY = process.env.SHIPSTATION_API_KEY;
const BASE = 'https://api.shipstation.com/v2';

if (!KEY) {
  console.error('Missing SHIPSTATION_API_KEY in .env');
  process.exit(1);
}

async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { 'api-key': KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} failed: ${res.status} ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

function money(a) {
  return a && a.amount != null ? Number(a.amount) : null;
}

(async () => {
  try {
    const { carriers = [] } = await api('GET', '/carriers');
    if (!carriers.length) {
      console.log('No carriers connected to this ShipStation account.');
      return;
    }
    console.log('Connected carriers:');
    for (const c of carriers) console.log(`  ${c.friendly_name || c.carrier_code} (${c.carrier_id})`);
    console.log('');

    const quote = await api('POST', '/rates', {
      shipment: {
        ship_from: {
          name: 'PnP Test', phone: '5555555555',
          address_line1: '100 King St W', city_locality: 'Toronto',
          state_province: 'ON', postal_code: 'M5X 1A9', country_code: 'CA',
        },
        ship_to: {
          name: 'PnP Test', phone: '5555555555',
          address_line1: '111 Rue Saint-Antoine', city_locality: 'Montreal',
          state_province: 'QC', postal_code: 'H2Y 1C6', country_code: 'CA',
        },
        packages: [{ weight: { value: 1, unit: 'pound' } }],
      },
      rate_options: { carrier_ids: carriers.map(c => c.carrier_id) },
    });

    const rates = quote?.rate_response?.rates || [];
    const errors = quote?.rate_response?.errors || [];
    if (!rates.length) {
      console.log('No rates returned. Errors:');
      console.log(JSON.stringify(errors, null, 2).slice(0, 2000));
      return;
    }

    console.log('Carrier / Service                          Base      Fuel    Fuel %   Rate type');
    console.log('---------------------------------------------------------------------------------');
    const fuelByCarrier = {};
    for (const r of rates) {
      const details = r.rate_details || [];
      const fuelLines = details.filter(d => d.rate_detail_type === 'fuel_charge');
      const fuel = fuelLines.reduce((s, d) => s + (money(d.amount) || 0), 0) || null;
      const shipLines = details.filter(d => d.rate_detail_type === 'shipping');
      const base = shipLines.length
        ? shipLines.reduce((s, d) => s + (money(d.amount) || 0), 0)
        : money(r.shipping_amount);
      const pct = (base && fuel != null) ? ((fuel / base) * 100).toFixed(2) + '%' : 'n/a';
      const type = r.negotiated_rate === false ? 'RETAIL' : (r.negotiated_rate === true ? 'negotiated' : '?');
      const name = `${r.carrier_friendly_name || r.carrier_code} / ${r.service_type || r.service_code}`.slice(0, 40).padEnd(42);
      console.log(`${name} ${String(base ?? '?').padStart(7)} ${String(fuel ?? 'none').padStart(8)} ${pct.padStart(8)}   ${type}`);
      const ck = r.carrier_friendly_name || r.carrier_code;
      fuelByCarrier[ck] = fuelByCarrier[ck] || { itemized: false, retail: false };
      if (fuel != null) fuelByCarrier[ck].itemized = true;
      if (r.negotiated_rate === false) fuelByCarrier[ck].retail = true;
    }

    console.log('\nVerdict per carrier:');
    for (const [c, v] of Object.entries(fuelByCarrier)) {
      console.log(`  ${c}: fuel itemized: ${v.itemized ? 'YES' : 'NO'} | retail rates present: ${v.retail ? 'YES' : 'NO'}`);
    }
    console.log('\nTracker needs BOTH yes. Fuel itemized + only negotiated = good for the private');
    console.log('"what you actually pay" column, but not for published list rates.');
    if (errors.length) {
      console.log('\nCarrier errors during quoting:');
      for (const e of errors) console.log(`  ${e.carrier_id || ''} ${e.message || JSON.stringify(e).slice(0, 200)}`);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
})();
