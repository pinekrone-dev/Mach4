// The massing engine. Takes a site polygon plus a program and returns a full
// scheme: building bars, unit layouts, parking bays, stalls and site metrics.
//
// Everything is solved in a "local" frame rotated so the building axis runs
// along +x, then transformed back to world coordinates at the end.

import {
  V, area, bbox, centroid, ensureCCW, offsetPolygonPerEdge, offsetPolygon,
  perimeter, rectPoly, rotatePoly, bandSpans, longestEdgeAngle, edgeAngle,
  offsetRing, SQFT_PER_ACRE,
} from './geometry.js';
import { PARKING, TYPOLOGIES, UNIT_TYPES } from './typologies.js';

const UNIT_BY_KEY = Object.fromEntries(UNIT_TYPES.map((u) => [u.key, u]));
const ROW_GAP = 6; // breathing room between a building row and a parking bay

// ---------------------------------------------------------------------------
// setbacks
// ---------------------------------------------------------------------------

// Classify each edge as front / side / rear relative to the frontage edge and
// return the matching setback distance per edge.
export function setbackDistances(poly, frontageEdge, setbacks) {
  const p = ensureCCW(poly);
  const n = p.length;
  const f = ((frontageEdge % n) + n) % n;
  const fa = edgeAngle(p, f);
  const fn = { x: Math.sin(fa), y: -Math.cos(fa) }; // outward normal of the frontage
  const out = [];
  for (let i = 0; i < n; i++) {
    if (i === f) { out.push(setbacks.front); continue; }
    const a = edgeAngle(p, i);
    const nrm = { x: Math.sin(a), y: -Math.cos(a) };
    const d = V.dot(nrm, fn);
    if (d > 0.7) out.push(setbacks.front);
    else if (d < -0.7) out.push(setbacks.rear);
    else out.push(setbacks.side);
  }
  return out;
}

// ---------------------------------------------------------------------------
// unit mix
// ---------------------------------------------------------------------------

// A deterministic repeating order of unit keys matching the requested mix.
export function mixSequence(mix, cycle = 25) {
  const keys = UNIT_TYPES.map((u) => u.key);
  const total = keys.reduce((s, k) => s + (mix[k] || 0), 0) || 1;
  const quota = keys.map((k) => ({ k, exact: ((mix[k] || 0) / total) * cycle }));
  const seq = [];
  quota.forEach((q) => {
    const whole = Math.floor(q.exact);
    for (let i = 0; i < whole; i++) seq.push(q.k);
    q.rem = q.exact - whole;
  });
  quota.sort((a, b) => b.rem - a.rem);
  let i = 0;
  while (seq.length < cycle) seq.push(quota[i++ % quota.length].k);
  // Interleave so a bar reads as a real mix rather than blocks of one type.
  const byType = new Map();
  seq.forEach((k) => byType.set(k, (byType.get(k) || 0) + 1));
  const pools = [...byType.entries()].sort((a, b) => b[1] - a[1]);
  const woven = [];
  while (pools.some(([, c]) => c > 0)) {
    for (const entry of pools) {
      if (entry[1] > 0) { woven.push(entry[0]); entry[1] -= 1; }
    }
  }
  return woven;
}

// ---------------------------------------------------------------------------
// bar + unit layout
// ---------------------------------------------------------------------------

function unitWidth(key, unitDepth) {
  return Math.max(13, UNIT_BY_KEY[key].area / unitDepth);
}

// Fill a run of corridor with whole units taken from the mix sequence. The
// count is chosen so the stretch needed to fill the run exactly stays small.
function fillRun(runWidth, unitDepth, seq, cursor, avgW) {
  if (runWidth < 13) return [];
  const target = Math.max(1, Math.round(runWidth / avgW));
  let best = null;
  for (const count of [target - 1, target, target + 1]) {
    if (count < 1) continue;
    const keys = [];
    let natural = 0;
    for (let i = 0; i < count; i++) {
      const key = seq[(cursor.i + i) % seq.length];
      keys.push(key);
      natural += unitWidth(key, unitDepth);
    }
    const scale = runWidth / natural;
    const penalty = Math.abs(Math.log(scale));
    if (!best || penalty < best.penalty) best = { keys, natural, scale, penalty };
  }
  if (!best) return [];
  cursor.i += best.keys.length;
  return best.keys.map((key) => ({ key, width: unitWidth(key, unitDepth) * best.scale }));
}

