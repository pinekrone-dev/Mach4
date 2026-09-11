// Headless check of the geometry, massing and pro forma modules.
// Run with: node tools/smoke.mjs

import assert from 'node:assert/strict';
import {
  area, offsetPolygon, offsetPolygonPerEdge, pointInPolygon, bandSpans,
  scanSpans, ensureCCW, centroid, rectPoly, clipToConvex, removeLoops,
} from '../src/geometry.js';
import { TYPOLOGIES, TYPOLOGY_LIST, defaultParams } from '../src/typologies.js';
import { generate, mixSequence, setbackDistances } from '../src/generator.js';
import { runProforma, sensitivity } from '../src/proforma.js';
import { PRESETS, parcelFromAcres } from '../src/sites.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

console.log('\ngeometry');

test('area of a 100x200 rectangle is 20,000 sf', () => {
  assert.equal(area(rectPoly(0, 0, 100, 200)), 20000);
});

test('ensureCCW flips a clockwise ring', () => {
  const cw = [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 0 }];
  const ccw = ensureCCW(cw);
  assert.ok(area(ccw) > 0);
  assert.notDeepEqual(ccw, cw);
});

test('uniform inward offset shrinks a rectangle correctly', () => {
  const out = offsetPolygon(rectPoly(0, 0, 200, 300), 25);
  assert.equal(Math.round(area(out)), 150 * 250);
});

test('per-edge offset applies different setbacks', () => {
  const poly = rectPoly(0, 0, 200, 300);
  const out = offsetPolygonPerEdge(poly, [30, 10, 20, 10]);
  assert.equal(Math.round(area(out)), 180 * 250);
});

test('an over-large offset collapses to nothing', () => {
  assert.equal(offsetPolygon(rectPoly(0, 0, 50, 50), 40).length, 0);
});

test('offset survives a concave (L-shaped) parcel', () => {
  const L = [
    { x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 200 },
    { x: 200, y: 200 }, { x: 200, y: 400 }, { x: 0, y: 400 },
  ];
  const out = offsetPolygon(L, 20);
  assert.ok(out.length >= 5, `expected a concave result, got ${out.length} vertices`);
  assert.ok(area(out) < area(L) && area(out) > area(L) * 0.6);
  assert.ok(pointInPolygon(centroid(out), L));
});

test('removeLoops discards a self-crossing lobe', () => {
  const bowtie = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }];
  assert.ok(removeLoops(bowtie).length >= 3);
});

test('scanSpans finds the interior of a notched polygon', () => {
  const notched = [
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 },
    { x: 60, y: 100 }, { x: 60, y: 40 }, { x: 40, y: 40 }, { x: 40, y: 100 }, { x: 0, y: 100 },
  ];
  const spans = scanSpans(ensureCCW(notched), 70);
  assert.equal(spans.length, 2);
});

test('bandSpans only returns fully-contained bands', () => {
  const tri = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 0, y: 200 }];
  const low = bandSpans(ensureCCW(tri), 0, 20);
  const high = bandSpans(ensureCCW(tri), 180, 200);
  assert.ok(low[0][1] - low[0][0] > high.reduce((s, x) => s + (x[1] - x[0]), 0));
});

test('clipToConvex trims a rectangle to a smaller box', () => {
  const clipped = clipToConvex(rectPoly(0, 0, 100, 100), rectPoly(25, 25, 50, 50));
  assert.equal(Math.round(area(clipped)), 2500);
});

console.log('\nprogram');

test('mixSequence honours the requested proportions', () => {
  const seq = mixSequence({ studio: 0, one: 50, two: 50, three: 0 }, 20);
  const ones = seq.filter((k) => k === 'one').length;
  assert.equal(seq.length, 20);
  assert.ok(Math.abs(ones - 10) <= 1);
  assert.equal(seq.filter((k) => k === 'three').length, 0);
});

test('setbackDistances classifies front, side and rear', () => {
  const poly = ensureCCW(rectPoly(0, 0, 200, 300));
  const d = setbackDistances(poly, 0, { front: 25, side: 10, rear: 40 });
  assert.equal(d[0], 25);
  assert.equal(d[2], 40);
  assert.equal(d[1], 10);
  assert.equal(d[3], 10);
});

console.log('\nmassing');

const parcel = PRESETS[0].polygon;

test('garden scheme produces buildings, units and parking', () => {
  const scene = generate(parcel, defaultParams('garden'));
  assert.ok(scene.buildings.length >= 2, `expected several bars, got ${scene.buildings.length}`);
  assert.ok(scene.metrics.units > 50, `expected >50 units, got ${scene.metrics.units}`);
  assert.ok(scene.stalls.length > 50, `expected a parking field, got ${scene.stalls.length}`);
  assert.ok(scene.metrics.density > 10 && scene.metrics.density < 120);
});

test('every building sits inside the setback envelope', () => {
  const scene = generate(parcel, defaultParams('garden'));
  for (const b of scene.buildings) {
    for (const v of b.poly) {
      assert.ok(pointInPolygon(v, scene.site), `building corner ${JSON.stringify(v)} escaped the parcel`);
    }
  }
});

test('units stay inside their own building footprint', () => {
  const scene = generate(parcel, defaultParams('garden'));
  const b = scene.buildings[0];
  const total = b.units.reduce((s, u) => s + area(u.poly), 0);
  assert.ok(total <= b.footprint * 1.001, 'unit areas exceed the floorplate');
  assert.ok(total > b.footprint * 0.55, 'unit layout leaves too much dead floorplate');
});

