/**
 * Shared rate fixtures — real rate sets pulled from production
 * (`focused-civet-250`).
 *
 * Lives in its own module with **no imports** so both the plain-Node cost-engine
 * suite and the edge-runtime Convex suite can use the same numbers. Duplicating
 * these per test file is how the legacy estimator ended up with three divergent
 * copies of its own constants.
 *
 * Chosen deliberately: NOT one of the 36 proposals where
 * `craftBaseRate = weldBaseRate = 0` (both engines return $0.00 and prove
 * nothing), and NOT proposal 1734, whose `rigRate`/`fuelRate`/`consumablesRate`/
 * `weldBaseRate` are all 0 so it exercises almost no markup path despite being
 * the largest estimate.
 */

/** The fifteen proposal rates, structurally identical to the engine's type. */
export interface RateFixture {
  craftBaseRate: number;
  weldBaseRate: number;
  rigRate: number;
  subsistenceRate: number;
  burdenRate: number;
  overheadRate: number;
  laborProfitRate: number;
  fuelRate: number;
  consumablesRate: number;
  salesTaxRate: number;
  useTaxRate: number;
  materialProfitRate: number;
  equipmentProfitRate: number;
  subcontractorProfitRate: number;
  rigProfitRate: number;
}

/** Proposal 2020 — "Tank 8 installation". All fifteen rates non-zero. */
export const RATES_2020: RateFixture = {
  craftBaseRate: 35.98,
  weldBaseRate: 40.7,
  rigRate: 15,
  subsistenceRate: 10,
  burdenRate: 19.53,
  overheadRate: 10,
  laborProfitRate: 10,
  fuelRate: 3.5,
  consumablesRate: 10,
  salesTaxRate: 9.25,
  useTaxRate: 9.25,
  materialProfitRate: 7,
  equipmentProfitRate: 7,
  subcontractorProfitRate: 7,
  rigProfitRate: 10,
};

/** Proposal 2069 — "KM Pipe Supports". Median of the all-rates-populated set. */
export const RATES_2069: RateFixture = {
  craftBaseRate: 43.17,
  weldBaseRate: 47.83,
  rigRate: 15,
  subsistenceRate: 12.5,
  burdenRate: 22.15,
  overheadRate: 10,
  laborProfitRate: 10,
  fuelRate: 4,
  consumablesRate: 12,
  salesTaxRate: 8.5,
  useTaxRate: 8.5,
  materialProfitRate: 10,
  equipmentProfitRate: 10,
  subcontractorProfitRate: 10,
  rigProfitRate: 10,
};

/** Proposal 1605 — "2024 Unit 1 Scrubber/Baghouse". */
export const RATES_1605: RateFixture = {
  craftBaseRate: 34.45,
  weldBaseRate: 46.67,
  rigRate: 15,
  subsistenceRate: 11.67,
  burdenRate: 22.75,
  overheadRate: 10,
  laborProfitRate: 10,
  fuelRate: 2,
  consumablesRate: 13,
  salesTaxRate: 7,
  useTaxRate: 7,
  materialProfitRate: 7.5,
  equipmentProfitRate: 7.5,
  subcontractorProfitRate: 7.5,
  rigProfitRate: 10,
};

/** A zero-rate proposal, matching the 36 that exist in production. */
export const RATES_ALL_ZERO: RateFixture = {
  craftBaseRate: 0,
  weldBaseRate: 0,
  rigRate: 0,
  subsistenceRate: 0,
  burdenRate: 0,
  overheadRate: 0,
  laborProfitRate: 0,
  fuelRate: 0,
  consumablesRate: 0,
  salesTaxRate: 0,
  useTaxRate: 0,
  materialProfitRate: 0,
  equipmentProfitRate: 0,
  subcontractorProfitRate: 0,
  rigProfitRate: 0,
};

/** Every fixture, labelled, for suites that sweep all of them. */
export const RATE_SETS: ReadonlyArray<readonly [string, RateFixture]> = [
  ["2020", RATES_2020],
  ["2069", RATES_2069],
  ["1605", RATES_1605],
  ["all-zero", RATES_ALL_ZERO],
];
