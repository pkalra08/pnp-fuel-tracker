// Identifies which carrier a pasted Key/Password/Account belongs to by testing
// both candidates: FedEx REST OAuth and Purolator E-Ship QuickEstimate.
// Prints statuses and rate results only, never the credentials.

const fs = require('fs');
const path = require('path');

const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
const key = (raw.match(/Production Key:\s*(\S+)/i) || [])[1];
const password = (raw.match(/Password:\s*(\S+)/i) || [])[1];
const account = (raw.match(/Account #:\s*(\S+)/i) || [])[1];

if (!key || !password || !account) {
  console.error('Could not find Production Key / Password / Account # lines in .env');
  process.exit(1);
}
console.log('Found key, password, and account in .env. Testing both carriers...\n');

async function tryFedexOauth() {
  try {
    const res = await fetch('https://apis.fedex.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: key, client_secret: password }),
    });
    const body = await res.text();
    console.log(`FedEx REST OAuth: HTTP ${res.status}${res.ok ? ' — AUTHENTICATED' : ''}`);
    if (!res.ok) console.log(`  detail: ${body.slice(0, 200).replace(/\s+/g, ' ')}`);
    return res.ok;
  } catch (e) {
    console.log(`FedEx REST OAuth: network error — ${e.message}`);
    return false;
  }
}

function purolatorEnvelope() {
  return `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:v2="http://purolator.com/pws/datatypes/v2">
  <soapenv:Header>
    <v2:RequestContext>
      <v2:Version>2.2</v2:Version>
      <v2:Language>en</v2:Language>
      <v2:GroupID>xxx</v2:GroupID>
      <v2:RequestReference>PnP fuel probe</v2:RequestReference>
    </v2:RequestContext>
  </soapenv:Header>
  <soapenv:Body>
    <v2:GetQuickEstimateRequest>
      <v2:BillingAccountNumber>${account}</v2:BillingAccountNumber>
      <v2:SenderPostalCode>M5X1A9</v2:SenderPostalCode>
      <v2:ReceiverAddress>
        <v2:City>Montreal</v2:City>
        <v2:Province>QC</v2:Province>
        <v2:Country>CA</v2:Country>
        <v2:PostalCode>H2Y1C6</v2:PostalCode>
      </v2:ReceiverAddress>
      <v2:PackageType>CustomerPackaging</v2:PackageType>
      <v2:TotalWeight>
        <v2:Value>1</v2:Value>
        <v2:WeightUnit>lb</v2:WeightUnit>
      </v2:TotalWeight>
    </v2:GetQuickEstimateRequest>
  </soapenv:Body>
</soapenv:Envelope>`;
}

async function tryPurolator(host) {
  try {
    const res = await fetch(`https://${host}/EWS/V2/Estimating/EstimatingService.asmx`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': 'http://purolator.com/pws/service/v2/GetQuickEstimate',
        'Authorization': 'Basic ' + Buffer.from(`${key}:${password}`).toString('base64'),
      },
      body: purolatorEnvelope(),
    });
    const body = await res.text();
    console.log(`Purolator E-Ship (${host}): HTTP ${res.status}`);
    if (res.status === 401) { console.log('  not authorized on this host'); return false; }
    // Pull any fault message
    const fault = body.match(/<faultstring>([\s\S]*?)<\/faultstring>/i) || body.match(/<Description>([\s\S]*?)<\/Description>/i);
    if (fault) console.log(`  message: ${fault[1].trim().slice(0, 200)}`);
    // Pull estimates: base price + surcharges
    const estimates = [...body.matchAll(/<ShipmentEstimate>([\s\S]*?)<\/ShipmentEstimate>/g)];
    for (const [, est] of estimates.slice(0, 6)) {
      const svc = (est.match(/<ServiceID>(.*?)<\/ServiceID>/) || [])[1];
      const base = parseFloat((est.match(/<BasePrice>(.*?)<\/BasePrice>/) || [])[1]);
      let fuel = null;
      for (const [, sur] of est.matchAll(/<Surcharge>([\s\S]*?)<\/Surcharge>/g)) {
        const type = (sur.match(/<Type>(.*?)<\/Type>/) || [])[1] || '';
        const desc = (sur.match(/<Description>(.*?)<\/Description>/) || [])[1] || '';
        const amt = parseFloat((sur.match(/<Amount>(.*?)<\/Amount>/) || [])[1]);
        if (/fuel/i.test(type + desc)) fuel = (fuel || 0) + (amt || 0);
      }
      const pct = base && fuel != null ? ((fuel / base) * 100).toFixed(2) + '%' : 'n/a';
      console.log(`  ${String(svc).padEnd(20)} base ${String(base).padStart(7)}  fuel ${String(fuel).padStart(7)}  fuel% ${pct}`);
    }
    if (res.ok && !estimates.length) console.log('  responded OK but no estimates parsed (first 300 chars): ' + body.replace(/\s+/g, ' ').slice(0, 300));
    return res.ok && estimates.length > 0;
  } catch (e) {
    console.log(`Purolator E-Ship (${host}): network error — ${e.message}`);
    return false;
  }
}

(async () => {
  const fedex = await tryFedexOauth();
  console.log('');
  const puroProd = await tryPurolator('webservices.purolator.com');
  let puroDev = false;
  if (!puroProd) { console.log(''); puroDev = await tryPurolator('devwebservices.purolator.com'); }
  console.log('\nVerdict:');
  if (fedex) console.log('  Credentials authenticate with FedEx REST.');
  if (puroProd) console.log('  Credentials are PUROLATOR PRODUCTION — quotes returned with fuel.');
  if (puroDev) console.log('  Credentials are PUROLATOR DEVELOPMENT — test rates only, request production key.');
  if (!fedex && !puroProd && !puroDev) console.log('  Neither carrier accepted them as-is. They may be FedEx legacy SOAP keys, which need a Meter Number and do not work with the modern API.');
})();
