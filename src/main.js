// App shell: state, panels, canvas interaction, export.

import { TYPOLOGIES, TYPOLOGY_LIST, UNIT_TYPES, defaultParams, PARKING } from './typologies.js';
import { generate } from './generator.js';
import { runProforma, sensitivity } from './proforma.js';
import { View, render, UNIT_COLORS } from './render.js';
import { PRESETS, parcelFromAcres } from './sites.js';
import { area, distanceToSegment, toAcres, ensureCCW, pointInPolygon } from './geometry.js';
import { el, fmt, field, numberInput, sliderInput, selectInput, section, stat, row, downloadBlob, toast } from './ui.js';

const STORAGE_KEY = 'siteplanner.state.v1';

const state = {
  params: defaultParams('garden'),
  polygon: PRESETS[0].polygon.map((p) => ({ ...p })),
  presetKey: 'rect',
  scene: null,
  pf: null,
  editing: true,
  layers: { grid: true, setbacks: true, buildings: true, units: true, parking: true, labels: true, dimensions: true },
  hoverVertex: -1,
  selectedVertex: -1,
  drag: null,
  draw: null, // in-progress parcel outline, see startDraw()
  rightTab: 'metrics',
};

const canvas = document.getElementById('canvas');
const view = new View(canvas);

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      params: state.params, polygon: state.polygon, presetKey: state.presetKey, layers: state.layers,
    }));
  } catch { /* private mode — keep going */ }
}

function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.params && TYPOLOGIES[data.params.typology]) {
      state.params = { ...defaultParams(data.params.typology), ...data.params };
    }
    if (Array.isArray(data.polygon) && data.polygon.length >= 3) state.polygon = data.polygon;
    if (data.presetKey) state.presetKey = data.presetKey;
    if (data.layers) state.layers = { ...state.layers, ...data.layers };
  } catch { /* ignore malformed state */ }
}

// ---------------------------------------------------------------------------
// core loop
// ---------------------------------------------------------------------------

function regenerate({ refit = false, rebuildPanels = false } = {}) {
  const t0 = performance.now();
  state.scene = generate(state.polygon, state.params);
  state.pf = runProforma(state.scene, state.params);
  state.solveMs = performance.now() - t0;
  if (refit) view.fit(state.scene.site);
  if (rebuildPanels) buildLeftPanel();
  paint();
  buildRightPanel();
  buildStatusBar();
  save();
}

function paint() {
  render(view, state.scene, {
    layers: state.layers,
    editing: state.editing,
    hoverVertex: state.hoverVertex,
    selectedVertex: state.selectedVertex,
    frontageEdge: state.params.frontageEdge,
    draft: state.draw,
  });
}

// --- drawing a new parcel from scratch ------------------------------------

function startDraw() {
  state.draw = { points: [], cursor: null };
  state.selectedVertex = -1;
  document.getElementById('btn-draw').classList.add('on');
  canvas.style.cursor = 'crosshair';
  toast('Click to place corners · click the first one or press Enter to close · Esc cancels');
  paint();
}

function cancelDraw() {
  if (!state.draw) return;
  state.draw = null;
  document.getElementById('btn-draw').classList.remove('on');
  canvas.style.cursor = 'default';
  paint();
}

function finishDraw() {
  if (!state.draw) return;
  const pts = state.draw.points;
  if (pts.length < 3) {
    toast('A parcel needs at least three corners', 'warn');
    return;
  }
  state.polygon = ensureCCW(pts);
  state.presetKey = 'custom';
  state.params.frontageEdge = 0;
  state.selectedVertex = -1;
  cancelDraw();
  state.editing = true;
  document.getElementById('btn-edit').classList.add('on');
  regenerate({ refit: true, rebuildPanels: true });
  toast(`Parcel closed — ${state.polygon.length} corners, ${toAcres(area(state.polygon)).toFixed(2)} ac`);
}

function setTypology(key) {
  // Site-level choices carry across a typology switch; the program does not.
  // A typology with its own default mix (townhomes) keeps that mix.
  const keep = {
    setbacks: state.params.setbacks,
    frontageEdge: state.params.frontageEdge,
    landPrice: state.params.landPrice,
    axisMode: state.params.axisMode,
    rotation: state.params.rotation,
  };
  if (!TYPOLOGIES[key].defaultMix) keep.mix = state.params.mix;
  state.params = { ...defaultParams(key), ...keep, typology: key };
  buildTopBar();
  regenerate({ rebuildPanels: true });
}