// Lay out units either side of a central corridor within one bar footprint.
function layoutUnits(bar, t, p, seq, cursor) {
  const corridor = t.corridorWidth;
  const doubleLoaded = corridor > 0;
  const unitDepth = doubleLoaded ? (bar.h - corridor) / 2 : bar.h;
  const units = [];
  const cores = [];
  if (unitDepth < 12) return { units, cores, unitDepth };

  if (!doubleLoaded) {
    // Townhome-style: a single row of equal-width attached units.
    const w = t.unitWidth || 22;
    const count = Math.max(1, Math.floor(bar.w / w));
    const actual = bar.w / count;
    for (let i = 0; i < count; i++) {
      const key = seq[cursor.i++ % seq.length];
      units.push({ rect: { x: bar.x + i * actual, y: bar.y, w: actual, h: bar.h }, type: key });
    }
    return { units, cores, unitDepth };
  }

  const avgW = avgUnitArea(p.mix) / unitDepth;
  const coreW = t.coreWidth;
  // One core per `coreEvery` feet, but never so many that the runs between
  // them are too short to hold a pair of units.
  const maxCores = Math.max(0, Math.floor((bar.w - 2 * avgW) / (coreW + 2 * avgW)));
  const nCores = Math.min(maxCores, Math.max(1, Math.round(bar.w / t.coreEvery)));

  const runs = [];
  const netLen = bar.w - nCores * coreW;
  if (netLen <= 0) return { units, cores, unitDepth };
  const runLen = netLen / (nCores + 1);
  let x = bar.x;
  for (let s = 0; s <= nCores; s++) {
    runs.push({ x, w: runLen });
    x += runLen;
    if (s < nCores) {
      cores.push({ x, y: bar.y, w: coreW, h: bar.h });
      x += coreW;
    }
  }

  for (const run of runs) {
    for (const side of [0, 1]) {
      const y = side === 0 ? bar.y : bar.y + unitDepth + corridor;
      let cx = run.x;
      for (const u of fillRun(run.w, unitDepth, seq, cursor, avgW)) {
        units.push({ rect: { x: cx, y, w: u.width, h: unitDepth }, type: u.key });
        cx += u.width;
      }
    }
  }
  return { units, cores, unitDepth };
}

// Split one horizontal span into bars respecting min/max length.
function barsInSpan(span, depth, y, t, p) {
  const [x0, x1] = span;
  const usable = x1 - x0;
  if (usable < p.minBarLength) return [];
  const sep = p.buildingSeparation;
  let n = Math.max(1, Math.ceil((usable + sep) / (p.maxBarLength + sep)));
  while (n > 1 && (usable - (n - 1) * sep) / n < p.minBarLength) n -= 1;
  const len = (usable - (n - 1) * sep) / n;
  if (len < p.minBarLength) return [];
  const bars = [];
  for (let i = 0; i < n; i++) {
    bars.push({ x: x0 + i * (len + sep), y, w: len, h: depth });
  }
  return bars;
}

// Fill one parking band with a double-loaded bay: stalls, aisle, stalls.
function stallsInSpan(span, y, depth) {
  const [x0, x1] = span;
  const w = x1 - x0;
  const stalls = [];
  const aisles = [];
  if (w < PARKING.stallWidth * 2) return { stalls, aisles };

  const rows = [];
  if (depth >= PARKING.bayDepth - 1) {
    rows.push(y, y + depth - PARKING.stallDepth);
    aisles.push({ x: x0, y: y + PARKING.stallDepth, w, h: depth - PARKING.stallDepth * 2 });
  } else if (depth >= PARKING.stallDepth + 20) {
    rows.push(y);
    aisles.push({ x: x0, y: y + PARKING.stallDepth, w, h: depth - PARKING.stallDepth });
  } else {
    aisles.push({ x: x0, y, w, h: depth });
    return { stalls, aisles };
  }

  const count = Math.floor(w / PARKING.stallWidth);
  const pad = (w - count * PARKING.stallWidth) / 2;
  for (const ry of rows) {
    for (let i = 0; i < count; i++) {
      stalls.push({
        x: x0 + pad + i * PARKING.stallWidth,
        y: ry,
        w: PARKING.stallWidth,
        h: PARKING.stallDepth,
      });
    }
  }
  return { stalls, aisles };
}

