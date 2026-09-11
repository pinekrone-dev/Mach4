// Untrended back-of-envelope pro forma. Residential deals run on unit rents,
// commercial deals on NNN rent per leasable square foot. Both land on the same
// three numbers a developer actually looks at: cost, NOI and yield on cost.

import { TYPOLOGIES, UNIT_TYPES, PARKING } from './typologies.js';

export function runProforma(scene, params) {
  const t = TYPOLOGIES[params.typology];
  const m = scene.metrics;
  const cost = params.cost;
  const ops = params.ops;

  // ---- cost ---------------------------------------------------------------
  const shell = m.gsf * cost.shellPsf;
  const structured = (m.structuredStalls || 0) * (cost.parkingPerStall || 0);
  const surface = (m.surfaceStalls || 0) * (t.parkingType === 'surface' ? cost.parkingPerStall : 5200);
  const sitework = m.openSpace * 4.25 + m.siteArea * 1.15;
  const hard = shell + structured + surface + sitework;
  const contingency = hard * (cost.contingencyPct || 0);
  const soft = (hard + contingency) * (cost.softPct || 0);
  const land = params.landPrice || 0;
  const totalCost = land + hard + contingency + soft;

  // ---- revenue ------------------------------------------------------------
  let gpr = 0;
  const rentRoll = [];
  if (t.family === 'residential') {
    for (const u of UNIT_TYPES) {
      const count = m.mixCount[u.key] || 0;
      if (!count) continue;
      // Average as drawn, so the rent roll matches the plan rather than the brief.
      const avgArea = (m.mixArea && m.mixArea[u.key]) ? m.mixArea[u.key] / count : u.area;
      const psf = (params.rents && params.rents[u.key]) || u.rentPsf;
      const monthly = psf * avgArea;
      rentRoll.push({
        key: u.key,
        name: u.name,
        count,
        area: avgArea,
        rentPsf: psf,
        monthly,
        annual: monthly * 12 * count,
      });
      gpr += monthly * 12 * count;
    }
  } else {
    const psf = ops.nnnRentPsf;
    const leasable = m.nsf;
    gpr = leasable * psf;
    rentRoll.push({
      key: 'nnn',
      name: 'Leasable area',
      count: 1,
      area: leasable,
      rentPsf: psf,
      monthly: (leasable * psf) / 12,
      annual: gpr,
    });
  }

  const other = t.family === 'residential' ? m.units * (ops.otherIncomePerUnit || 0) : 0;
  const vacancyLoss = (gpr + other) * (ops.vacancy || 0);
  const egi = gpr + other - vacancyLoss;

  let opex;
  if (t.family === 'residential') {
    opex = m.units * (ops.opexPerUnit || 0);
  } else {
    const gross = m.nsf * (ops.opexPsf || 0);
    opex = gross * (1 - (ops.opexRecoveryPct || 0));
  }
  const noi = egi - opex;

  // ---- returns ------------------------------------------------------------
  const capRate = ops.capRate || 0.055;
  const stabilizedValue = capRate > 0 ? noi / capRate : 0;
  const yieldOnCost = totalCost > 0 ? noi / totalCost : 0;
  const profit = stabilizedValue - totalCost;
  const margin = totalCost > 0 ? profit / totalCost : 0;
  const spread = yieldOnCost - capRate;

  const forSale = t.forSale && t.family === 'residential'
    ? saleAnalysis(m, t, totalCost)
    : null;

  return {
    cost: {
      land,
      shell,
      structuredParking: structured,
      surfaceParking: surface,
      sitework,
      hard,
      contingency,
      soft,
      total: totalCost,
      perUnit: m.units > 0 ? totalCost / m.units : 0,
      perGsf: m.gsf > 0 ? totalCost / m.gsf : 0,
    },
    revenue: {
      gpr,
      other,
      vacancyLoss,
      egi,
      opex,
      noi,
      rentRoll,
      noiPerUnit: m.units > 0 ? noi / m.units : 0,
    },
    returns: {
      capRate,
      stabilizedValue,
      yieldOnCost,
      spread,
      profit,
      margin,
      valuePerUnit: m.units > 0 ? stabilizedValue / m.units : 0,
    },
    forSale,
  };
}

function saleAnalysis(m, t, totalCost) {
  const avgArea = m.units > 0 ? m.nsf / m.units : 0;
  const gross = m.units * avgArea * t.forSale.pricePsf;
  const selling = gross * t.forSale.sellingCostPct;
  const net = gross - selling;
  return {
    avgArea,
    pricePsf: t.forSale.pricePsf,
    avgPrice: avgArea * t.forSale.pricePsf,
    grossRevenue: gross,
    sellingCosts: selling,
    netRevenue: net,
    profit: net - totalCost,
    margin: totalCost > 0 ? (net - totalCost) / totalCost : 0,
  };
}

// Sensitivity grid: yield on cost across rent and hard-cost deltas.
export function sensitivity(scene, params, rentSteps = [-0.1, -0.05, 0, 0.05, 0.1], costSteps = [-0.1, -0.05, 0, 0.05, 0.1]) {
  const grid = [];
  for (const c of costSteps) {
    const row = [];
    for (const r of rentSteps) {
      const tweaked = JSON.parse(JSON.stringify(params));
      tweaked.cost.shellPsf *= 1 + c;
      if (TYPOLOGIES[params.typology].family === 'residential') {
        tweaked.rents = {};
        for (const u of UNIT_TYPES) {
          tweaked.rents[u.key] = ((params.rents && params.rents[u.key]) || u.rentPsf) * (1 + r);
        }
      } else {
        tweaked.ops.nnnRentPsf *= 1 + r;
      }
      row.push(runProforma(scene, tweaked).returns.yieldOnCost);
    }
    grid.push(row);
  }
  return { grid, rentSteps, costSteps };
}

export const PARKING_CONSTANTS = PARKING;