// ---------------------------------------------------------------------------
// left panel — program inputs
// ---------------------------------------------------------------------------

function buildLeftPanel() {
  const host = document.getElementById('left-panel');
  host.textContent = '';
  const p = state.params;
  const t = TYPOLOGIES[p.typology];

  host.append(section('Site',
    field('Preset parcel', selectInput(state.presetKey,
      [...PRESETS.map((s) => ({ value: s.key, label: s.name })), { value: 'custom', label: 'Custom (edited)' }],
      (v) => {
        const preset = PRESETS.find((s) => s.key === v);
        if (!preset) return;
        state.polygon = preset.polygon.map((q) => ({ ...q }));
        state.presetKey = v;
        state.params.frontageEdge = preset.frontageEdge;
        state.selectedVertex = -1;
        regenerate({ refit: true, rebuildPanels: true });
      })),
    field('Target size', el('div', { class: 'inline' },
      numberInput(+toAcres(area(state.polygon)).toFixed(2), {
        min: 0.1, max: 200, step: 0.1, suffix: 'ac',
        onInput: (v) => {
          state.polygon = parcelFromAcres(v);
          state.presetKey = 'custom';
          regenerate({ refit: true, rebuildPanels: true });
        },
      })), 'resets to a rectangle'),
    field('Frontage edge', el('div', { class: 'inline' },
      el('button', { class: 'mini', onclick: () => cycleFrontage(-1) }, '‹'),
      el('b', { class: 'frontage-readout' }, `Edge ${p.frontageEdge + 1} of ${state.polygon.length}`),
      el('button', { class: 'mini', onclick: () => cycleFrontage(1) }, '›')),
      'click an edge on the plan'),
  ));

  host.append(section('Setbacks',
    field('Front', numberInput(p.setbacks.front, { min: 0, max: 200, suffix: 'ft', onInput: (v) => { p.setbacks.front = v; regenerate(); } })),
    field('Side', numberInput(p.setbacks.side, { min: 0, max: 200, suffix: 'ft', onInput: (v) => { p.setbacks.side = v; regenerate(); } })),
    field('Rear', numberInput(p.setbacks.rear, { min: 0, max: 200, suffix: 'ft', onInput: (v) => { p.setbacks.rear = v; regenerate(); } })),
  ));

  const massing = [
    field('Building axis', selectInput(p.axisMode, [
      { value: 'frontage', label: 'Parallel to frontage' },
      { value: 'longest', label: 'Parallel to longest edge' },
      { value: 'manual', label: 'True north' },
    ], (v) => { p.axisMode = v; regenerate(); })),
    field('Rotation', sliderInput(p.rotation, {
      min: -90, max: 90, step: 1, format: (v) => `${v}°`,
      onInput: (v) => { p.rotation = v; regenerate(); },
    })),
  ];

  if (t.family === 'residential') {
    massing.push(
      field('Floors', sliderInput(p.floors, {
        min: 1, max: t.key === 'townhome' ? 4 : 12, step: 1, format: (v) => `${v}`,
        onInput: (v) => { p.floors = v; regenerate(); },
      })),
      field('Building depth', numberInput(p.barDepth, {
        min: 30, max: 130, suffix: 'ft', onInput: (v) => { p.barDepth = v; regenerate(); },
      }), t.corridorWidth ? 'double-loaded' : 'single row'),
      field('Bar length', el('div', { class: 'inline' },
        numberInput(p.minBarLength, { min: 40, max: 600, suffix: 'min', onInput: (v) => { p.minBarLength = v; regenerate(); } }),
        numberInput(p.maxBarLength, { min: 60, max: 900, suffix: 'max', onInput: (v) => { p.maxBarLength = v; regenerate(); } }))),
      field('Building separation', numberInput(p.buildingSeparation, {
        min: 0, max: 120, suffix: 'ft', onInput: (v) => { p.buildingSeparation = v; regenerate(); },
      })),
    );
  } else {
    massing.push(
      field(t.key === 'industrial' ? 'Box depth' : 'Shop depth', numberInput(p.barDepth, {
        min: 40, max: 600, suffix: 'ft', onInput: (v) => { p.barDepth = v; regenerate(); },
      })),
      field('Max length', numberInput(p.maxBarLength, {
        min: 100, max: 1600, suffix: 'ft', onInput: (v) => { p.maxBarLength = v; regenerate(); },
      })),
    );
  }
  host.append(section('Massing', massing));

  if (t.family === 'residential') {
    host.append(section('Unit mix', buildMixControls()));
  }

  host.append(section('Parking',
    field(t.parkingBasis === 'per1000' ? 'Ratio / 1,000 SF' : 'Stalls per unit',
      sliderInput(p.parkingRatio, {
        min: 0, max: t.parkingBasis === 'per1000' ? 8 : 3, step: 0.05,
        format: (v) => v.toFixed(2),
        onInput: (v) => { p.parkingRatio = v; regenerate(); },
      })),
    el('p', { class: 'note' },
      `${PARKING.stallWidth}' × ${PARKING.stallDepth}' stalls, ${PARKING.aisleWidth}' aisles`,
      t.parkingType !== 'surface' ? ` · ${t.parkingType} deck at ${PARKING.gsfPerStructuredStall} gsf/stall` : ''),
  ));

  host.append(section('Zoning envelope',
    field('Max FAR', numberInput(p.maxFar, { min: 0.1, max: 12, step: 0.05, onInput: (v) => { p.maxFar = v; regenerate(); } })),
    field('Max coverage', numberInput(Math.round(p.maxCoverage * 100), { min: 5, max: 100, suffix: '%', onInput: (v) => { p.maxCoverage = v / 100; regenerate(); } })),
    field('Max height', numberInput(p.maxHeight, { min: 15, max: 400, suffix: 'ft', onInput: (v) => { p.maxHeight = v; regenerate(); } })),
  ));

  host.append(section('Deal basis',
    field('Land price', numberInput(p.landPrice, { min: 0, step: 25000, suffix: '$', onInput: (v) => { p.landPrice = v; regenerate(); } })),
    field('Shell cost', numberInput(p.cost.shellPsf, { min: 20, max: 900, suffix: '$/sf', onInput: (v) => { p.cost.shellPsf = v; regenerate(); } })),
    field('Parking cost', numberInput(p.cost.parkingPerStall, { min: 0, step: 250, suffix: '$/stall', onInput: (v) => { p.cost.parkingPerStall = v; regenerate(); } })),
    field('Soft costs', numberInput(Math.round(p.cost.softPct * 100), { min: 0, max: 60, suffix: '%', onInput: (v) => { p.cost.softPct = v / 100; regenerate(); } })),
    field('Contingency', numberInput(Math.round(p.cost.contingencyPct * 100), { min: 0, max: 30, suffix: '%', onInput: (v) => { p.cost.contingencyPct = v / 100; regenerate(); } })),
    t.family === 'residential'
      ? field('Opex / unit', numberInput(p.ops.opexPerUnit, { min: 0, step: 100, suffix: '$/yr', onInput: (v) => { p.ops.opexPerUnit = v; regenerate(); } }))
      : field('NNN rent', numberInput(p.ops.nnnRentPsf, { min: 1, max: 120, step: 0.25, suffix: '$/sf/yr', onInput: (v) => { p.ops.nnnRentPsf = v; regenerate(); } })),
    field('Vacancy', numberInput(Math.round(p.ops.vacancy * 100), { min: 0, max: 40, suffix: '%', onInput: (v) => { p.ops.vacancy = v / 100; regenerate(); } })),
    field('Exit cap', numberInput(+(p.ops.capRate * 100).toFixed(2), { min: 2, max: 15, step: 0.05, suffix: '%', onInput: (v) => { p.ops.capRate = v / 100; regenerate(); } })),
  ));
}

