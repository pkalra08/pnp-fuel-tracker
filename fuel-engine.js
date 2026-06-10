// fuel-engine.js
// Part n Parcel fuel surcharge calculation engine.
//
// Pure function. Takes current government-published diesel and jet fuel prices,
// returns the current fuel surcharge percentage for every Canadian carrier and
// service we track. No external calls inside this file. Same code runs in the
// browser, in a Cloudflare Worker, in Node, anywhere.
//
// Data sources the engine expects as input:
//   nrcanDieselCAD           Canadian diesel retail price (CAD per litre), most recent weekly value
//   nrcanDieselCAD4WeekAvg   Four-week trailing average of the same NRCan weekly diesel value
//   kalibrateDieselCAD       Canadian diesel weekly average from Kalibrate Technologies (CAD/L)
//   eiaOnHighwayUSD          U.S. National On-Highway diesel price (USD per gallon)
//   eiaJetGulfUSD            U.S. Gulf Coast kerosene jet fuel spot price (USD per gallon)
//
// Some carriers use a single weekly value with a lag (UPS, FedEx, Canpar).
// Others use a four-week trailing average and reset monthly (Purolator).
//
// Canpar, Canada Post, and Loomis all reference Kalibrate Technologies Ltd
// for their Canadian diesel index. Kalibrate publishes its current price
// report and daily pump price survey publicly at charting.kalibrate.com.
// Free access, no subscription required for the basic data the engine needs.
// The production fetcher reads Kalibrate weekly to drive these three carriers,
// matching the source the carriers themselves cite. No proxy needed.
//
// Each carrier publishes a "band table" mapping a price range to a surcharge
// percentage. The engine encodes those band tables verbatim from the carriers'
// public methodology pages. Carriers update these tables periodically. When
// they do, the engine updates them here. That is the entire maintenance loop.
//
// Public reference URLs:
//   UPS Canada     https://www.ups.com/ca/en/support/shipping-support/shipping-costs-rates/fuel-surcharges
//   FedEx Canada   https://www.fedex.com/en-ca/shipping/fuel-surcharges.html
//   NRCan diesel   https://www2.nrcan.gc.ca/eneene/sources/pripri/prices_bycity_e.cfm
//   EIA diesel     https://www.eia.gov/petroleum/gasdiesel/
//   EIA jet fuel   https://www.eia.gov/dnav/pet/hist/EER_EPJK_PF4_RGC_DPGw.htm

// ----------------------------------------------------------------------------
// Band tables. Each row: [priceAtLeast, priceLessThan, surchargePercent].
// Price columns are inclusive of the lower bound and exclusive of the upper
// bound, matching how carriers publish them.
// ----------------------------------------------------------------------------

