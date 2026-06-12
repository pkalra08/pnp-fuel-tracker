// Proves the UPS published-rate approach: authenticate with the clean tracker
// account, request rates WITHOUT the negotiated-rates indicator, so UPS returns
// published rates. Fuel surcharge arrives as an itemized charge (code 375).
//
// Run: node test-ups-rate.js
// Reads UPS_CLIENT_ID, UPS_CLIENT_SECRET, UPS_ACCOUNT from .env. Never prints them.

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

const ID = process.env.UPS_CLIENT_ID;
const SECRET = process.env.UPS_CLIENT_SECRET;
const ACCOUNT = process.env.UPS_ACCOUNT;
const BASE = process.env.UPS_BASE || 'https://onlinetools.ups.com';

if (!ID || !SECRET || !ACCOUNT) {
  console.error('Missing UPS_CLIENT_ID, UPS_CLIENT_SECRET, or UPS_ACCOUNT in .env');
  process.exit(1);
}

async function token() {
  const res = await fetch(`${BASE}/security/v1/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${ID}:${SECRET}`).toString('base64'),
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  if (!res.ok) throw new Error(`UPS OAuth failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

// Shop = quote every available service in one call. No NegotiatedRatesIndicator,
// so the response is published rates.
async function shop(bearer, recipient) {
  const body = {
    RateRequest: {
      Request: { TransactionReference: { CustomerContext: 'PnP fuel check' } },
      Shipment: {
        Shipper: {
          ShipperNumber: ACCOUNT,
          Address: { City: 'Toronto', StateProvinceCode: 'ON', PostalCode: 'M5X1A9', CountryCode: 'CA' },
        },
        ShipTo: { Address: recipient },
        ShipFrom: {
          Address: { City: 'Toronto', StateProvinceCode: 'ON', PostalCode: 'M5X1A9', CountryCode: 'CA' },
        },
        Package: [{
          PackagingType: { Code: '02' },
          PackageWeight: { UnitOfMeasurement: { Code: 'LBS' }, Weight: '1' },
        }],
      },
    },
  };
  const res = await fetch(`${BASE}/api/rating/v2403/Shop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`UPS rate call failed: ${res.status} ${text.slice(0, 600)}`);
  return JSON.parse(text);
}

const SERVICE_NAMES = {
  '01': 'UPS Express', '02': 'UPS Expedited', '11': 'UPS Standard',
  '13': 'UPS Express Saver', '14': 'UPS Express Early', '65': 'UPS Express Saver',
  '07': 'UPS Worldwide Express', '08': 'UPS Worldwide Expedited', '12': 'UPS 3 Day Select',
};

function report(label, json) {
  const shipments = json?.RateResponse?.RatedShipment || [];
  const list = Array.isArray(shipments) ? shipments : [shipments];
  console.log(`\n${label}`);
  console.log('Service                    Base      Fuel    Fuel % (fuel/base)');
  console.log('------------------------------------------------------------------');
  for (const s of list) {
    const code = s.Service?.Code;
    const name = (SERVICE_NAMES[code] || `Service ${code}`).padEnd(26);
    const baseCharge = parseFloat(s.BaseServiceCharge?.MonetaryValue ?? 'NaN');
    const itemized = s.ItemizedCharges ? (Array.isArray(s.ItemizedCharges) ? s.ItemizedCharges : [s.ItemizedCharges]) : [];
    const fuelItem = itemized.find(c => c.Code === '375' || /fuel/i.test(c.Description || ''));
    const fuel = fuelItem ? parseFloat(fuelItem.MonetaryValue) : null;
    const transport = parseFloat(s.TransportationCharges?.MonetaryValue ?? 'NaN');
    // Preferred: fuel / base from itemized charges. Fallback shown if itemized
    // charges are absent so we can see what the response actually carries.
    let pct = 'n/a';
    if (fuel != null && baseCharge) pct = ((fuel / baseCharge) * 100).toFixed(2) + '%';
    else if (fuel != null && transport && transport > fuel) pct = ((fuel / (transport - fuel)) * 100).toFixed(2) + '% (vs transport-fuel)';
    console.log(`${name} ${String(isNaN(baseCharge) ? transport : baseCharge).padStart(8)} ${String(fuel ?? 'none').padStart(8)}   ${pct}`);
    if (!itemized.length) console.log('   (no ItemizedCharges in response; raw keys: ' + Object.keys(s).join(',') + ')');
  }
}

(async () => {
  try {
    const bearer = await token();
    console.log(`Authenticated against ${BASE}. Requesting published rates...`);
    report('Toronto -> Montreal (domestic)', await shop(bearer, { City: 'Montreal', StateProvinceCode: 'QC', PostalCode: 'H2Y1C6', CountryCode: 'CA' }));
    report('Toronto -> New York (cross-border)', await shop(bearer, { City: 'New York', StateProvinceCode: 'NY', PostalCode: '10001', CountryCode: 'US' }));
    console.log('\nCompare Standard-within-Canada and Domestic Express against the posted UPS page before trusting.');
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
})();