function cycleFrontage(dir) {
  const n = state.polygon.length;
  state.params.frontageEdge = ((state.params.frontageEdge + dir) % n + n) % n;
  regenerate({ rebuildPanels: true });
}

function buildMixControls() {
  const p = state.params;
  const total = UNIT_TYPES.reduce((s, u) => s + (p.mix[u.key] || 0), 0) || 1;
  const nodes = UNIT_TYPES.map((u) => {
    const pct = ((p.mix[u.key] || 0) / total) * 100;
    return el('div', { class: 'mix-row' },
      el('i', { class: 'swatch', style: { background: UNIT_COLORS[u.key] } }),
      el('span', { class: 'mix-name' }, u.name),
      el('span', { class: 'mix-sf' }, `${u.area} sf`),
      numberInput(p.mix[u.key] || 0, {
        min: 0, max: 100, step: 1,
        onInput: (v) => { p.mix[u.key] = v; regenerate({ rebuildPanels: true }); },
      }),
      el('b', { class: 'mix-pct' }, `${pct.toFixed(0)}%`));
  });
  nodes.push(el('div', { class: 'mix-rents' },
    UNIT_TYPES.map((u) => field(`${u.name} rent`, numberInput(
      (p.rents && p.rents[u.key]) || u.rentPsf,
      {
        min: 0.5, max: 12, step: 0.05, suffix: '$/sf/mo',
        onInput: (v) => { p.rents = { ...(p.rents || {}), [u.key]: v }; regenerate(); },
      },
    )))));
  return nodes;
}