const BANDS = {

  // UPS Canada. Source: ups.com fuel surcharge methodology page.

  // UPS publishes a 15-row window that it slides up and down as prices move,
  // but the underlying rule is a fixed linear formula. We encode the formula
  // instead of the snapshot so the window never slides off the edge and the
  // UPS rows never need a routine refresh. Verified against UPS's published
  // 90-day history (the formula reproduces every row from 29.50% to 47.50%).
  //
  // A formula band: rate = anchorRate + floor((price - anchorPrice) / step) * increment,
  // valid only between validMin and validMax. Outside that range the engine
  // returns null (row goes yellow), so we never silently extrapolate into
  // prices UPS has not actually published. The valid range is set far wider
  // than a year of observed prices, so under normal movement it never flags.

  'ups-standard-canada': {
    // Input: NRCan Canadian diesel retail price (CAD/L). 2-week lag. Weekly Monday.
    formula: true, anchorPrice: 2.02, anchorRate: 39.50, step: 0.02, increment: 0.50,
    validMin: 1.40, validMax: 2.70, verified: '2026-06-10'
  },

  'ups-standard-us': {
    // Input: EIA U.S. On-Highway diesel (USD/gallon). 2-week lag. Weekly Monday.
    formula: true, anchorPrice: 4.72, anchorRate: 18.75, step: 0.09, increment: 0.25,
    validMin: 4.30, validMax: 6.40, verified: '2026-06-10'
  },

  'ups-international-jet': {
    // Input: EIA U.S. Gulf Coast Jet Fuel (USD/gallon). 2-week lag. Weekly Monday.
    // Covers UPS International Express, Expedited, and 3 Day Select.
    formula: true, anchorPrice: 2.99, anchorRate: 32.25, step: 0.04, increment: 0.25,
    validMin: 2.40, validMax: 4.60, verified: '2026-06-10'
  },

  'ups-domestic-jet': {
    // Input: EIA U.S. Gulf Coast Jet Fuel (USD/gallon). 2-week lag. Weekly Monday.
    // Covers UPS Domestic Express and Expedited (Canada).
    formula: true, anchorPrice: 2.95, anchorRate: 30.25, step: 0.05, increment: 0.25,
    validMin: 2.40, validMax: 4.60, verified: '2026-06-10'
  },

  // FedEx Canada. Source: fedex.com fuel surcharges page.

  'fedex-intra-canada': [
    // Input: NRCan Canadian diesel retail price (CAD/L). 2-week lag. Weekly Monday.
    // Covers FedEx Express Intra-Canada AND FedEx Ground Intra-Canada (same table).
    // Effective April 6, 2026.
    [0.74, 0.94, 21.50],
    [0.94, 1.14, 22.50],
    [1.14, 1.34, 23.50],
    [1.34, 1.54, 24.50],
    [1.54, 1.58, 25.50],
    [1.58, 1.62, 26.50],
    [1.62, 1.66, 27.50],
    [1.66, 1.70, 28.50],
    [1.70, 1.74, 29.50],
    [1.74, 1.78, 30.50],
    [1.78, 1.82, 31.50],
    [1.82, 1.86, 32.50],
    [1.86, 1.90, 33.50],
    [1.90, 1.94, 34.50],
    [1.94, 1.98, 35.50],
    [1.98, 2.02, 36.50],
    [2.02, 2.06, 37.50],
    [2.06, 2.10, 38.50],
    [2.10, 2.14, 39.50],
    [2.14, 2.18, 40.50],
    [2.18, 2.22, 41.50],
    [2.22, 2.26, 42.50],
    [2.26, 2.30, 43.50],
    [2.30, 2.34, 44.50],
    [2.34, 2.38, 45.50],
    [2.38, 2.42, 46.50],
    [2.42, 2.46, 47.50],
    [2.46, 2.50, 48.50],
    [2.50, 2.54, 49.50],
    [2.54, 2.58, 50.50],
    [2.58, 2.62, 51.50],
    [2.62, 2.66, 52.50],
    [2.66, 2.70, 53.50]
  ],

  'fedex-export-import-jet': [
    // Input: EIA U.S. Gulf Coast Jet Fuel (USD/gallon). 2-week lag. Weekly Monday.
    // Covers FedEx Express Canadian Export and Canadian Import services.
    // Effective May 11, 2026.
    [1.27, 1.47, 25.50],
    [1.47, 1.67, 25.75],
    [1.67, 1.87, 26.00],
    [1.87, 2.07, 26.25],
    [2.07, 2.11, 26.50],
    [2.11, 2.15, 26.75],
    [2.15, 2.19, 27.00],
    [2.19, 2.23, 27.25],
    [2.23, 2.27, 27.50],
    [2.27, 2.31, 27.75],
    [2.31, 2.35, 28.00],
    [2.35, 2.39, 28.25],
    [2.39, 2.43, 28.50],
    [2.43, 2.47, 28.75],
    [2.47, 2.51, 29.00],
    [2.51, 2.55, 29.25],
    [2.55, 2.59, 29.50],
    [2.59, 2.63, 29.75],
    [2.63, 2.67, 30.00],
    [2.67, 2.71, 30.25],
    [2.71, 2.75, 30.50],
    [2.75, 2.79, 30.75],
    [2.79, 2.83, 31.00],
    [2.83, 2.87, 31.25],
    [2.87, 2.91, 31.50],
    [2.91, 2.95, 31.75],
    [2.95, 2.99, 32.00],
    [2.99, 3.03, 32.25],
    [3.03, 3.07, 32.50],
    [3.07, 3.11, 32.75],
    [3.11, 3.15, 33.00],
    [3.15, 3.19, 33.25],
    [3.19, 3.23, 33.50],
    [3.23, 3.27, 33.75],
    [3.27, 3.31, 34.00],
    [3.31, 3.35, 34.25],
    [3.35, 3.39, 34.50],
    [3.39, 3.43, 34.75],
    [3.43, 3.47, 35.00],
    [3.47, 3.51, 35.25],
    [3.51, 3.55, 35.50],
    [3.55, 3.59, 35.75],
    [3.59, 3.63, 36.00],
    [3.63, 3.67, 36.25],
    [3.67, 3.71, 36.50],
    [3.71, 3.75, 36.75],
    [3.75, 3.79, 37.00],
    [3.79, 3.83, 37.25],
    [3.83, 3.87, 37.50],
    [3.87, 3.91, 37.75],
    [3.91, 3.95, 38.00],
    [3.95, 3.99, 38.25],
    [3.99, 4.03, 38.50],
    [4.03, 4.07, 38.75],
    [4.07, 4.11, 39.00],
    [4.11, 4.15, 39.25],
    [4.15, 4.19, 39.50],
    [4.19, 4.23, 39.75],
    [4.23, 4.27, 40.00],
    [4.27, 4.31, 40.25],
    [4.31, 4.35, 40.50],
    [4.35, 4.39, 40.75],
    [4.39, 4.43, 41.00],
    [4.43, 4.47, 41.25],
    [4.47, 4.51, 41.50],
    [4.51, 4.55, 41.75],
    [4.55, 4.59, 42.00],
    [4.59, 4.63, 42.25],
    [4.63, 4.67, 42.50],
    [4.67, 4.71, 42.75],
    [4.71, 4.75, 43.00],
    [4.75, 4.79, 43.25],
    [4.79, 4.83, 43.50],
    [4.83, 4.87, 43.75],
    [4.87, 4.91, 44.00],
    [4.91, 4.95, 44.25],
    [4.95, 4.99, 44.50],
    [4.99, 5.03, 44.75],
    [5.03, 5.07, 45.00]
  ],

  'loomis-international-jet': [
    // Input: EIA U.S. Gulf Coast Jet Fuel (USD/gallon). 1-week lag. Weekly.
    // Covers Loomis Express International (Worldwide) shipments.
    // Source: loomisexpress.com/loomship/Services/FuelSurcharges
    [0.00, 0.98, 8.50],  [0.98, 1.02, 8.75],  [1.02, 1.06, 9.00],  [1.06, 1.10, 9.25],
    [1.10, 1.14, 9.50],  [1.14, 1.18, 9.75],  [1.18, 1.22, 10.00], [1.22, 1.26, 10.25],
    [1.26, 1.30, 10.50], [1.30, 1.34, 10.75], [1.34, 1.38, 11.00], [1.38, 1.42, 11.25],
    [1.42, 1.46, 11.50], [1.46, 1.50, 11.75], [1.50, 1.54, 12.00], [1.54, 1.58, 12.25],
    [1.58, 1.62, 12.50], [1.62, 1.66, 12.75], [1.66, 1.70, 13.00], [1.70, 1.74, 13.25],
    [1.74, 1.78, 13.50], [1.78, 1.82, 13.75], [1.82, 1.86, 14.00], [1.86, 1.90, 14.25],
    [1.90, 1.94, 14.50], [1.94, 1.98, 14.75], [1.98, 2.02, 15.00], [2.02, 2.06, 15.25],
    [2.06, 2.10, 15.50], [2.10, 2.14, 15.75], [2.14, 2.18, 16.00], [2.18, 2.22, 16.25],
    [2.22, 2.26, 16.50], [2.26, 2.30, 16.75], [2.30, 2.34, 17.00], [2.34, 2.38, 17.25],
    [2.38, 2.42, 17.50], [2.42, 2.46, 17.75], [2.46, 2.50, 18.00], [2.50, 2.54, 18.25],
    [2.54, 2.58, 18.50], [2.58, 2.62, 18.75], [2.62, 2.66, 19.00], [2.66, 2.70, 19.25],
    [2.70, 2.74, 19.50], [2.74, 2.78, 19.75], [2.78, 2.82, 20.00], [2.82, 2.86, 20.25],
    [2.86, 2.90, 20.50], [2.90, 2.94, 20.75], [2.94, 2.98, 21.00], [2.98, 3.02, 21.25],
    [3.02, 3.06, 21.50], [3.06, 3.10, 21.75], [3.10, 3.14, 22.00], [3.14, 3.18, 22.25],
    [3.18, 3.22, 22.50], [3.22, 3.26, 22.75], [3.26, 3.30, 23.00], [3.30, 3.34, 23.25],
    [3.34, 3.38, 23.50], [3.38, 3.42, 23.75], [3.42, 3.46, 24.00], [3.46, 3.50, 24.25],
    [3.50, 3.54, 24.50], [3.54, 3.58, 24.75], [3.58, 3.62, 25.00], [3.62, 3.66, 25.25],
    [3.66, 3.70, 25.50], [3.70, 3.74, 25.75], [3.74, 3.78, 26.00], [3.78, 3.82, 26.25],
    [3.82, 3.86, 26.50], [3.86, 3.90, 26.75], [3.90, 3.94, 27.00], [3.94, 3.98, 27.25],
    [3.98, 4.02, 27.50], [4.02, 4.06, 27.75], [4.06, 4.10, 28.00], [4.10, 4.14, 28.25],
    [4.14, 4.18, 28.50]
  ],

  'canpar-domestic': [
    // Input: Kalibrate Technologies Ltd weekly Canadian diesel average (CAD/L).
    // Lag: one week prior to effective date. Weekly Monday reset.
    // One rate covers all Canpar Express domestic Canadian shipments.
    // Source: canpar.com/en/shipping/fuel_surcharge.htm
    // Note: Loomis Express publishes an identical domestic band table with
    // identical bands and percentages. The two carriers share this band key.
    [0.80, 0.83, 5.55],  [0.83, 0.86, 6.30],  [0.86, 0.89, 7.05],  [0.89, 0.92, 7.80],
    [0.92, 0.95, 8.55],  [0.95, 0.98, 9.30],  [0.98, 1.01, 10.05], [1.01, 1.04, 10.80],
    [1.04, 1.07, 11.55], [1.07, 1.10, 12.30], [1.10, 1.13, 13.05], [1.13, 1.16, 13.80],
    [1.16, 1.19, 14.55], [1.19, 1.22, 15.30], [1.22, 1.25, 16.05], [1.25, 1.28, 16.80],
    [1.28, 1.31, 17.55], [1.31, 1.34, 18.30], [1.34, 1.37, 19.05], [1.37, 1.40, 19.80],
    [1.40, 1.43, 20.55], [1.43, 1.46, 21.30], [1.46, 1.49, 22.05], [1.49, 1.52, 22.80],
    [1.52, 1.55, 23.55], [1.55, 1.58, 24.30], [1.58, 1.61, 25.05], [1.61, 1.64, 25.80],
    [1.64, 1.67, 26.55], [1.67, 1.70, 27.30], [1.70, 1.73, 28.05], [1.73, 1.76, 28.80],
    [1.76, 1.79, 29.55], [1.79, 1.82, 30.30], [1.82, 1.85, 31.05], [1.85, 1.88, 31.80],
    [1.88, 1.91, 32.55], [1.91, 1.94, 33.30], [1.94, 1.97, 34.05], [1.97, 2.00, 34.80],
    [2.00, 2.03, 35.55], [2.03, 2.06, 36.30], [2.06, 2.09, 37.05], [2.09, 2.12, 37.80],
    [2.12, 2.15, 38.55], [2.15, 2.18, 39.30], [2.18, 2.21, 40.05], [2.21, 2.24, 40.80],
    [2.24, 2.27, 41.55], [2.27, 2.30, 42.30], [2.30, 2.33, 43.05], [2.33, 2.36, 43.80],
    [2.36, 2.39, 44.55], [2.39, 2.42, 45.30], [2.42, 2.45, 46.05], [2.45, 2.48, 46.80],
    [2.48, 2.51, 47.55], [2.51, 2.54, 48.30], [2.54, 2.57, 49.05], [2.57, 2.60, 49.80],
    [2.60, 2.63, 50.55], [2.63, 2.66, 51.30], [2.66, 2.69, 52.05], [2.69, 2.72, 52.80],
    [2.72, 2.75, 53.55], [2.75, 2.78, 54.30], [2.78, 2.81, 55.05], [2.81, 2.84, 55.80],
    [2.84, 2.87, 56.55], [2.87, 2.90, 57.30], [2.90, 2.93, 58.05], [2.93, 2.96, 58.80],
    [2.96, 2.99, 59.55], [2.99, 3.02, 60.30]
  ],

  'canada-post-domestic': [
    // Input: Kalibrate Technologies Ltd weekly Canadian diesel average (CAD/L). Weekly Monday.
    // Covers Canada Post Priority, Xpresspost, Expedited Parcel, and Regular Parcel.
    // Source: canadapost-postescanada.ca fuel surcharge page.
    [1.61, 1.63, 22.50], [1.63, 1.65, 23.00], [1.65, 1.67, 23.50], [1.67, 1.69, 24.00],
    [1.69, 1.71, 24.50], [1.71, 1.73, 25.00], [1.73, 1.75, 25.50], [1.75, 1.77, 26.00],
    [1.77, 1.79, 26.50], [1.79, 1.81, 27.00], [1.81, 1.83, 27.50], [1.83, 1.85, 28.00],
    [1.85, 1.87, 28.50], [1.87, 1.89, 29.00], [1.89, 1.91, 29.50], [1.91, 1.93, 30.00],
    [1.93, 1.95, 30.50], [1.95, 1.97, 31.00], [1.97, 1.99, 31.50], [1.99, 2.01, 32.00],
    [2.01, 2.03, 32.50], [2.03, 2.05, 33.00], [2.05, 2.07, 33.50], [2.07, 2.09, 34.00],
    [2.09, 2.11, 34.50], [2.11, 2.13, 35.00], [2.13, 2.15, 35.50], [2.15, 2.17, 36.00],
    [2.17, 2.19, 36.50], [2.19, 2.21, 37.00], [2.21, 2.23, 37.50], [2.23, 2.25, 38.00],
    [2.25, 2.27, 38.50], [2.27, 2.29, 39.00], [2.29, 2.31, 39.50], [2.31, 2.33, 40.00],
    [2.33, 2.35, 40.50], [2.35, 2.37, 41.00], [2.37, 2.39, 41.50], [2.39, 2.41, 42.00]
  ],

  'canada-post-usa-intl-parcel': [
    // Input: Kalibrate Technologies Ltd weekly Canadian diesel average (CAD/L). Weekly Monday.
    // Covers Xpresspost USA, Xpresspost International, International Parcel Air,
    // International Parcel Surface, and Expedited Parcel USA.
    [1.83, 1.85, 17.25], [1.85, 1.87, 17.50], [1.87, 1.89, 17.75], [1.89, 1.91, 18.00],
    [1.91, 1.93, 18.25], [1.93, 1.95, 18.50], [1.95, 1.97, 18.75], [1.97, 1.99, 19.00],
    [1.99, 2.01, 19.25], [2.01, 2.03, 19.50], [2.03, 2.05, 19.75], [2.05, 2.07, 20.00],
    [2.07, 2.09, 20.25], [2.09, 2.11, 20.50], [2.11, 2.13, 20.75], [2.13, 2.15, 21.00],
    [2.15, 2.17, 21.25], [2.17, 2.19, 21.50], [2.19, 2.21, 21.75], [2.21, 2.23, 22.00],
    [2.23, 2.25, 22.25], [2.25, 2.27, 22.50], [2.27, 2.29, 22.75], [2.29, 2.31, 23.00],
    [2.31, 2.33, 23.25], [2.33, 2.35, 23.50], [2.35, 2.37, 23.75], [2.37, 2.39, 24.00],
    [2.39, 2.41, 24.25], [2.41, 2.43, 24.50], [2.43, 2.45, 24.75], [2.45, 2.47, 25.00],
    [2.47, 2.49, 25.25], [2.49, 2.51, 25.50], [2.51, 2.53, 25.75], [2.53, 2.55, 26.00],
    [2.55, 2.57, 26.25], [2.57, 2.59, 26.50], [2.59, 2.61, 26.75], [2.61, 2.63, 27.00]
  ],

  'canada-post-usa-intl-packet': [
    // Input: Kalibrate Technologies Ltd weekly Canadian diesel average (CAD/L). Weekly Monday.
    // Covers Tracked Packet USA and International, Small Packet USA and International.
    // Same price bands as the Parcel table, lower rate column.
    [1.83, 1.85, 15.25], [1.85, 1.87, 15.50], [1.87, 1.89, 15.75], [1.89, 1.91, 16.00],
    [1.91, 1.93, 16.25], [1.93, 1.95, 16.50], [1.95, 1.97, 16.75], [1.97, 1.99, 17.00],
    [1.99, 2.01, 17.25], [2.01, 2.03, 17.50], [2.03, 2.05, 17.75], [2.05, 2.07, 18.00],
    [2.07, 2.09, 18.25], [2.09, 2.11, 18.50], [2.11, 2.13, 18.75], [2.13, 2.15, 19.00],
    [2.15, 2.17, 19.25], [2.17, 2.19, 19.50], [2.19, 2.21, 19.75], [2.21, 2.23, 20.00],
    [2.23, 2.25, 20.25], [2.25, 2.27, 20.50], [2.27, 2.29, 20.75], [2.29, 2.31, 21.00],
    [2.31, 2.33, 21.25], [2.33, 2.35, 21.50], [2.35, 2.37, 21.75], [2.37, 2.39, 22.00],
    [2.39, 2.41, 22.25], [2.41, 2.43, 22.50], [2.43, 2.45, 22.75], [2.45, 2.47, 23.00],
    [2.47, 2.49, 23.25], [2.49, 2.51, 23.50], [2.51, 2.53, 23.75], [2.53, 2.55, 24.00],
    [2.55, 2.57, 24.25], [2.57, 2.59, 24.50], [2.59, 2.61, 24.75], [2.61, 2.63, 25.00]
  ],

  'purolator-courier': [
    // Input: Four-week trailing average of NRCan Canadian diesel retail price (CAD/L).
    // Reset cadence: monthly, effective the first Monday of each month.
    // Updates posted approximately two weeks prior to effective date.
    // One rate covers ALL Purolator courier shipments regardless of destination
    // or selected mode of transportation.
    // Source: purolator.com/en/courier-fuel-surcharges
    // Note: Purolator Freight and Purolator International each have their own
    // separate fuel surcharges, not included in this band table.
    [1.00, 1.02, 13.00], [1.02, 1.04, 13.50], [1.04, 1.06, 14.00], [1.06, 1.08, 14.50],
    [1.08, 1.10, 15.00], [1.10, 1.12, 15.50], [1.12, 1.14, 16.00], [1.14, 1.16, 16.50],
    [1.16, 1.18, 17.00], [1.18, 1.20, 17.50], [1.20, 1.22, 18.00], [1.22, 1.24, 18.50],
    [1.24, 1.26, 19.00], [1.26, 1.28, 19.50], [1.28, 1.30, 20.00], [1.30, 1.32, 20.50],
    [1.32, 1.34, 21.00], [1.34, 1.36, 21.50], [1.36, 1.38, 22.00], [1.38, 1.40, 22.50],
    [1.40, 1.42, 23.00], [1.42, 1.44, 23.50], [1.44, 1.46, 24.00], [1.46, 1.48, 24.50],
    [1.48, 1.50, 25.00], [1.50, 1.52, 25.50], [1.52, 1.54, 26.00], [1.54, 1.56, 26.50],
    [1.56, 1.58, 27.00], [1.58, 1.60, 27.50], [1.60, 1.62, 28.00], [1.62, 1.64, 28.50],
    [1.64, 1.66, 29.00], [1.66, 1.68, 29.50], [1.68, 1.70, 30.00], [1.70, 1.72, 30.50],
    [1.72, 1.74, 31.00], [1.74, 1.76, 31.50], [1.76, 1.78, 32.00], [1.78, 1.80, 32.50],
    [1.80, 1.82, 33.00], [1.82, 1.84, 33.50], [1.84, 1.86, 34.00], [1.86, 1.88, 34.50],
    [1.88, 1.90, 35.00], [1.90, 1.92, 35.50], [1.92, 1.94, 36.00], [1.94, 1.96, 36.50],
    [1.96, 1.98, 37.00], [1.98, 2.00, 37.50], [2.00, 2.02, 38.00], [2.02, 2.04, 38.50],
    [2.04, 2.06, 39.00], [2.06, 2.08, 39.50], [2.08, 2.10, 40.00], [2.10, 2.12, 40.50],
    [2.12, 2.14, 41.00], [2.14, 2.16, 41.50], [2.16, 2.18, 42.00], [2.18, 2.20, 42.50],
    [2.20, 2.22, 43.00], [2.22, 2.24, 43.50], [2.24, 2.26, 44.00], [2.26, 2.28, 44.50],
    [2.28, 2.30, 45.00], [2.30, 2.32, 45.50], [2.32, 2.34, 46.00], [2.34, 2.36, 46.50],
    [2.36, 2.38, 47.00], [2.38, 2.40, 47.50], [2.40, 2.42, 48.00]
  ],

  'fedex-ground-international': [
    // Input: EIA U.S. On-Highway diesel (USD/gallon). 2-week lag. Weekly Monday.
    // Covers FedEx Ground international shipments for Canadian accounts.
    // Effective April 6, 2026.
    [2.47, 2.74, 14.50],
    [2.74, 3.01, 14.75],
    [3.01, 3.28, 15.00],
    [3.28, 3.55, 15.25],
    [3.55, 3.64, 15.50],
    [3.64, 3.73, 15.75],
    [3.73, 3.82, 16.00],
    [3.82, 3.91, 16.25],
    [3.91, 4.00, 16.50],
    [4.00, 4.09, 16.75],
    [4.09, 4.18, 17.00],
    [4.18, 4.27, 17.25],
    [4.27, 4.36, 17.50],
    [4.36, 4.45, 17.75],
    [4.45, 4.54, 18.00],
    [4.54, 4.63, 18.25],
    [4.63, 4.72, 18.50],
    [4.72, 4.81, 18.75],
    [4.81, 4.90, 19.00],
    [4.90, 4.99, 19.25],
    [4.99, 5.08, 19.50],
    [5.08, 5.17, 19.75],
    [5.17, 5.26, 20.00],
    [5.26, 5.35, 20.25],
    [5.35, 5.44, 20.50],
    [5.44, 5.53, 20.75],
    [5.53, 5.62, 21.00],
    [5.62, 5.71, 21.25],
    [5.71, 5.80, 21.50],
    [5.80, 5.89, 21.75],
    [5.89, 5.98, 22.00],
    [5.98, 6.07, 22.25],
    [6.07, 6.16, 22.50],
    [6.16, 6.25, 22.75],
    [6.25, 6.34, 23.00]
  ]

};

