// Geometry primitives for the site planner.
// All coordinates are in feet. +x is east, +y is north. Polygons are arrays
// of {x, y} and are normalised to counter-clockwise winding before any work.

export const EPS = 1e-9;

export const V = {
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
  mul: (a, s) => ({ x: a.x * s, y: a.y * s }),
  len: (a) => Math.hypot(a.x, a.y),
  dist: (a, b) => Math.hypot(b.x - a.x, b.y - a.y),
  dot: (a, b) => a.x * b.x + a.y * b.y,
  cross: (a, b) => a.x * b.y - a.y * b.x,
  norm: (a) => {
    const l = Math.hypot(a.x, a.y);
    return l < EPS ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
  },
};

export function signedArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export const area = (poly) => Math.abs(signedArea(poly));

export function ensureCCW(poly) {
  return signedArea(poly) < 0 ? poly.slice().reverse() : poly.slice();
}

export function perimeter(poly) {
  let p = 0;
  for (let i = 0; i < poly.length; i++) p += V.dist(poly[i], poly[(i + 1) % poly.length]);
  return p;
}

export function centroid(poly) {
  const a = signedArea(poly);
  if (Math.abs(a) < EPS) {
    const n = poly.length || 1;
    return poly.reduce((acc, p) => ({ x: acc.x + p.x / n, y: acc.y + p.y / n }), { x: 0, y: 0 });
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

export function bbox(poly) {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
    get w() { return this.maxX - this.minX; },
    get h() { return this.maxY - this.minY; },
  };
}

export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

export function distanceToSegment(p, a, b) {
  const ab = V.sub(b, a);
  const l2 = V.dot(ab, ab);
  if (l2 < EPS) return V.dist(p, a);
  let t = V.dot(V.sub(p, a), ab) / l2;
  t = Math.max(0, Math.min(1, t));
  return V.dist(p, { x: a.x + ab.x * t, y: a.y + ab.y * t });
}

// Intersection of the infinite lines p1 + t*d1 and p2 + s*d2.
export function lineIntersect(p1, d1, p2, d2) {
  const den = V.cross(d1, d2);
  if (Math.abs(den) < 1e-10) return null;
  const t = V.cross(V.sub(p2, p1), d2) / den;
  return { x: p1.x + d1.x * t, y: p1.y + d1.y * t };
}

export function segmentIntersect(a1, a2, b1, b2) {
  const d1 = V.sub(a2, a1);
  const d2 = V.sub(b2, b1);
  const den = V.cross(d1, d2);
  if (Math.abs(den) < 1e-10) return null;
  const t = V.cross(V.sub(b1, a1), d2) / den;
  const s = V.cross(V.sub(b1, a1), d1) / den;
  if (t < 1e-9 || t > 1 - 1e-9 || s < 1e-9 || s > 1 - 1e-9) return null;
  return { x: a1.x + d1.x * t, y: a1.y + d1.y * t, t, s };
}

export function dedupe(poly, tol = 0.01) {
  const out = [];
  for (const p of poly) {
    if (!out.length || V.dist(out[out.length - 1], p) > tol) out.push(p);
  }
  while (out.length > 1 && V.dist(out[0], out[out.length - 1]) <= tol) out.pop();
  return out;
}

// Drop the self-intersecting lobes an inward offset can create at tight
// corners. Small polygons only, so the O(n^2) sweep is fine.
export function removeLoops(poly) {
  let work = dedupe(poly);
  for (let guard = 0; guard < 24; guard++) {
    const n = work.length;
    if (n < 4) break;
    let found = null;
    outer: for (let i = 0; i < n; i++) {
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const hit = segmentIntersect(work[i], work[(i + 1) % n], work[j], work[(j + 1) % n]);
        if (hit) { found = { i, j, hit }; break outer; }
      }
    }
    if (!found) break;
    const { i, j, hit } = found;
    const loopA = [{ x: hit.x, y: hit.y }, ...work.slice(i + 1, j + 1)];
    const loopB = [{ x: hit.x, y: hit.y }, ...work.slice(j + 1), ...work.slice(0, i + 1)];
    work = dedupe(area(loopA) > area(loopB) ? loopA : loopB);
  }
  return work;
}

export function distanceToBoundary(p, poly) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    best = Math.min(best, distanceToSegment(p, poly[i], poly[(i + 1) % poly.length]));
  }
  return best;
}

// Offset every edge inward by its own distance. `dists` is parallel to the
// edge list of the CCW-normalised polygon. Returns [] if nothing survives.
export function offsetPolygonPerEdge(poly, dists) {
  const p = ensureCCW(dedupe(poly));
  const n = p.length;
  if (n < 3) return [];
  const lines = [];
  for (let i = 0; i < n; i++) {
    const a = p[i];
    const b = p[(i + 1) % n];
    const dir = V.norm(V.sub(b, a));
    if (V.len(dir) < 0.5) continue;
    const inward = { x: -dir.y, y: dir.x }; // interior side of a CCW edge
    const d = dists[i] ?? 0;
    lines.push({ a: { x: a.x + inward.x * d, y: a.y + inward.y * d }, dir, d });
  }
  if (lines.length < 3) return [];

  const raw = [];
  for (let i = 0; i < lines.length; i++) {
    // raw[i] is the offset of vertex i: where its two edges' offset lines meet.
    const L1 = lines[(i - 1 + lines.length) % lines.length];
    const L2 = lines[i];
    const ip = lineIntersect(L1.a, L1.dir, L2.a, L2.dir);
    // A corner vertex must really stand off both of its edges. Where the
    // offset has folded through itself it will not, and the vertex is dropped.
    const want = Math.min(L1.d, L2.d);
    const at = ip ?? L2.a;
    const ok = distanceToBoundary(at, p) >= want - 0.75
      && (want < 0.5 || pointInPolygon(at, p));
    if (ok) raw.push(at);
  }
  if (raw.length < 3) return [];

  const cleaned = removeLoops(raw);
  if (cleaned.length < 3) return [];
  if (signedArea(cleaned) <= 0) return [];
  // Guard against an offset that escapes the parent polygon entirely.
  if (!pointInPolygon(centroid(cleaned), p)) return [];
  return cleaned;
}