// ---------------------------------------------------------------------------
// right panel — metrics + pro forma
// ---------------------------------------------------------------------------

function buildRightPanel() {
  const host = document.getElementById('right-panel');
  host.textContent = '';
  const tabs = el('div', { class: 'tabs' },
    ['metrics', 'proforma', 'sensitivity'].map((k) => el('button', {
      class: `tab${state.rightTab === k ? ' active' : ''}`,
      onclick: () => { state.rightTab = k; buildRightPanel(); },
    }, k === 'proforma' ? 'Pro forma' : k[0].toUpperCase() + k.slice(1))));
  host.append(tabs);

  if (state.rightTab === 'metrics') host.append(metricsView());
  else if (state.rightTab === 'proforma') host.append(proformaView());
  else host.append(sensitivityView());
}

function metricsView() {
  const m = state.scene.metrics;
  const t = TYPOLOGIES[state.params.typology];
  const residential = t.family === 'residential';
  const wrap = el('div', { class: 'panel-scroll' });

  wrap.append(el('div', { class: 'stat-grid' },
    stat('Site', `${fmt.num(m.acres, 2)} ac`, `${fmt.int(m.siteArea)} sf`),
    stat(residential ? 'Units' : 'Buildings', residential ? fmt.int(m.units) : fmt.int(m.buildingCount),
      residential ? `${fmt.num(m.density, 1)} du/ac` : `${fmt.int(m.footprint)} sf pad`),
    stat('Gross SF', fmt.int(m.gsf), `FAR ${fmt.num(m.far, 2)}`, m.far > state.params.maxFar ? 'bad' : null),
    stat('Parking', fmt.int(m.totalStalls),
      residential ? `${fmt.num(m.parkingRatioAchieved, 2)} / unit` : `${fmt.num(m.stallsPer1000, 2)} / 1,000 sf`,
      m.totalStalls < m.requiredStalls ? 'bad' : 'good'),
  ));

  wrap.append(section('Envelope',
    row('Buildable area', `${fmt.int(m.buildableArea)} sf`),
    row('Footprint', `${fmt.int(m.footprint)} sf`),
    row('Coverage', fmt.pct(m.coverage), m.coverage > state.params.maxCoverage ? 'bad' : null),
    row('Floors / height', `${m.floors} / ${fmt.ft(m.height)}`, m.height > state.params.maxHeight ? 'bad' : null),
    row('Open space', `${fmt.int(m.openSpace)} sf`, null),
    row('Open space share', fmt.pct(m.openSpacePct)),
  ));

  if (residential) {
    const mixRows = UNIT_TYPES.map((u) => {
      const c = m.mixCount[u.key] || 0;
      return row(`${u.name} · ${u.area} sf`, `${fmt.int(c)}  (${m.units ? ((c / m.units) * 100).toFixed(0) : 0}%)`);
    });
    wrap.append(section('Unit mix', mixRows,
      row('Net rentable', `${fmt.int(m.nsf)} sf`),
      row('Efficiency', fmt.pct(m.efficiency)),
      row('Avg unit', `${fmt.int(m.units ? m.nsf / m.units : 0)} sf`)));
  } else {
    wrap.append(section('Leasable', row('Gross building', `${fmt.int(m.gsf)} sf`), row('Leasable', `${fmt.int(m.nsf)} sf`), row('Efficiency', fmt.pct(m.efficiency))));
  }

  wrap.append(section('Parking',
    row('Surface stalls', fmt.int(m.surfaceStalls)),
    m.structuredStalls ? row('Structured stalls', fmt.int(m.structuredStalls)) : null,
    m.garageStalls ? row('Private garages', fmt.int(m.garageStalls)) : null,
    row('Required', fmt.int(m.requiredStalls)),
    row('Surplus / (deficit)', fmt.int(m.totalStalls - m.requiredStalls), m.totalStalls < m.requiredStalls ? 'bad' : 'good'),
  ));

  if (state.scene.warnings.length) {
    wrap.append(section('Flags', state.scene.warnings.map((w) => el('div', { class: 'warn' }, w))));
  }
  return wrap;
}