// ---------------------------------------------------------------------------
// residential bar-and-bay solver
// ---------------------------------------------------------------------------

function buildRowPlan(nBuildings, nParking, barD, bayD, bandH) {
  const total = nBuildings * barD + nParking * bayD;
  const gaps = nBuildings + nParking - 1;
  if (gaps < 0) return null;
  if (total + gaps * ROW_GAP > bandH) return null;
  const slack = bandH - total - gaps * ROW_GAP;
  const extra = gaps > 0 ? Math.min(slack / gaps, 30) : 0;

  // Interleave so parking bays sit between building bars wherever possible.
  const order = [];
  let b = nBuildings;
  let s = nParking;
  const startWithBuilding = nBuildings >= nParking;
  let turn = startWithBuilding;
  while (b > 0 || s > 0) {
    if (turn && b > 0) { order.push('B'); b -= 1; turn = false; }
    else if (!turn && s > 0) { order.push('P'); s -= 1; turn = true; }
    else if (b > 0) { order.push('B'); b -= 1; }
    else { order.push('P'); s -= 1; }
  }

  const rows = [];
  let y = slack > extra * gaps ? (bandH - (total + gaps * (ROW_GAP + extra))) / 2 : 0;
  order.forEach((kind, i) => {
    const h = kind === 'B' ? barD : bayD;
    rows.push({ kind, y, h });
    y += h + (i < order.length - 1 ? ROW_GAP + extra : 0);
  });
  return rows;
}

function evaluateRows(local, rows, minY, t, p, seq) {
  const buildings = [];
  const stalls = [];
  const aisles = [];
  for (const row of rows) {
    const y0 = minY + row.y;
    const y1 = y0 + row.h;
    const spans = bandSpans(local, y0, y1);
    for (const span of spans) {
      if (row.kind === 'B') {
        for (const bar of barsInSpan(span, row.h, y0, t, p)) buildings.push(bar);
      } else {
        const r = stallsInSpan(span, y0, row.h);
        stalls.push(...r.stalls);
        aisles.push(...r.aisles);
      }
    }
  }
  return { buildings, stalls, aisles };
}

function residentialScheme(local, t, p) {
  const bb = bbox(local);
  const bandH = bb.h;
  const barD = p.barDepth;
  // Townhomes are served by a shallower rear alley than a full parking bay.
  const bayD = t.stacked === false ? (t.alleyDepth ?? PARKING.bayDepth) : PARKING.bayDepth;
  const seq = mixSequence(p.mix);

  const maxB = Math.max(0, Math.floor((bandH + ROW_GAP) / (barD + ROW_GAP)));
  const candidates = [];
  for (let b = maxB; b >= 1; b--) {
    // Every building row has to sit against a drive, so the rows interleave.
    for (let s = Math.max(0, b - 1); s <= maxB + 2; s++) {
      const rows = buildRowPlan(b, s, barD, bayD, bandH);
      if (!rows) continue;
      candidates.push(rows);
    }
  }
  if (!candidates.length) {
    const rows = buildRowPlan(1, 0, barD, bayD, bandH);
    if (rows) candidates.push(rows);
  }

  let best = null;
  for (const rows of candidates) {
    const res = evaluateRows(local, rows, bb.minY, t, p, seq);
    if (!res.buildings.length) continue;
    const gsfPerFloor = res.buildings.reduce((s, b) => s + b.w * b.h, 0);
    const stacked = t.stacked !== false;
    const approxUnits = stacked
      ? Math.round((gsfPerFloor * p.floors * t.grossToNet) / avgUnitArea(p.mix))
      : Math.round(gsfPerFloor / ((t.unitWidth || 22) * p.barDepth));
    const need = approxUnits * p.parkingRatio;
    // Townhomes bring their own garages, so those count toward the demand.
    const have = res.stalls.length
      + approxUnits * (t.garageStallsPerUnit || 0)
      + (t.parkingType !== 'surface' ? Infinity : 0);
    const shortfall = Math.max(0, need - have);
    const score = approxUnits - shortfall * 2.2;
    if (!best || score > best.score) best = { rows, res, score, approxUnits };
  }
  if (!best) return { buildings: [], stalls: [], aisles: [], units: [], cores: [] };

  const cursor = { i: 0 };
  const buildings = best.res.buildings.map((bar, idx) => {
    const { units, cores, unitDepth } = layoutUnits(bar, t, p, seq, cursor);
    return {
      id: `B${idx + 1}`,
      rect: bar,
      poly: rectPoly(bar.x, bar.y, bar.w, bar.h),
      floors: p.floors,
      height: p.floors * t.floorToFloor,
      footprint: bar.w * bar.h,
      gsf: bar.w * bar.h * p.floors,
      units: units.map((u) => ({ ...u, poly: rectPoly(u.rect.x, u.rect.y, u.rect.w, u.rect.h) })),
      cores: cores.map((c) => rectPoly(c.x, c.y, c.w, c.h)),
      unitDepth,
      unitCount: units.length * (t.stacked === false ? 1 : p.floors),
      kind: 'residential',
    };
  });

  return {
    buildings,
    stalls: best.res.stalls,
    aisles: best.res.aisles,
  };
}

