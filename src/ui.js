// Small DOM helpers for building the parameter and metrics panels.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const fmt = {
  int: (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString() : '—'),
  num: (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '—'),
  pct: (n, d = 1) => (Number.isFinite(n) ? `${(n * 100).toFixed(d)}%` : '—'),
  money: (n) => {
    if (!Number.isFinite(n)) return '—';
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
    return `${sign}$${abs.toFixed(0)}`;
  },
  money0: (n) => (Number.isFinite(n) ? `$${Math.round(n).toLocaleString()}` : '—'),
  ft: (n) => (Number.isFinite(n) ? `${Math.round(n)}'` : '—'),
};

export function field(labelText, input, hint) {
  return el('label', { class: 'field' },
    el('span', { class: 'field-label' }, labelText, hint ? el('em', {}, hint) : null),
    input);
}

export function numberInput(value, { min, max, step = 1, suffix, onInput }) {
  const input = el('input', {
    type: 'number',
    value: String(value),
    min: min ?? null,
    max: max ?? null,
    step: String(step),
    class: 'num',
  });
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) onInput(v);
  });
  return suffix
    ? el('span', { class: 'input-wrap' }, input, el('i', { class: 'suffix' }, suffix))
    : el('span', { class: 'input-wrap' }, input);
}

export function sliderInput(value, { min, max, step = 1, format = (v) => v, onInput }) {
  const out = el('b', { class: 'slider-val' }, format(value));
  const input = el('input', {
    type: 'range', min: String(min), max: String(max), step: String(step), value: String(value),
    class: 'slider',
  });
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    out.textContent = format(v);
    onInput(v);
  });
  return el('span', { class: 'slider-wrap' }, input, out);
}

export function selectInput(value, options, onChange) {
  const sel = el('select', { class: 'select' },
    options.map((o) => el('option', { value: o.value, selected: o.value === value ? 'selected' : null }, o.label)));
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

export function section(title, ...children) {
  return el('section', { class: 'panel-section' },
    el('h3', {}, title),
    el('div', { class: 'panel-body' }, children));
}

export function stat(label, value, sub, tone) {
  return el('div', { class: `stat${tone ? ` tone-${tone}` : ''}` },
    el('span', { class: 'stat-label' }, label),
    el('span', { class: 'stat-value' }, value),
    sub ? el('span', { class: 'stat-sub' }, sub) : null);
}

export function row(label, value, tone) {
  return el('div', { class: `row${tone ? ` tone-${tone}` : ''}` },
    el('span', {}, label), el('b', {}, value));
}

export function downloadBlob(filename, mime, data) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function toast(message, tone = 'info') {
  let host = document.querySelector('.toasts');
  if (!host) {
    host = el('div', { class: 'toasts' });
    document.body.append(host);
  }
  const node = el('div', { class: `toast tone-${tone}` }, message);
  host.append(node);
  setTimeout(() => node.classList.add('out'), 2600);
  setTimeout(() => node.remove(), 3200);
}