function proformaView() {
  const pf = state.pf;
  const m = state.scene.metrics;
  const t = TYPOLOGIES[state.params.typology];
  const wrap = el('div', { class: 'panel-scroll' });

  wrap.append(el('div', { class: 'stat-grid' },
    stat('Total cost', fmt.money(pf.cost.total), `${fmt.money0(pf.cost.perGsf)}/gsf`),
    stat('NOI', fmt.money(pf.revenue.noi), m.units ? `${fmt.money0(pf.revenue.noiPerUnit)}/unit` : ''),
    stat('Yield on cost', fmt.pct(pf.returns.yieldOnCost, 2),
      `${(pf.returns.spread * 10000).toFixed(0)} bps vs cap`,
      pf.returns.spread > 0.0125 ? 'good' : pf.returns.spread > 0 ? null : 'bad'),
    stat('Profit', fmt.money(pf.returns.profit), fmt.pct(pf.returns.margin, 1),
      pf.returns.profit > 0 ? 'good' : 'bad'),
  ));

  wrap.append(section('Development cost',
    row('Land', fmt.money0(pf.cost.land)),
    row('Shell & core', fmt.money0(pf.cost.shell)),
    pf.cost.structuredParking ? row('Structured parking', fmt.money0(pf.cost.structuredParking)) : null,
    row('Surface parking', fmt.money0(pf.cost.surfaceParking)),
    row('Sitework & landscape', fmt.money0(pf.cost.sitework)),
    row('Contingency', fmt.money0(pf.cost.contingency)),
    row('Soft costs', fmt.money0(pf.cost.soft)),
    row('Total', fmt.money0(pf.cost.total), 'total'),
    m.units ? row('Cost per unit', fmt.money0(pf.cost.perUnit)) : null,
  ));

  const rentRows = pf.revenue.rentRoll.map((r) => row(
    t.family === 'residential' ? `${r.name} × ${fmt.int(r.count)}` : r.name,
    t.family === 'residential'
      ? `${fmt.money0(r.monthly)}/mo · ${fmt.money(r.annual)}`
      : `${fmt.money0(r.rentPsf)}/sf · ${fmt.money(r.annual)}`,
  ));

  wrap.append(section('Income',
    rentRows,
    row('Gross potential rent', fmt.money0(pf.revenue.gpr)),
    pf.revenue.other ? row('Other income', fmt.money0(pf.revenue.other)) : null,
    row('Vacancy & credit loss', `(${fmt.money0(pf.revenue.vacancyLoss)})`),
    row('Effective gross income', fmt.money0(pf.revenue.egi)),
    row('Operating expenses', `(${fmt.money0(pf.revenue.opex)})`),
    row('Net operating income', fmt.money0(pf.revenue.noi), 'total'),
  ));

  wrap.append(section('Value',
    row('Exit cap rate', fmt.pct(pf.returns.capRate, 2)),
    row('Stabilized value', fmt.money0(pf.returns.stabilizedValue)),
    m.units ? row('Value per unit', fmt.money0(pf.returns.valuePerUnit)) : null,
    row('Development profit', fmt.money0(pf.returns.profit), pf.returns.profit > 0 ? 'good' : 'bad'),
    row('Margin on cost', fmt.pct(pf.returns.margin, 1)),
  ));

  if (pf.forSale) {
    wrap.append(section('For-sale alternative',
      row('Avg unit size', `${fmt.int(pf.forSale.avgArea)} sf`),
      row('Price', `${fmt.money0(pf.forSale.pricePsf)}/sf · ${fmt.money0(pf.forSale.avgPrice)}`),
      row('Gross revenue', fmt.money0(pf.forSale.grossRevenue)),
      row('Selling costs', `(${fmt.money0(pf.forSale.sellingCosts)})`),
      row('Profit', fmt.money0(pf.forSale.profit), pf.forSale.profit > 0 ? 'good' : 'bad'),
      row('Margin', fmt.pct(pf.forSale.margin, 1)),
    ));
  }
  return wrap;
}