function avgUnitArea(mix) {
  const total = UNIT_TYPES.reduce((s, u) => s + (mix[u.key] || 0), 0) || 1;
  return UNIT_TYPES.reduce((s, u) => s + ((mix[u.key] || 0) / total) * u.area, 0);
}

// ---------------------------------------------------------------------------
// wrap / podium (single block around structured parking)
// ---------------------------------------------------------------------------

// Subdivide the band between two concentric rings into units. Along each edge
// the band is a true rectangle, so the units are rectangles too; the mitred
// wedge left at every corner becomes a stair/elevator core, which is where a
// wrap building puts them anyway. Returns null if the rings do not correspond
// vertex-for-vertex.
function ringBandUnits(outer, inner, depth, seq, cursor, avgW, coreEvery) {
  if (!outer || !inner || outer.length !== inner.length || outer.length < 3) return null;
  const units = [];
  const cores = [];
  let sinceCore = 0;
  const n = outer.length;
  for (let i = 0; i < n; i++) {
    const a = outer[i];
    const b = outer[(i + 1) % n];
    const a2 = inner[i];
    const b2 = inner[(i + 1) % n];
    const len = V.dist(a, b);
    if (len < 1) continue;
    const u = V.norm(V.sub(b, a));
    const nrm = { x: -u.y, y: u.x }; // points into the band
    const at = (s, d) => ({ x: a.x + u.x * s + nrm.x * d, y: a.y + u.y * s + nrm.y * d });

    // Where the inner corners project onto this edge bounds the square part.
    const s0 = Math.max(0, V.dot(V.sub(a2, a), u));
    const s1 = Math.min(len, V.dot(V.sub(b2, a), u));
    if (s0 > 0.5) cores.push([a, at(s0, 0), a2]);
    if (s1 < len - 0.5) cores.push([at(s1, 0), b, b2]);

    const run = s1 - s0;
    const count = Math.round(run / avgW);
    if (count < 1) continue;
    const w = run / count;
    for (let k = 0; k < count; k++) {
      const quad = [at(s0 + k * w, 0), at(s0 + (k + 1) * w, 0), at(s0 + (k + 1) * w, depth), at(s0 + k * w, depth)];
      sinceCore += w;
      if (coreEvery > 0 && sinceCore >= coreEvery) {
        sinceCore = 0;
        cores.push(quad);
      } else {
        units.push({ poly: quad, type: seq[cursor.i++ % seq.length] });
      }
    }
  }
  return { units, cores };
}

