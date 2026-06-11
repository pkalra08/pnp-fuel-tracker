// Proves the list-rate approach: authenticate with PnP's FedEx account,
// but request LIST (published) rates so the fuel surcharge returned is the
// rate a standard merchant pays — not PnP's negotiated discount.
//
// Run: node test-fedex-rate.js
// Reads credentials from .env. Never prints the secret.

const fs = require('fs');
const path = require('path');

// --- tiny .env loader (no dependency) ---
function loadEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();

const ID = process.env.FEDEX_CLIENT_ID;
const SECRET = process.env.FEDEX_CLIENT_SECRET;
const ACCOUNT = process.env.FEDEX_ACCOUNT;
const BASE = process.env.FEDEX_BASE || 'https://apis.fedex.com';

if (!ID || !SECRET || !ACCOUNT) {
  console.error('Missing FEDEX_CLIENT_ID, FEDEX_CLIENT_SECRET, or FEDEX_ACCOUNT in .env');
  process.exit(1);
}

async function token() {
  const res = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: ID,
      client_secret: SECRET,
    }),
  });
  if (!res.ok) throw new Error(`OAuth failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function quote(bearer) {
  const body = {
    accountNumber: { value: ACCOUNT },
    rateRequestControlParameters: { rateSortOrder: 'COMMITASCENDING' },
    requestedShipment: {
      shipper: { address: { postalCode: 'M5V2T6', countryCode: 'CA' } },      // Toronto
      recipient: { address: { postalCode: 'H2Y1C6', countryCode: 'CA' } },     // Montreal
      pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
      rateRequestType: ['LIST'],                                               // <-- published rates, not negotiated
      requestedPackageLineItems: [
        { weight: { units: 'LB', value: 1 } },
      ],
    },
  };
  const res = await fetch(`${BASE}/rate/v1/rates/quotes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${bearer}`,
      'X-locale': 'en_CA',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Rate call failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function report(json) {
  const details = json?.output?.rateReplyDetails || [];
  if (!details.length) {
    console.log('No rate details returned. Raw output:');
    console.log(JSON.stringify(json, null, 2).slice(0, 2000));
    return;
  }
  console.log('Service                          Base       Fuel    Fuel % (carrier-stated)');
  console.log('--------------------------------------------------------------------------');
  for (const d of details) {
    const rated = (d.ratedShipmentDetails || []).find(r => r.rateType === 'LIST')
      || (d.ratedShipmentDetails || [])[0];
    const srd = rated?.shipmentRateDetail || {};
    const base = rated?.totalBaseCharge;
    const fuel = (srd.surCharges || []).find(s => s.type === 'FUEL');
    const fuelAmt = fuel ? fuel.amount : null;
    // FedEx states the published percentage directly: no ratio math needed.
    const pct = srd.fuelSurchargePercent != null ? srd.fuelSurchargePercent + '%' : 'n/a';
    const name = (d.serviceName || d.serviceType || '').slice(0, 30).padEnd(32);
    console.log(`${name} ${String(base).padStart(8)} ${String(fuelAmt).padStart(9)}   ${pct.padStart(7)} (${rated?.rateType})`);
  }
  console.log('\nfuelSurchargePercent comes straight from FedEx on a LIST rate: the exact published surcharge.');
}

(async () => {
  try {
    const bearer = await token();
    console.log(`Authenticated against ${BASE}. Requesting LIST rates...\n`);
    report(await quote(bearer));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
})();