// ----------------------------------------------------------------------------
// Carrier and service registry. Maps each published service to the band table
// it uses and the input price it reads from. Adding a new carrier means adding
// a band table above and a registry entry here.
// ----------------------------------------------------------------------------

const CARRIERS = [
  {
    name: 'UPS Canada',
    url: 'https://www.ups.com/ca/en/support/shipping-support/shipping-costs-rates/fuel-surcharges',
    cadence: 'weekly',
    services: [
      { service: 'Standard Service within Canada',                   band: 'ups-standard-canada',    input: 'nrcanDieselCAD',  lagWeeks: 2 },
      { service: 'Standard Service to the U.S.',                     band: 'ups-standard-us',        input: 'eiaOnHighwayUSD', lagWeeks: 2 },
      { service: 'International Express, Expedited & 3 Day Select',  band: 'ups-international-jet',  input: 'eiaJetGulfUSD',   lagWeeks: 2 },
      { service: 'Domestic Express and Expedited',                   band: 'ups-domestic-jet',       input: 'eiaJetGulfUSD',   lagWeeks: 2 }
    ]
  },
  {
    name: 'FedEx Express',
    url: 'https://www.fedex.com/en-ca/shipping/fuel-surcharges.html',
    cadence: 'weekly',
    services: [
      { service: 'Intra-CAN',  band: 'fedex-intra-canada',      input: 'nrcanDieselCAD', lagWeeks: 2 },
      { service: 'Intl.',      band: 'fedex-export-import-jet', input: 'eiaJetGulfUSD',  lagWeeks: 2 }
    ]
  },
  {
    name: 'FedEx Ground and pickup services',
    url: 'https://www.fedex.com/en-ca/shipping/fuel-surcharges.html',
    cadence: 'weekly',
    services: [
      { service: 'Intra-CAN and pickup services',  band: 'fedex-intra-canada',         input: 'nrcanDieselCAD',  lagWeeks: 2 },
      { service: 'Intl.',                          band: 'fedex-ground-international', input: 'eiaOnHighwayUSD', lagWeeks: 2 }
    ]
  },
  {
    name: 'Purolator',
    url: 'https://www.purolator.com/en/courier-fuel-surcharges',
    cadence: 'monthly',
    services: [
      { service: 'Courier (all services and destinations)', band: 'purolator-courier', input: 'nrcanDieselCAD4WeekAvg', resetCadence: 'monthly' }
    ]
  },
  {
    name: 'Canpar Express',
    url: 'https://www.canpar.com/en/shipping/fuel_surcharge.htm',
    cadence: 'weekly',
    services: [
      { service: 'Domestic Canada', band: 'canpar-domestic', input: 'kalibrateDieselCAD', lagWeeks: 1 }
    ]
  },
  {
    name: 'Canada Post',
    url: 'https://www.canadapost-postescanada.ca/cpc/en/support/kb/company-policies/rates-taxes-surcharges/fuel-surcharges-on-mail-and-parcels.page',
    cadence: 'weekly',
    services: [
      { service: 'Domestic Services',                       band: 'canada-post-domestic',          input: 'kalibrateDieselCAD' },
      { service: 'USA and International Parcel Services',   band: 'canada-post-usa-intl-parcel',   input: 'kalibrateDieselCAD' },
      { service: 'USA and International Packet Services',   band: 'canada-post-usa-intl-packet',   input: 'kalibrateDieselCAD' }
    ]
  },
  {
    name: 'Loomis Express',
    url: 'https://www.loomisexpress.com/loomship/Services/FuelSurcharges',
    cadence: 'weekly',
    services: [
      // Loomis domestic uses an identical band table to Canpar (both reference
      // the same Kalibrate-based methodology), so the band key is shared.
      { service: 'Domestic Express and Ground Service', band: 'canpar-domestic',          input: 'kalibrateDieselCAD', lagWeeks: 1 },
      { service: 'Worldwide Service',                   band: 'loomis-international-jet', input: 'eiaJetGulfUSD',      lagWeeks: 1 }
    ]
  }

];