function wrapScheme(local, t, p) {
  // Hold the block off the setback line so there is a fire lane all round.
  const drive = t.perimeterDrive ?? 0;
  const outer = drive > 0 ? (offsetPolygon(local, drive) || []) : local;
  if (outer.length < 3) return { buildings: [], stalls: [], aisles: [] };

  // offsetRing keeps the vertex count so the ring can be cut into unit quads.
  // It returns null when the courtyard would collapse; try a shallower wing
  // before giving up, since a thinner ring is still a wrap.
  let barDepth = p.barDepth;
  let inner = offsetRing(outer, barDepth);
  while (!inner && barDepth > 44) {
    barDepth -= 4;
    inner = offsetRing(outer, barDepth);
  }
  if (!inner) {
    // No courtyard fits: this parcel wants bars and a surface lot, not a wrap.
    return {
      ...residentialScheme(local, { ...t, parkingType: 'surface' }, p),
      note: 'Parcel is too tight for a courtyard — massed as bars with surface parking.',
    };
  }

  const seq = mixSequence(p.mix);
  const ringArea = area(outer) - area(inner);
  const half = offsetRing(outer, barDepth / 2);
  const centreline = perimeter(half || outer);

  const unitDepth = (barDepth - t.corridorWidth) / 2;
  const avgW = avgUnitArea(p.mix) / unitDepth;

  // Draw the ring as two bands of units either side of a loop corridor.
  const cursor = { i: 0 };
  const units = [];
  const cores = [];
  const midOut = offsetRing(outer, unitDepth);
  const midIn = offsetRing(outer, unitDepth + t.corridorWidth);
  for (const band of [
    ringBandUnits(outer, midOut, unitDepth, seq, cursor, avgW, t.coreEvery),
    ringBandUnits(midIn, inner, unitDepth, seq, cursor, avgW, t.coreEvery),
  ]) {
    if (!band) continue;
    units.push(...band.units);
    cores.push(...band.cores);
  }

  // Fall back to a parametric count when the ring could not be subdivided.
  const nCores = Math.max(2, Math.round(centreline / t.coreEvery));
  const usable = Math.max(0, centreline - nCores * t.coreWidth);
  const perFloor = units.length || Math.floor((usable * 2) / avgW);
  const unitCount = perFloor * p.floors;

  const building = {
    id: 'B1',
    poly: outer,
    hole: inner,
    floors: p.floors,
    height: p.floors * t.floorToFloor,
    footprint: ringArea,
    gsf: ringArea * p.floors,
    units,
    cores,
    unitCount,
    kind: 'residential',
  };

  // Size the deck to the demand instead of filling every level it could have.
  const required = Math.ceil(unitCount * p.parkingRatio);
  const deck = (poly, maxLevels, podium) => {
    if (!poly || poly.length < 3) return null;
    const perLevel = Math.floor(area(poly) / PARKING.gsfPerStructuredStall);
    if (perLevel < 1) return null;
    const levels = Math.max(1, Math.min(maxLevels, Math.ceil(required / perLevel)));
    return {
      poly,
      levels,
      podium: !!podium,
      gsf: area(poly) * levels,
      stalls: perLevel * levels,
    };
  };

  let garage = null;
  const stalls = [];
  if (t.parkingType === 'structured') {
    garage = deck(offsetPolygon(inner, t.garageSetback ?? 10), Math.min(t.garageLevels ?? 5, p.floors), false);
  }
  if (t.parkingType === 'podium') {
    garage = deck(outer, t.podiumLevels ?? 2, true);
  }

  return { buildings: [building], stalls, aisles: [], garage };
}

// ---------------------------------------------------------------------------
// industrial
// ---------------------------------------------------------------------------

function industrialScheme(local, t, p) {
  const bb = bbox(local);
  const truck = t.truckCourtDepth;
  const parkBand = PARKING.bayDepth;
  const available = bb.h - truck - parkBand - ROW_GAP * 2;
  const depth = Math.max(120, Math.min(p.barDepth, available));
  if (available < 120) {
    return { buildings: [], stalls: [], aisles: [], truckCourt: null, trailers: [] };
  }

  // Box sits against the rear, truck court in front of it, autos at the street.
  const boxY = bb.minY + parkBand + ROW_GAP + truck + ROW_GAP;
  const spans = bandSpans(local, boxY, boxY + depth);
  const span = spans.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0];
  if (!span) return { buildings: [], stalls: [], aisles: [], truckCourt: null, trailers: [] };
  const len = Math.min(span[1] - span[0], p.maxBarLength);
  const x0 = span[0] + ((span[1] - span[0]) - len) / 2;
  const rect = { x: x0, y: boxY, w: len, h: depth };

  const docks = [];
  const dockCount = Math.max(2, Math.floor(len / t.dockDoorEvery));
  const dockPad = (len - dockCount * 10) / (dockCount + 1);
  for (let i = 0; i < dockCount; i++) {
    const dx = x0 + dockPad + i * (10 + dockPad);
    docks.push(rectPoly(dx, boxY - 1.5, 10, 3));
  }

  const courtY = bb.minY + parkBand + ROW_GAP;
  const courtSpans = bandSpans(local, courtY, courtY + truck);
  const truckCourt = courtSpans.map((s) => rectPoly(s[0], courtY, s[1] - s[0], truck));
  const trailers = [];
  const ts = t.trailerStall;
  for (const s of courtSpans) {
    const n = Math.floor((s[1] - s[0]) / ts.w);
    for (let i = 0; i < n; i++) {
      trailers.push(rectPoly(s[0] + i * ts.w, courtY + truck - ts.d, ts.w, ts.d));
    }
  }

  const stalls = [];
  const aisles = [];
  for (const s of bandSpans(local, bb.minY, bb.minY + parkBand)) {
    const r = stallsInSpan(s, bb.minY, parkBand);
    stalls.push(...r.stalls);
    aisles.push(...r.aisles);
  }

  const gsf = rect.w * rect.h;
  const building = {
    id: 'B1',
    rect,
    poly: rectPoly(rect.x, rect.y, rect.w, rect.h),
    floors: 1,
    height: t.floorToFloor,
    footprint: gsf,
    gsf,
    units: [],
    cores: [],
    docks,
    office: rectPoly(rect.x, rect.y + rect.h - 60, Math.min(140, rect.w), 60),
    kind: 'industrial',
  };
  return { buildings: [building], stalls, aisles, truckCourt, trailers };
}