function sensitivityView() {
  const wrap = el('div', { class: 'panel-scroll' });
  const s = sensitivity(state.scene, JSON.parse(JSON.stringify(state.params)));
  const target = state.params.ops.capRate + 0.0125;
  const head = el('tr', {}, el('th', {}, 'cost \\ rent'),
    s.rentSteps.map((r) => el('th', {}, `${r > 0 ? '+' : ''}${(r * 100).toFixed(0)}%`)));
  const rows = s.grid.map((line, i) => el('tr', {},
    el('th', {}, `${s.costSteps[i] > 0 ? '+' : ''}${(s.costSteps[i] * 100).toFixed(0)}%`),
    line.map((v) => el('td', {
      class: v >= target ? 'good' : v >= state.params.ops.capRate ? 'ok' : 'bad',
    }, fmt.pct(v, 2)))));
  wrap.append(section('Yield on cost sensitivity',
    el('table', { class: 'grid-table' }, el('thead', {}, head), el('tbody', {}, rows)),
    el('p', { class: 'note' },
      `Green clears the ${fmt.pct(target, 2)} hurdle (exit cap + 125 bps). Amber clears the cap rate only.`)));

  const alt = TYPOLOGY_LIST.map((t) => {
    const params = { ...JSON.parse(JSON.stringify(defaultParams(t.key))), setbacks: state.params.setbacks, frontageEdge: state.params.frontageEdge, landPrice: state.params.landPrice };
    const scene = generate(state.polygon, params);
    const pf = runProforma(scene, params);
    return { t, scene, pf };
  });
  wrap.append(section('Typology comparison',
    el('table', { class: 'grid-table compare' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Scheme'), el('th', {}, 'Units / SF'), el('th', {}, 'YoC'), el('th', {}, 'Profit'))),
      el('tbody', {}, alt.map(({ t, scene, pf }) => el('tr', {
        class: t.key === state.params.typology ? 'current' : '',
        onclick: () => setTypology(t.key),
      },
        el('th', {}, t.name),
        el('td', {}, t.family === 'residential' ? `${fmt.int(scene.metrics.units)} du` : `${fmt.int(scene.metrics.gsf)} sf`),
        el('td', { class: pf.returns.yieldOnCost >= target ? 'good' : 'bad' }, fmt.pct(pf.returns.yieldOnCost, 2)),
        el('td', { class: pf.returns.profit > 0 ? 'good' : 'bad' }, fmt.money(pf.returns.profit)))))),
  ));
  return wrap;
}

// ---------------------------------------------------------------------------
// top bar + status bar
// ---------------------------------------------------------------------------

function buildTopBar() {
  const host = document.getElementById('typology-tabs');
  host.textContent = '';
  for (const t of TYPOLOGY_LIST) {
    host.append(el('button', {
      class: `typ${state.params.typology === t.key ? ' active' : ''}`,
      title: t.blurb,
      onclick: () => setTypology(t.key),
    }, t.name));
  }

  const layerHost = document.getElementById('layer-toggles');
  layerHost.textContent = '';
  const labels = { grid: 'Grid', setbacks: 'Setbacks', buildings: 'Massing', units: 'Units', parking: 'Parking', labels: 'Labels', dimensions: 'Dims' };
  for (const [key, name] of Object.entries(labels)) {
    layerHost.append(el('button', {
      class: `chip${state.layers[key] ? ' on' : ''}`,
      onclick: (e) => {
        state.layers[key] = !state.layers[key];
        e.currentTarget.classList.toggle('on', state.layers[key]);
        paint();
        save();
      },
    }, name));
  }
}

function buildStatusBar() {
  const host = document.getElementById('status');
  const m = state.scene.metrics;
  const t = TYPOLOGIES[state.params.typology];
  host.textContent = '';
  host.append(
    el('span', {}, `${fmt.num(m.acres, 2)} ac`),
    el('span', {}, t.family === 'residential' ? `${fmt.int(m.units)} units · ${fmt.num(m.density, 1)} du/ac` : `${fmt.int(m.gsf)} gsf`),
    el('span', {}, `FAR ${fmt.num(m.far, 2)} · ${fmt.pct(m.coverage, 0)} cover`),
    el('span', {}, `${fmt.int(m.totalStalls)} stalls`),
    el('span', { class: state.pf.returns.spread > 0 ? 'good' : 'bad' }, `YoC ${fmt.pct(state.pf.returns.yieldOnCost, 2)}`),
    el('span', { class: 'muted' }, `solved in ${state.solveMs.toFixed(1)} ms`),
  );
}

// ---------------------------------------------------------------------------
// canvas interaction
// ---------------------------------------------------------------------------

function vertexAt(px, py, tol = 10) {
  for (let i = 0; i < state.polygon.length; i++) {
    const s = view.toScreen(state.polygon[i]);
    if (Math.hypot(s.x - px, s.y - py) <= tol) return i;
  }
  return -1;
}

function edgeAt(px, py, tol = 8) {
  const w = view.toWorld({ x: px, y: py });
  const tolW = tol / view.scale;
  for (let i = 0; i < state.polygon.length; i++) {
    const a = state.polygon[i];
    const b = state.polygon[(i + 1) % state.polygon.length];
    if (distanceToSegment(w, a, b) <= tolW) return i;
  }
  return -1;
}

function bindCanvas() {
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;

    if (state.draw) {
      if (e.button === 2) { cancelDraw(); return; }
      const w = view.toWorld({ x: px, y: py });
      const snap = e.shiftKey ? 1 : 5;
      const pt = { x: Math.round(w.x / snap) * snap, y: Math.round(w.y / snap) * snap };
      const pts = state.draw.points;
      // Clicking the first handle closes the ring.
      if (pts.length >= 3) {
        const first = view.toScreen(pts[0]);
        if (Math.hypot(first.x - px, first.y - py) <= 11) { finishDraw(); return; }
      }
      pts.push(pt);
      paint();
      return;
    }

    if (e.button === 2) {
      const vi = vertexAt(px, py);
      if (vi >= 0 && state.polygon.length > 3) {
        state.polygon.splice(vi, 1);
        state.presetKey = 'custom';
        state.params.frontageEdge = Math.min(state.params.frontageEdge, state.polygon.length - 1);
        regenerate({ rebuildPanels: true });
      }
      return;
    }

    if (state.editing) {
      const vi = vertexAt(px, py);
      if (vi >= 0) {
        state.selectedVertex = vi;
        state.drag = { kind: 'vertex', index: vi };
        paint();
        return;
      }
      const ei = edgeAt(px, py);
      if (ei >= 0) {
        if (e.altKey || e.metaKey) {
          const w = view.toWorld({ x: px, y: py });
          state.polygon.splice(ei + 1, 0, w);
          state.presetKey = 'custom';
          state.drag = { kind: 'vertex', index: ei + 1 };
          state.selectedVertex = ei + 1;
          regenerate({ rebuildPanels: true });
        } else {
          state.params.frontageEdge = ei;
          regenerate({ rebuildPanels: true });
        }
        return;
      }
      // Dragging from inside the parcel slides the whole thing; from outside
      // it pans the view.
      if (pointInPolygon(view.toWorld({ x: px, y: py }), state.polygon)) {
        state.drag = { kind: 'move', last: view.toWorld({ x: px, y: py }) };
        canvas.style.cursor = 'move';
        return;
      }
    }
    state.drag = { kind: 'pan', x: px, y: py };
  });

  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;

    if (state.draw) {
      const w = view.toWorld({ x: px, y: py });
      const snap = e.shiftKey ? 1 : 5;
      state.draw.cursor = { x: Math.round(w.x / snap) * snap, y: Math.round(w.y / snap) * snap };
      paint();
      return;
    }

    if (state.drag && state.drag.kind === 'move') {
      const w = view.toWorld({ x: px, y: py });
      const dx = w.x - state.drag.last.x;
      const dy = w.y - state.drag.last.y;
      state.polygon = state.polygon.map((p) => ({ x: p.x + dx, y: p.y + dy }));
      state.drag.last = w;
      state.presetKey = 'custom';
      regenerate();
      return;
    }

    if (state.drag && state.drag.kind === 'pan') {
      view.pan(px - state.drag.x, py - state.drag.y);
      state.drag.x = px;
      state.drag.y = py;
      paint();
      return;
    }
    if (state.drag && state.drag.kind === 'vertex') {
      const w = view.toWorld({ x: px, y: py });
      const snap = e.shiftKey ? 1 : 5;
      state.polygon[state.drag.index] = {
        x: Math.round(w.x / snap) * snap,
        y: Math.round(w.y / snap) * snap,
      };
      state.presetKey = 'custom';
      regenerate();
      return;
    }
    const hv = state.editing ? vertexAt(px, py) : -1;
    const he = hv < 0 && state.editing ? edgeAt(px, py) : -1;
    canvas.style.cursor = hv >= 0 ? 'grab' : he >= 0 ? 'pointer' : 'default';
    if (hv !== state.hoverVertex) {
      state.hoverVertex = hv;
      paint();
    }
  });

  const endDrag = () => {
    if (state.drag && (state.drag.kind === 'vertex' || state.drag.kind === 'move')) {
      regenerate({ rebuildPanels: true });
    }
    if (state.drag && state.drag.kind === 'move') canvas.style.cursor = 'default';
    state.drag = null;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('dblclick', (e) => {
    if (state.draw) { e.preventDefault(); finishDraw(); }
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    view.zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    paint();
  }, { passive: false });

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (state.draw) {
      if (e.key === 'Escape') cancelDraw();
      if (e.key === 'Enter') finishDraw();
      if (e.key === 'Backspace') {
        e.preventDefault();
        state.draw.points.pop();
        paint();
      }
      return;
    }
    if (e.key === 'd') { startDraw(); }
    if (e.key === 'f') { view.fit(state.scene.site); paint(); }
    if (e.key === 'e') { toggleEdit(); }
    if (e.key === 'g') { regenerate({ rebuildPanels: true }); toast('Scheme regenerated'); }
    if (e.key === '[') { cycleFrontage(-1); }
    if (e.key === ']') { cycleFrontage(1); }
  });

  window.addEventListener('resize', () => {
    view.resize();
    paint();
  });
}