// ----------------------------------------------------------------------------
// Pure functions. No state, no I/O.
// ----------------------------------------------------------------------------

function lookupBand(bandKey, price) {
  const bands = BANDS[bandKey];
  if (!bands || price == null) return null;

  // Formula band (e.g. UPS). Compute the rate from the linear rule rather than
  // a fixed row, valid only inside the stated price range.
  if (bands.formula) {
    if (price < bands.validMin) return { rate: null, reason: 'below_formula_range', floor: bands.validMin };
    if (price > bands.validMax) return { rate: null, reason: 'above_formula_range', ceiling: bands.validMax };
    // +1e-9 guards against float error landing a value just under a step boundary.
    const steps = Math.floor((price - bands.anchorPrice) / bands.step + 1e-9);
    const rate = +(bands.anchorRate + steps * bands.increment).toFixed(2);
    return { rate, reason: 'formula' };
  }

  // Array band (a list of [priceFrom, priceTo, rate] rows).
  // Below published range
  if (price < bands[0][0]) return { rate: null, reason: 'below_published_range', floor: bands[0][0] };
  // Above published range
  const last = bands[bands.length - 1];
  if (price >= last[1]) return { rate: null, reason: 'above_published_range', ceiling: last[1] };
  // In range
  for (const [from, to, rate] of bands) {
    if (price >= from && price < to) {
      return { rate, reason: 'in_range', band: { from, to } };
    }
  }
  return null;
}