// ---------------------------------------------------------------------------
// retail
// ---------------------------------------------------------------------------

function retailScheme(local, t, p) {
  const bb = bbox(local);
  const depth = p.barDepth;

  // Slide the shop band forward off the rear property line and keep whichever
  // position gives the most storefront — a slanted rear edge otherwise leaves
  // almost nothing to build on.
  let shopY = bb.maxY - depth;
  let spans = bandSpans(local, shopY, bb.maxY);
  let bestFrontage = spans.reduce((s, sp) => s + (sp[1] - sp[0]), 0);
  for (let back = 10; back <= Math.min(220, bb.h - depth - PARKING.bayDepth); back += 10) {
    const y = bb.maxY - depth - back;
    const cand = bandSpans(local, y, y + depth);
    const frontage = cand.reduce((s, sp) => s + (sp[1] - sp[0]), 0);
    if (frontage > bestFrontage * 1.05) {
      bestFrontage = frontage;
      shopY = y;
      spans = cand;
    }
  }

  const buildings = [];
  spans.forEach((span, i) => {
    for (const bar of barsInSpan(span, depth, shopY, t, p)) {
      const bays = Math.max(1, Math.round(bar.w / t.bayWidth));
      const bw = bar.w / bays;
      const tenants = [];
      for (let b = 0; b < bays; b++) {
        tenants.push(rectPoly(bar.x + b * bw, bar.y, bw, bar.h));
      }
      buildings.push({
        id: `SHOPS-${buildings.length + 1}`,
        rect: bar,
        poly: rectPoly(bar.x, bar.y, bar.w, bar.h),
        floors: 1,
        height: t.floorToFloor,
        footprint: bar.w * bar.h,
        gsf: bar.w * bar.h,
        units: [],
        cores: [],
        tenants,
        kind: 'retail',
      });
    }
  });

  // Parking field: stack bays from the front setback up to the shop line,
  // stopping once the ratio is satisfied rather than paving the whole parcel.
  const stalls = [];
  const aisles = [];
  const shopGsf = buildings.reduce((s, b) => s + b.gsf, 0);
  const wanted = Math.ceil((shopGsf / 1000) * p.parkingRatio * 1.08);
  // Bays start against the storefronts and work out toward the street, so any
  // land the ratio does not need is left at the front for outparcels.
  let y = shopY - ROW_GAP * 2 - PARKING.bayDepth;
  while (y >= bb.minY && stalls.length < wanted) {
    for (const span of bandSpans(local, y, y + PARKING.bayDepth)) {
      const r = stallsInSpan(span, y, PARKING.bayDepth);
      stalls.push(...r.stalls);
      aisles.push(...r.aisles);
    }
    y -= PARKING.bayDepth + ROW_GAP;
  }

  // Pad sites along the street frontage.
  const pads = [];
  const padSpans = bandSpans(local, bb.minY, bb.minY + t.padSize.d);
  const widest = padSpans.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0];
  if (widest && p.padSites !== 0) {
    const n = Math.min(t.padSites, Math.floor((widest[1] - widest[0]) / (t.padSize.w + 60)));
    const gap = n > 0 ? ((widest[1] - widest[0]) - n * t.padSize.w) / (n + 1) : 0;
    for (let i = 0; i < n; i++) {
      const px = widest[0] + gap + i * (t.padSize.w + gap);
      pads.push({
        poly: rectPoly(px, bb.minY, t.padSize.w, t.padSize.d),
        gsf: t.padSize.w * t.padSize.d,
      });
    }
  }

  return { buildings, stalls, aisles, pads };
}