function toggleEdit() {
  state.editing = !state.editing;
  document.getElementById('btn-edit').classList.toggle('on', state.editing);
  paint();
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

function exportJSON() {
  const payload = {
    generatedAt: new Date().toISOString(),
    typology: state.params.typology,
    parcel: { polygon: state.polygon, acres: toAcres(area(state.polygon)) },
    params: state.params,
    metrics: state.scene.metrics,
    proforma: state.pf,
  };
  downloadBlob(`scheme-${state.params.typology}.json`, 'application/json', JSON.stringify(payload, null, 2));
  toast('Scheme JSON exported');
}

function exportCSV() {
  const m = state.scene.metrics;
  const pf = state.pf;
  const lines = [['metric', 'value']];
  const push = (k, v) => lines.push([k, typeof v === 'number' ? v.toFixed(2) : v]);
  push('typology', TYPOLOGIES[state.params.typology].name);
  push('site_acres', m.acres);
  push('units', m.units);
  push('density_du_ac', m.density);
  push('gross_sf', m.gsf);
  push('net_sf', m.nsf);
  push('far', m.far);
  push('coverage', m.coverage);
  push('height_ft', m.height);
  push('stalls_total', m.totalStalls);
  push('stalls_required', m.requiredStalls);
  for (const u of UNIT_TYPES) push(`units_${u.key}`, m.mixCount[u.key] || 0);
  push('total_cost', pf.cost.total);
  push('noi', pf.revenue.noi);
  push('yield_on_cost', pf.returns.yieldOnCost);
  push('stabilized_value', pf.returns.stabilizedValue);
  push('profit', pf.returns.profit);
  downloadBlob(`scheme-${state.params.typology}.csv`, 'text/csv',
    lines.map((r) => r.join(',')).join('\n'));
  toast('Metrics CSV exported');
}

function exportPNG() {
  canvas.toBlob((blob) => {
    downloadBlob(`site-plan-${state.params.typology}.png`, 'image/png', blob);
    toast('Plan image exported');
  });
}

function bindToolbar() {
  document.getElementById('btn-edit').addEventListener('click', toggleEdit);
  document.getElementById('btn-draw').addEventListener('click', () => {
    if (state.draw) cancelDraw(); else startDraw();
  });
  document.getElementById('btn-fit').addEventListener('click', () => { view.fit(state.scene.site); paint(); });
  document.getElementById('btn-generate').addEventListener('click', () => {
    regenerate({ rebuildPanels: true });
    toast('Scheme regenerated');
  });
  document.getElementById('btn-json').addEventListener('click', exportJSON);
  document.getElementById('btn-csv').addEventListener('click', exportCSV);
  document.getElementById('btn-png').addEventListener('click', exportPNG);
  document.getElementById('btn-reset').addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEY);
    state.params = defaultParams('garden');
    state.polygon = PRESETS[0].polygon.map((p) => ({ ...p }));
    state.presetKey = 'rect';
    buildTopBar();
    regenerate({ refit: true, rebuildPanels: true });
    toast('Reset to defaults');
  });
}

// ---------------------------------------------------------------------------

function boot() {
  restore();
  state.polygon = ensureCCW(state.polygon);
  view.resize();
  bindCanvas();
  bindToolbar();
  buildTopBar();
  buildLeftPanel();
  regenerate({ refit: true });
  document.getElementById('btn-edit').classList.toggle('on', state.editing);
}

boot();

// Exposed for the smoke test and for poking at schemes from the console.
window.SitePlanner = { state, view, regenerate, generate, runProforma };
