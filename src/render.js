// Canvas renderer. World units are feet; the view flips y so north is up.

import { V, bbox, centroid, area, perimeter } from './geometry.js';

export const THEME = {
  bg: '#0d1014',
  grid: '#161b22',
  gridMajor: '#1d242d',
  site: '#5ad1ff',
  siteFill: 'rgba(90, 209, 255, 0.04)',
  setback: '#3c4b5a',
  building: '#e8813a',
  buildingDark: '#8c4a1d',
  buildingStroke: '#ffb27a',
  unitStroke: 'rgba(20, 12, 6, 0.45)',
  core: '#3a2412',
  pavement: '#1a2029',
  pavementStroke: '#2b3542',
  stall: '#39475a',
  stallStroke: '#4d5f76',
  garage: '#4b5a6e',
  garageStroke: '#7d90a8',
  truck: '#1e2732',
  trailer: '#2f3c4c',
  landscape: 'rgba(64, 160, 108, 0.10)',
  text: '#c7d2de',
  dim: '#7d8b9b',
  handle: '#ffd166',
  warn: '#ff6b6b',
};

export const UNIT_COLORS = {
  studio: '#f7c59f',
  one: '#f0a868',
  two: '#e8813a',
  three: '#c9611f',
};

export class View {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scale = 0.5; // pixels per foot
    this.cx = 0; // world coordinate at the canvas centre
    this.cy = 0;
    this.dpr = window.devicePixelRatio || 1;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    this.w = rect.width;
    this.h = rect.height;
  }

  toScreen(p) {
    return {
      x: (p.x - this.cx) * this.scale + this.w / 2,
      y: this.h / 2 - (p.y - this.cy) * this.scale,
    };
  }

  toWorld(p) {
    return {
      x: (p.x - this.w / 2) / this.scale + this.cx,
      y: (this.h / 2 - p.y) / this.scale + this.cy,
    };
  }

  fit(poly, pad = 80) {
    if (!poly || poly.length < 3) return;
    const bb = bbox(poly);
    const c = centroid(poly);
    this.cx = c.x;
    this.cy = c.y;
    const sx = (this.w - pad * 2) / Math.max(1, bb.w);
    const sy = (this.h - pad * 2) / Math.max(1, bb.h);
    this.scale = Math.max(0.02, Math.min(sx, sy));
  }

  zoomAt(px, py, factor) {
    const before = this.toWorld({ x: px, y: py });
    this.scale = Math.max(0.02, Math.min(12, this.scale * factor));
    const after = this.toWorld({ x: px, y: py });
    this.cx += before.x - after.x;
    this.cy += before.y - after.y;
  }

  pan(dxPx, dyPx) {
    this.cx -= dxPx / this.scale;
    this.cy += dyPx / this.scale;
  }
}

// ---------------------------------------------------------------------------

function path(ctx, view, poly, close = true) {
  if (!poly || poly.length < 2) return;
  ctx.beginPath();
  const p0 = view.toScreen(poly[0]);
  ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < poly.length; i++) {
    const p = view.toScreen(poly[i]);
    ctx.lineTo(p.x, p.y);
  }
  if (close) ctx.closePath();
}

function fillPoly(ctx, view, poly, fill, stroke, lw = 1) {
  if (!poly || poly.length < 3) return;
  path(ctx, view, poly);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
}

function fillPolyWithHole(ctx, view, outer, hole, fill, stroke, lw = 1) {
  ctx.beginPath();
  const draw = (poly, reverse) => {
    const pts = reverse ? poly.slice().reverse() : poly;
    const p0 = view.toScreen(pts[0]);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < pts.length; i++) {
      const p = view.toScreen(pts[i]);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
  };
  draw(outer, false);
  draw(hole, true);
  ctx.fillStyle = fill;
  ctx.fill('evenodd');
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    path(ctx, view, outer);
    ctx.stroke();
    path(ctx, view, hole);
    ctx.stroke();
  }
}