test('more floors means more units and more gross area', () => {
  const a = generate(parcel, { ...defaultParams('garden'), floors: 2 });
  const b = generate(parcel, { ...defaultParams('garden'), floors: 4 });
  assert.ok(b.metrics.units > a.metrics.units);
  assert.ok(b.metrics.gsf > a.metrics.gsf);
});

test('tighter setbacks yield at least as much buildable area', () => {
  const tight = generate(parcel, { ...defaultParams('garden'), setbacks: { front: 10, side: 5, rear: 10 } });
  const loose = generate(parcel, { ...defaultParams('garden'), setbacks: { front: 60, side: 50, rear: 60 } });
  assert.ok(tight.metrics.buildableArea > loose.metrics.buildableArea);
});

test('every typology generates something on every preset parcel', () => {
  for (const t of TYPOLOGY_LIST) {
    for (const preset of PRESETS) {
      const params = defaultParams(t.key);
      params.frontageEdge = preset.frontageEdge;
      const scene = generate(preset.polygon, params);
      assert.ok(Number.isFinite(scene.metrics.gsf), `${t.key}/${preset.key} produced a non-finite gsf`);
      assert.ok(scene.metrics.gsf >= 0);
      if (t.key !== 'industrial' || preset.key === 'industrial') {
        assert.ok(scene.metrics.gsf > 0, `${t.key} produced nothing on ${preset.key}`);
      }
    }
  }
});

test('industrial box comes with a truck court and docks', () => {
  const scene = generate(PRESETS[4].polygon, defaultParams('industrial'));
  assert.equal(scene.buildings.length, 1);
  assert.ok(scene.truckCourt.length > 0);
  assert.ok(scene.buildings[0].docks.length > 4);
  assert.ok(scene.trailers.length > 10);
});

test('retail scheme lays out shops, pads and a parking field', () => {
  const scene = generate(parcel, defaultParams('retail'));
  assert.ok(scene.buildings.length >= 1);
  assert.ok(scene.stalls.length > 40);
  assert.ok(scene.metrics.stallsPer1000 > 2);
});

test('wrap scheme puts a deck inside the ring', () => {
  const scene = generate(PRESETS[2].polygon, defaultParams('wrap'));
  assert.ok(scene.garage, 'expected a structured deck');
  assert.ok(scene.garage.stalls > 100);
  assert.ok(scene.metrics.units > 100);
  assert.ok(scene.buildings[0].hole, 'wrap should be a ring, not a solid block');
});

test('setbacks swallowing the parcel is reported, not crashed', () => {
  const scene = generate(rectPoly(0, 0, 60, 60), {
    ...defaultParams('garden'),
    setbacks: { front: 40, side: 40, rear: 40 },
  });
  assert.equal(scene.buildings.length, 0);
  assert.ok(scene.warnings.length > 0);
  assert.equal(scene.metrics.units, 0);
});

test('a degenerate sliver parcel does not throw', () => {
  const scene = generate(rectPoly(0, 0, 800, 12), defaultParams('garden'));
  assert.ok(Number.isFinite(scene.metrics.gsf));
});

console.log('\npro forma');

test('residential pro forma is internally consistent', () => {
  const params = defaultParams('garden');
  const scene = generate(parcel, params);
  const pf = runProforma(scene, params);
  assert.ok(pf.cost.total > pf.cost.hard);
  assert.ok(pf.revenue.egi < pf.revenue.gpr + pf.revenue.other);
  assert.equal(
    Math.round(pf.revenue.noi),
    Math.round(pf.revenue.egi - pf.revenue.opex),
  );
  assert.ok(pf.returns.yieldOnCost > 0 && pf.returns.yieldOnCost < 0.5);
  assert.equal(
    Math.round(pf.returns.stabilizedValue),
    Math.round(pf.revenue.noi / pf.returns.capRate),
  );
});

test('commercial pro forma runs on NNN rent', () => {
  const params = defaultParams('industrial');
  const scene = generate(PRESETS[4].polygon, params);
  const pf = runProforma(scene, params);
  assert.equal(pf.revenue.rentRoll.length, 1);
  assert.ok(pf.revenue.gpr > 1e6);
  assert.ok(pf.returns.yieldOnCost > 0);
});

test('townhome scheme carries a for-sale analysis', () => {
  const params = defaultParams('townhome');
  const scene = generate(parcel, params);
  const pf = runProforma(scene, params);
  assert.ok(pf.forSale, 'expected for-sale numbers');
  assert.ok(pf.forSale.grossRevenue > 0);
});

test('higher land price lowers yield on cost', () => {
  const params = defaultParams('garden');
  const scene = generate(parcel, params);
  const cheap = runProforma(scene, { ...params, landPrice: 500_000 });
  const dear = runProforma(scene, { ...params, landPrice: 8_000_000 });
  assert.ok(dear.returns.yieldOnCost < cheap.returns.yieldOnCost);
});

test('sensitivity grid is monotonic in rent and in cost', () => {
  const params = defaultParams('garden');
  const scene = generate(parcel, params);
  const s = sensitivity(scene, JSON.parse(JSON.stringify(params)));
  assert.equal(s.grid.length, 5);
  for (const line of s.grid) {
    for (let i = 1; i < line.length; i++) assert.ok(line[i] > line[i - 1], 'rent should raise yield');
  }
  for (let c = 1; c < s.grid.length; c++) {
    assert.ok(s.grid[c][2] < s.grid[c - 1][2], 'cost should lower yield');
  }
});

test('parcelFromAcres lands within a percent of the target', () => {
  const poly = parcelFromAcres(6);
  assert.ok(Math.abs(area(poly) / 43560 - 6) < 0.06);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