// ---------------------------------------------------------------------------
// main entry point
// ---------------------------------------------------------------------------

export function generate(sitePolygon, params) {
  const t = TYPOLOGIES[params.typology];
  const p = params;
  const site = ensureCCW(sitePolygon);
  const siteArea = area(site);
  const warnings = [];

  const dists = setbackDistances(site, p.frontageEdge, p.setbacks);
  let buildable = offsetPolygonPerEdge(site, dists);
  if (buildable.length < 3) {
    warnings.push('Setbacks consume the whole parcel — nothing left to build on.');
    return emptyScene(site, siteArea, warnings, p, t);
  }

  let axis;
  if (p.axisMode === 'longest') axis = longestEdgeAngle(site);
  else if (p.axisMode === 'manual') axis = 0;
  else axis = edgeAngle(site, p.frontageEdge);
  axis += (p.rotation * Math.PI) / 180;

  const origin = centroid(site);
  const local = rotatePoly(buildable, -axis, origin);

  let scheme;
  if (t.key === 'industrial') scheme = industrialScheme(local, t, p);
  else if (t.key === 'retail') scheme = retailScheme(local, t, p);
  else if (t.key === 'wrap' || t.key === 'podium') scheme = wrapScheme(local, t, p);
  else scheme = residentialScheme(local, t, p);

  const toWorld = (poly) => rotatePoly(poly, axis, origin);
  const buildings = (scheme.buildings || []).map((b) => ({
    ...b,
    poly: toWorld(b.poly),
    hole: b.hole ? toWorld(b.hole) : null,
    units: (b.units || []).map((u) => ({ ...u, poly: toWorld(u.poly) })),
    cores: (b.cores || []).map(toWorld),
    tenants: (b.tenants || []).map(toWorld),
    docks: (b.docks || []).map(toWorld),
    office: b.office ? toWorld(b.office) : null,
  }));
  const stalls = (scheme.stalls || []).map((s) => toWorld(rectPoly(s.x, s.y, s.w, s.h)));
  const aisles = (scheme.aisles || []).map((s) => toWorld(rectPoly(s.x, s.y, s.w, s.h)));
  const pads = (scheme.pads || []).map((pd) => ({ ...pd, poly: toWorld(pd.poly) }));
  const truckCourt = (scheme.truckCourt || []).map(toWorld);
  const trailers = (scheme.trailers || []).map(toWorld);
  const garage = scheme.garage
    ? { ...scheme.garage, poly: toWorld(scheme.garage.poly) }
    : null;

  if (scheme.note) warnings.push(scheme.note);

  const metrics = computeMetrics({
    t, p, site, siteArea, buildable, buildings, stalls, pads, garage, trailers, warnings,
  });

  return {
    typology: t.key,
    site,
    buildable,
    axis,
    origin,
    buildings,
    stalls,
    aisles,
    pads,
    truckCourt,
    trailers,
    garage,
    metrics,
    warnings,
  };
}

function emptyScene(site, siteArea, warnings, p, t) {
  return {
    typology: t.key,
    site,
    buildable: [],
    axis: 0,
    origin: centroid(site),
    buildings: [],
    stalls: [],
    aisles: [],
    pads: [],
    truckCourt: [],
    trailers: [],
    garage: null,
    warnings,
    metrics: computeMetrics({
      t, p, site, siteArea, buildable: [], buildings: [], stalls: [], pads: [],
      garage: null, trailers: [], warnings,
    }),
  };
}

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