function drawGrid(ctx, view) {
  const step = view.scale > 1.6 ? 10 : view.scale > 0.55 ? 25 : view.scale > 0.2 ? 100 : 500;
  const tl = view.toWorld({ x: 0, y: 0 });
  const br = view.toWorld({ x: view.w, y: view.h });
  ctx.lineWidth = 1;
  for (let x = Math.floor(tl.x / step) * step; x < br.x; x += step) {
    const s = view.toScreen({ x, y: 0 });
    ctx.strokeStyle = Math.abs(x % (step * 5)) < 1e-6 ? THEME.gridMajor : THEME.grid;
    ctx.beginPath();
    ctx.moveTo(Math.round(s.x) + 0.5, 0);
    ctx.lineTo(Math.round(s.x) + 0.5, view.h);
    ctx.stroke();
  }
  for (let y = Math.floor(br.y / step) * step; y < tl.y; y += step) {
    const s = view.toScreen({ x: 0, y });
    ctx.strokeStyle = Math.abs(y % (step * 5)) < 1e-6 ? THEME.gridMajor : THEME.grid;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(s.y) + 0.5);
    ctx.lineTo(view.w, Math.round(s.y) + 0.5);
    ctx.stroke();
  }
}

function drawScaleBar(ctx, view) {
  const targets = [25, 50, 100, 200, 500, 1000];
  let ft = targets[0];
  for (const t of targets) { if (t * view.scale < 180) ft = t; }
  const px = ft * view.scale;
  const x = 20;
  const y = view.h - 26;
  ctx.strokeStyle = THEME.dim;
  ctx.fillStyle = THEME.dim;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y - 5);
  ctx.lineTo(x, y);
  ctx.lineTo(x + px, y);
  ctx.lineTo(x + px, y - 5);
  ctx.stroke();
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`${ft}'`, x + px + 8, y + 4);
}

function drawNorth(ctx, view) {
  const x = view.w - 34;
  const y = 34;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = THEME.dim;
  ctx.beginPath();
  ctx.moveTo(0, -16);
  ctx.lineTo(6, 8);
  ctx.lineTo(0, 3);
  ctx.lineTo(-6, 8);
  ctx.closePath();
  ctx.fill();
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('N', 0, 22);
  ctx.restore();
}

function label(ctx, view, world, text, color = THEME.text, size = 11) {
  const s = view.toScreen(world);
  ctx.font = `${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(6, 9, 12, 0.72)';
  ctx.fillRect(s.x - w / 2 - 5, s.y - size / 2 - 3, w + 10, size + 6);
  ctx.fillStyle = color;
  ctx.fillText(text, s.x, s.y);
}

function drawEdgeDimensions(ctx, view, poly, frontageEdge) {
  ctx.font = '10px ui-monospace, monospace';
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const len = V.dist(a, b);
    if (len * view.scale < 45) continue;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const dir = V.norm(V.sub(b, a));
    const out = { x: dir.y, y: -dir.x };
    const off = 16 / view.scale;
    const at = { x: mid.x + out.x * off, y: mid.y + out.y * off };
    const isFront = i === frontageEdge;
    label(ctx, view, at, `${len.toFixed(0)}'`, isFront ? THEME.handle : THEME.dim, 10);
  }
}

// ---------------------------------------------------------------------------