function computeRates(prices) {
  // prices: { nrcanDieselCAD, eiaOnHighwayUSD, eiaJetGulfUSD, asOf: { source: ISODateString } }
  // Returns: array of carriers with derived service rates and the inputs used.

  return CARRIERS.map(carrier => ({
    name: carrier.name,
    url: carrier.url,
    services: carrier.services.map(svc => {
      const inputPrice = prices[svc.input];
      const lookup = lookupBand(svc.band, inputPrice);
      return {
        service: svc.service,
        current: lookup ? lookup.rate : null,
        derivedFrom: {
          inputName: svc.input,
          inputPrice,
          lagWeeks: svc.lagWeeks,
          bandTable: svc.band,
          lookupReason: lookup ? lookup.reason : 'no_input'
        }
      };
    })
  }));
}

// ----------------------------------------------------------------------------
// Module export. CommonJS and ES modules both work.
// ----------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BANDS, CARRIERS, lookupBand, computeRates };
}
if (typeof window !== 'undefined') {
  window.PnpFuelEngine = { BANDS, CARRIERS, lookupBand, computeRates };
}

// ----------------------------------------------------------------------------
// Example. Uncomment to test in a browser console or with `node fuel-engine.js`.
// ----------------------------------------------------------------------------

// const result = computeRates({
//   nrcanDieselCAD:         2.20,    // CAD/L. From NRCan, weekly value 2 weeks prior. (UPS, FedEx)
//   nrcanDieselCAD4WeekAvg: 2.3150,  // CAD/L. Four-week trailing average from NRCan. (Purolator)
//   kalibrateDieselCAD:     2.20,    // CAD/L. From Kalibrate weekly, 1 week prior. (Canpar)
//   eiaOnHighwayUSD:        5.67,    // USD/gal. From EIA On-Highway, 2 weeks prior. (UPS, FedEx Ground)
//   eiaJetGulfUSD:          4.17,    // USD/gal. From EIA Gulf Coast Jet, 2 weeks prior. (UPS Express, FedEx Express)
//   asOf: '2026-05-13'
// });
// // Produces current published rates: UPS, FedEx and Canpar for the week of May 11 to 17, 2026,
// // Purolator for the month of May 4 to May 31, 2026.
// console.log(JSON.stringify(result, null, 2));