function computeMetrics({ t, p, site, siteArea, buildable, buildings, stalls, pads, garage, trailers, warnings }) {
  const footprint = buildings.reduce((s, b) => s + b.footprint, 0)
    + pads.reduce((s, pd) => s + pd.gsf, 0);
  const gsf = buildings.reduce((s, b) => s + b.gsf, 0) + pads.reduce((s, pd) => s + pd.gsf, 0);
  const residential = t.family === 'residential';

  // Unit counts and areas come from the drawn plan wherever there is one, so
  // the metrics and the pro forma describe the same building.
  let units = 0;
  const mixCount = { studio: 0, one: 0, two: 0, three: 0 };
  const mixArea = { studio: 0, one: 0, two: 0, three: 0 };
  if (residential) {
    // A stacked building repeats its plate on every floor; a townhome is one
    // dwelling that owns all of its floors.
    const stacked = t.stacked !== false;
    const perFloor = stacked ? p.floors : 1;
    const areaMult = stacked ? p.floors : p.floors * t.grossToNet;
    for (const b of buildings) {
      if (b.units && b.units.length) {
        for (const u of b.units) {
          mixCount[u.type] += perFloor;
          mixArea[u.type] += area(u.poly) * areaMult;
        }
        units += b.units.length * perFloor;
      } else if (b.unitCount) {
        units += b.unitCount;
      }
    }
    if (units && !Object.values(mixCount).some(Boolean)) {
      // Ring schemes are counted parametrically; split them by the target mix.
      const total = UNIT_TYPES.reduce((s, u) => s + (p.mix[u.key] || 0), 0) || 1;
      UNIT_TYPES.forEach((u) => {
        mixCount[u.key] = Math.round(units * ((p.mix[u.key] || 0) / total));
        mixArea[u.key] = mixCount[u.key] * u.area;
      });
    }
  }

  const nsf = residential
    ? UNIT_TYPES.reduce((s, u) => s + mixArea[u.key], 0)
    : gsf * t.grossToNet;

  const surfaceStalls = stalls.length;
  const structuredStalls = garage ? garage.stalls : 0;
  const garageStalls = units * (t.garageStallsPerUnit || 0);
  const totalStalls = surfaceStalls + structuredStalls + garageStalls;

  let requiredStalls;
  if (t.parkingBasis === 'per1000') requiredStalls = Math.ceil((gsf / 1000) * p.parkingRatio);
  else requiredStalls = Math.ceil(units * p.parkingRatio);

  const acres = siteArea / SQFT_PER_ACRE;
  const far = siteArea > 0 ? gsf / siteArea : 0;
  const coverage = siteArea > 0 ? footprint / siteArea : 0;
  const openSpace = Math.max(
    0,
    siteArea - footprint - totalStallsToArea(surfaceStalls) - trailers.length * 12 * 53,
  );

  if (requiredStalls > totalStalls) {
    warnings.push(`Parking short by ${requiredStalls - totalStalls} stalls at the current ratio.`);
  }
  if (coverage > p.maxCoverage) {
    warnings.push(`Coverage ${(coverage * 100).toFixed(0)}% exceeds the ${(p.maxCoverage * 100).toFixed(0)}% limit.`);
  }
  if (far > p.maxFar) {
    warnings.push(`FAR ${far.toFixed(2)} exceeds the ${p.maxFar.toFixed(2)} limit.`);
  }
  const height = buildings.length ? Math.max(...buildings.map((b) => b.height)) : 0;
  if (height > p.maxHeight) {
    warnings.push(`Height ${height.toFixed(0)}' exceeds the ${p.maxHeight}' limit.`);
  }

  return {
    siteArea,
    acres,
    buildableArea: buildable.length ? area(buildable) : 0,
    footprint,
    gsf,
    nsf,
    efficiency: gsf > 0 ? nsf / gsf : 0,
    units,
    mixCount,
    mixArea,
    density: acres > 0 ? units / acres : 0,
    far,
    coverage,
    height,
    floors: p.floors,
    surfaceStalls,
    structuredStalls,
    garageStalls,
    totalStalls,
    requiredStalls,
    parkingRatioAchieved: units > 0 ? totalStalls / units : 0,
    stallsPer1000: gsf > 0 ? (totalStalls / gsf) * 1000 : 0,
    openSpace,
    openSpacePct: siteArea > 0 ? openSpace / siteArea : 0,
    buildingCount: buildings.length + pads.length,
  };
}

// Surface stalls plus their share of drive aisle, as a paved-area estimate.
function totalStallsToArea(stallCount) {
  const perStall = PARKING.stallWidth * PARKING.stallDepth * 1.6;
  return stallCount * perStall;
}