export function render(view, scene, opts = {}) {
  const ctx = view.ctx;
  const { layers = {}, editing = false, hoverVertex = -1, selectedVertex = -1, frontageEdge = 0 } = opts;

  ctx.save();
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.clearRect(0, 0, view.w, view.h);
  ctx.fillStyle = THEME.bg;
  ctx.fillRect(0, 0, view.w, view.h);

  if (layers.grid !== false) drawGrid(ctx, view);
  if (!scene) { ctx.restore(); return; }

  // Site + buildable envelope
  fillPoly(ctx, view, scene.site, THEME.siteFill, THEME.site, 2);
  if (layers.setbacks !== false && scene.buildable.length >= 3) {
    ctx.save();
    ctx.setLineDash([7, 6]);
    fillPoly(ctx, view, scene.buildable, null, THEME.setback, 1.25);
    ctx.restore();
  }

  // Pavement: aisles first so stalls sit on top of them
  if (layers.parking !== false) {
    for (const a of scene.aisles) fillPoly(ctx, view, a, THEME.pavement, null);
    for (const t of scene.truckCourt) fillPoly(ctx, view, t, THEME.truck, THEME.pavementStroke, 1);
    for (const t of scene.trailers) fillPoly(ctx, view, t, THEME.trailer, THEME.pavementStroke, 0.6);
    for (const s of scene.stalls) {
      fillPoly(ctx, view, s, THEME.stall, view.scale > 0.35 ? THEME.stallStroke : null, 0.6);
    }
  }

  if (scene.garage && layers.parking !== false) {
    const g = scene.garage;
    fillPoly(ctx, view, g.poly, THEME.garage, THEME.garageStroke, 1.5);
    const c = centroid(g.poly);
    if (area(g.poly) * view.scale * view.scale > 6000) {
      label(ctx, view, c, `GARAGE · ${g.levels} LVL · ${g.stalls} STALLS`, '#dbe6f2', 11);
    }
  }

  // Buildings
  if (layers.buildings !== false) {
    for (const b of scene.buildings) {
      if (b.hole) {
        fillPolyWithHole(ctx, view, b.poly, b.hole, THEME.building, THEME.buildingStroke, 1.5);
      } else {
        fillPoly(ctx, view, b.poly, THEME.building, THEME.buildingStroke, 1.5);
      }

      if (layers.units !== false && view.scale > 0.25) {
        for (const u of b.units) {
          fillPoly(ctx, view, u.poly, UNIT_COLORS[u.type] || THEME.building, THEME.unitStroke, 0.5);
        }
        for (const c of b.cores) fillPoly(ctx, view, c, THEME.core, THEME.unitStroke, 0.5);
        for (const t of b.tenants || []) fillPoly(ctx, view, t, null, THEME.unitStroke, 0.8);
      }
      if (b.office) fillPoly(ctx, view, b.office, THEME.buildingDark, THEME.unitStroke, 0.8);
      for (const d of b.docks || []) fillPoly(ctx, view, d, '#11161c', '#000', 0.5);

      if (layers.labels !== false && b.rect && b.rect.w * view.scale > 70) {
        const c = centroid(b.poly);
        const txt = b.kind === 'residential'
          ? `${b.id} · ${b.floors} STY · ${b.unitCount} DU`
          : `${b.id} · ${Math.round(b.gsf).toLocaleString()} SF`;
        label(ctx, view, c, txt, '#1b1109', 11);
      }
    }
    for (const pd of scene.pads) {
      fillPoly(ctx, view, pd.poly, THEME.buildingDark, THEME.buildingStroke, 1.2);
      if (layers.labels !== false) {
        label(ctx, view, centroid(pd.poly), `PAD ${Math.round(pd.gsf).toLocaleString()} SF`, '#ffe6d2', 10);
      }
    }
  }

  // Site polygon on top, plus edit handles
  fillPoly(ctx, view, scene.site, null, THEME.site, 2);
  if (layers.dimensions !== false) drawEdgeDimensions(ctx, view, scene.site, frontageEdge);

  if (editing) {
    scene.site.forEach((p, i) => {
      const s = view.toScreen(p);
      const r = i === selectedVertex ? 7 : i === hoverVertex ? 6 : 4.5;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fillStyle = i === selectedVertex ? THEME.handle : '#0d1014';
      ctx.strokeStyle = THEME.handle;
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();
    });
  }

  drawScaleBar(ctx, view);
  drawNorth(ctx, view);
  ctx.restore();
}

export function sceneSummaryText(scene) {
  const m = scene.metrics;
  return [
    `${(m.acres).toFixed(2)} ac`,
    `${m.units} units`,
    `${Math.round(m.gsf).toLocaleString()} gsf`,
    `${m.totalStalls} stalls`,
  ].join('  ·  ');
}

export function siteStats(poly) {
  return { area: area(poly), perimeter: perimeter(poly) };
}