export const offsetPolygon = (poly, d) => offsetPolygonPerEdge(poly, poly.map(() => d));

// Offset that keeps one output vertex per input vertex, so concentric rings
// stay index-aligned and can be paired into quads. No cleanup is applied —
// callers must check the result is still a sane ring. Returns null if not.
export function offsetRing(poly, d) {
  const p = ensureCCW(dedupe(poly));
  const n = p.length;
  if (n < 3) return null;
  const lines = p.map((a, i) => {
    const b = p[(i + 1) % n];
    const dir = V.norm(V.sub(b, a));
    const inward = { x: -dir.y, y: dir.x };
    return { a: { x: a.x + inward.x * d, y: a.y + inward.y * d }, dir };
  });
  const out = [];
  for (let i = 0; i < n; i++) {
    const L1 = lines[(i - 1 + n) % n];
    const L2 = lines[i];
    const ip = lineIntersect(L1.a, L1.dir, L2.a, L2.dir);
    if (!ip) return null;
    out.push(ip);
  }
  if (signedArea(out) <= 0) return null;
  for (const v of out) {
    if (!pointInPolygon(v, p) || distanceToBoundary(v, p) < d - 0.75) return null;
  }
  return out;
}

export function rotatePoint(p, ang, origin = { x: 0, y: 0 }) {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const dx = p.x - origin.x;
  const dy = p.y - origin.y;
  return { x: origin.x + dx * c - dy * s, y: origin.y + dx * s + dy * c };
}

export const rotatePoly = (poly, ang, origin) => poly.map((p) => rotatePoint(p, ang, origin));

export function rectPoly(x, y, w, h) {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

// x-intervals of the polygon interior along the horizontal line y.
export function scanSpans(poly, y) {
  const xs = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
      const t = (y - a.y) / (b.y - a.y);
      xs.push(a.x + t * (b.x - a.x));
    }
  }
  xs.sort((p, q) => p - q);
  const spans = [];
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i + 1] - xs[i] > 0.5) spans.push([xs[i], xs[i + 1]]);
  }
  return spans;
}

export function intersectSpanLists(A, B) {
  const out = [];
  for (const [a0, a1] of A) {
    for (const [b0, b1] of B) {
      const lo = Math.max(a0, b0);
      const hi = Math.min(a1, b1);
      if (hi - lo > 0.5) out.push([lo, hi]);
    }
  }
  return out.sort((p, q) => p[0] - q[0]);
}

// x-intervals where a horizontal band [y0, y1] lies wholly inside the polygon.
// Samples the band edges plus every vertex height inside it so notches are caught.
export function bandSpans(poly, y0, y1) {
  const e = Math.min(0.25, (y1 - y0) / 8);
  const levels = new Set([y0 + e, y1 - e, (y0 + y1) / 2]);
  for (const p of poly) {
    if (p.y > y0 + e && p.y < y1 - e) levels.add(p.y);
  }
  let spans = null;
  for (const y of [...levels].sort((a, b) => a - b)) {
    const s = scanSpans(poly, y);
    spans = spans === null ? s : intersectSpanLists(spans, s);
    if (!spans.length) return [];
  }
  return spans || [];
}

// Longest edge direction, used as the default building axis.
export function longestEdgeAngle(poly) {
  let best = 0;
  let bestLen = -1;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const l = V.dist(a, b);
    if (l > bestLen) {
      bestLen = l;
      best = Math.atan2(b.y - a.y, b.x - a.x);
    }
  }
  return best;
}

export function edgeAngle(poly, i) {
  const a = poly[i % poly.length];
  const b = poly[(i + 1) % poly.length];
  return Math.atan2(b.y - a.y, b.x - a.x);
}

export function edgeMidpoint(poly, i) {
  const a = poly[i % poly.length];
  const b = poly[(i + 1) % poly.length];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

// Sutherland-Hodgman clip of `subject` against the half-plane on the interior
// side of the directed line a -> b (interior = left of the direction).
export function clipHalfPlane(subject, a, b) {
  const out = [];
  const side = (p) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  for (let i = 0; i < subject.length; i++) {
    const cur = subject[i];
    const prev = subject[(i + subject.length - 1) % subject.length];
    const sCur = side(cur);
    const sPrev = side(prev);
    if (sCur >= -EPS) {
      if (sPrev < -EPS) {
        const t = sPrev / (sPrev - sCur);
        out.push({ x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t });
      }
      out.push(cur);
    } else if (sPrev >= -EPS) {
      const t = sPrev / (sPrev - sCur);
      out.push({ x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t });
    }
  }
  return out;
}

// Clip `subject` to a convex polygon. Used for trimming pads to the pad limit.
export function clipToConvex(subject, convex) {
  let poly = ensureCCW(subject);
  const c = ensureCCW(convex);
  for (let i = 0; i < c.length && poly.length; i++) {
    poly = clipHalfPlane(poly, c[i], c[(i + 1) % c.length]);
  }
  return poly;
}

export const SQFT_PER_ACRE = 43560;
export const toAcres = (sqft) => sqft / SQFT_PER_ACRE;
