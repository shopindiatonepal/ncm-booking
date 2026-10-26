// NCM partner booking site — zero dependencies, needs Node 18+.
// The vendor API token lives ONLY here (environment variable), never in the browser.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
// tolerate a pasted key with spaces, quotes or the word "Token" in front
const NCM_TOKEN = (process.env.NCM_TOKEN || '').trim().replace(/^["']+|["']+$/g, '').replace(/^Token\s+/i, '').trim();
const NCM_BASE = (process.env.NCM_BASE_URL || 'https://portal.nepalcanmove.com').replace(/\/$/, '');
const VREF_ID = process.env.VREF_ID || '31180'; // fixed, partner cannot change it
// Optional: NCM's public tracking page, with {id} where the tracking ID goes. If empty, the tracking link opens this site's own tracking view.
const TRACK_URL = (process.env.TRACK_URL || '').trim();
const PASSCODE = process.env.PASSCODE || 'change-me';
const SECRET = crypto.createHash('sha256').update(PASSCODE + NCM_TOKEN + 'ncm').digest('hex');
const DATA_FILE = path.join(__dirname, 'data', 'orders.json');
const TEST_MODE = !NCM_TOKEN; // no token yet -> orders are only saved locally, nothing is sent to NCM

const DELIVERY_TYPES = ['Door2Door', 'Door2Branch', 'Branch2Door', 'Branch2Branch'];
const PRIORITIES = ['Normal', 'High', 'Urgent'];

fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
// Storage: permanent if UPSTASH_REDIS_REST_URL + _TOKEN are set (free Upstash Redis), otherwise a local file
// (the file is wiped when free hosting restarts).
const KV_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
async function kv(cmd) {
  const r = await fetch(KV_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + KV_TOKEN }, body: JSON.stringify(cmd) });
  const d = await r.json();
  if (!r.ok || d.error) throw new Error('Storage error: ' + (d.error || r.status));
  return d.result;
}
const FILES = { orders: 'orders.json', customers: 'customers.json', meta: 'meta.json' };
async function loadList(name) {
  if (KV_URL) { const v = await kv(['GET', name]); return v ? JSON.parse(v) : []; }
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', FILES[name]), 'utf8')); } catch { return []; }
}
async function saveList(name, v) {
  if (KV_URL) return void (await kv(['SET', name, JSON.stringify(v)]));
  fs.writeFileSync(path.join(__dirname, 'data', FILES[name]), JSON.stringify(v, null, 1));
}
// Every order gets its own id on this site. Drafts have no NCM id yet, so the site id is what identifies them.
function ensureIds(all) { let changed = false; for (const o of all) if (!o.id) { o.id = o.ncmId != null && o.ncmId !== '' ? 'n' + o.ncmId : crypto.randomUUID().slice(0, 8); changed = true; } return changed; }
async function loadOrders() { const all = await loadList('orders'); if (ensureIds(all)) await saveList('orders', all); return all; }
const saveOrders = (v) => saveList('orders', v);
const byId = (all, id) => { id = String(id ?? ''); return all.find((x) => x.id === id) || all.find((x) => x.ncmId != null && String(x.ncmId) === id); };
const sending = new Set(); // order ids currently being sent to NCM
const loadCustomers = () => loadList('customers'), saveCustomers = (v) => saveList('customers', v);

// ---------- tiny session cookie ----------
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
function makeSession() { const exp = String(Date.now() + 1000 * 60 * 60 * 24 * 30); return exp + '.' + sign(exp); }
function isAuthed(req) {
  const m = /(?:^|;\s*)sess=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  return !!exp && sig === sign(exp) && Number(exp) > Date.now();
}
// Wrong-attempt limits, per visitor (the proxy adds the real address last in x-forwarded-for)
const clientIp = (req) => { const x = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean); return x.length ? x[x.length - 1] : req.socket.remoteAddress; };
const attempts = { login: new Map(), key: new Map() };
const WINDOW = 15 * 60e3;
function isLocked(kind, ip) { const a = attempts[kind].get(ip); return !!a && a.n >= 10 && Date.now() - a.t < WINDOW; }
function noteFail(kind, ip) { const a = attempts[kind].get(ip), now = Date.now(); attempts[kind].set(ip, a && now - a.t < WINDOW ? { n: a.n + 1, t: a.t } : { n: 1, t: now }); }
// A separate passkey, set by the owner as DELETE_PASSKEY, protects deleting. If it isn't set, deleting is switched off.
const DELETE_PASSKEY = process.env.DELETE_PASSKEY || '';
function checkDeleteKey(req, key) {
  if (!DELETE_PASSKEY) return { code: 403, error: 'Deleting is switched off. The owner must set DELETE_PASSKEY on the server.' };
  const ip = clientIp(req);
  if (isLocked('key', ip)) return { code: 429, error: 'Too many wrong passkeys. Try again in 15 minutes.' };
  const hash = (s) => crypto.createHash('sha256').update(String(s ?? '')).digest();
  if (!crypto.timingSafeEqual(hash(key), hash(DELETE_PASSKEY))) { noteFail('key', ip); return { code: 403, error: 'Wrong delete passkey' }; }
  attempts.key.delete(ip);
  return null;
}

// ---------- NCM calls ----------
async function ncm(method, p, body) {
  const res = await fetch(NCM_BASE + p, {
    method,
    headers: { Authorization: 'Token ' + NCM_TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) { const e = new Error('NCM error ' + res.status); e.status = res.status; e.data = data; throw e; }
  return data;
}

// NCM wraps lists in different shapes ([...], {data:[...]}, {data:{branches:[...]}}, {"1":{...}}); find the list wherever it is.
function toList(d, depth = 0) {
  // NCM sometimes sends the data as a JSON string inside the JSON, so unpack it first
  if (typeof d === 'string') {
    const t = d.trim();
    if (t[0] === '[' || t[0] === '{') { try { d = JSON.parse(t); } catch { return []; } } else return [];
  }
  if (Array.isArray(d)) return d;
  if (!d || typeof d !== 'object' || depth > 3) return [];
  for (const k of ['data', 'results', 'result', 'branches', 'branchlist', 'items', 'orders']) {
    if (d[k] != null) { const l = toList(d[k], depth + 1); if (l.length) return l; }
  }
  const vals = Object.values(d);
  const firstArr = vals.find((v) => Array.isArray(v) && v.length);
  if (firstArr) return firstArr;
  if (vals.length && vals.every((v) => v && typeof v === 'object')) return vals;
  return [];
}

let branchCache = null; // [{name, raw}]
async function getBranchObjs() {
  if (branchCache) return branchCache;
  if (TEST_MODE) return ['KATHMANDU', 'TINKUNE', 'POKHARA', 'BIRATNAGAR', 'BUTWAL', 'CHITWAN'].map((name) => ({ name, raw: {}, areas: [], district: '', phone: '' }));
  const d = await ncm('GET', '/api/v1/branchlist');
  // Real NCM row layout: [name, code, covered areas (comma separated), municipality, district, province, phone, phone2, address]
  const parse = (b) => {
    if (typeof b === 'string') return { name: b, areas: [], district: '', phone: '', raw: {} };
    if (Array.isArray(b)) {
      return { name: b[0] ? String(b[0]).trim() : '', raw: {}, district: b[4] || '', phone: b[6] || '',
        areas: String(b[2] || '').split(/[,;\n]/).map((s) => s.trim()).filter(Boolean) };
    }
    const raw = b || {};
    return { name: raw.name || raw.branch_name || raw.branch || raw.Name, raw, areas: areasOf(raw), district: raw.district || '', phone: raw.phone || '' };
  };
  const list = toList(d).map(parse).filter((b) => b.name);
  if (!list.length) throw new Error('Could not read the branch list. NCM sent: ' + JSON.stringify(d).slice(0, 250));
  branchCache = list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return branchCache;
}
const getBranches = async () => (await getBranchObjs()).map((b) => b.name);

// Covered areas: NCM's field name isn't documented publicly, so look for any field that looks like coverage/areas.
function areasOf(raw) {
  const key = Object.keys(raw).find((k) => /cover|area/i.test(k) && raw[k]);
  if (!key) return [];
  const v = raw[key];
  const arr = Array.isArray(v) ? v : String(v).split(/[,;\n]/);
  return arr.map((s) => String(s).trim()).filter(Boolean);
}
const RATE_TYPE = { Door2Door: 'Pickup/Collect', Branch2Door: 'Send', Door2Branch: 'D2B', Branch2Branch: 'B2B' };
const rateCache = new Map();

async function statusOf(order) {
  if (TEST_MODE || !order.ncmId) return order.status;
  try {
    const d = await ncm('GET', '/api/v1/order/status?id=' + encodeURIComponent(order.ncmId));
    const arr = toList(d);
    if (arr.length) {
      const last = arr[arr.length - 1];
      return typeof last === 'string' ? last : last.status || order.status;
    }
  } catch {}
  return order.status;
}
// find the first non-empty value whose key matches re, anywhere in a nested response
function findKey(obj, re, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return '';
  for (const [k, v] of Object.entries(obj)) {
    if (re.test(k) && (typeof v === 'string' || typeof v === 'number') && String(v).trim()) return String(v).trim();
  }
  for (const v of Object.values(obj)) { const r = findKey(v, re, depth + 1); if (r) return r; }
  return '';
}
// NCM's order-detail reply isn't documented publicly, so look for the tracking ID under any "track..." key.
async function fetchTrackId(ncmId) {
  try { return findKey(await ncm('GET', '/api/v1/order?id=' + encodeURIComponent(ncmId)), /track/i); } catch { return ''; }
}
// A bill has one or more products. Older single-line bills (particulars/qty/rate) are still understood.
function makeBill(b, o) {
  if (!b || b.on === false) return null;
  const src = Array.isArray(b.items) ? b.items : [{ name: b.particulars, qty: b.qty, rate: b.rate }];
  const items = src.slice(0, 30).map((x) => {
    const qty = Number(x && x.qty) > 0 ? Number(x.qty) : 1, rate = Math.max(0, Number(x && x.rate) || 0);
    return { name: clean(x && x.name, 200), qty, rate, amount: Math.round(qty * rate * 100) / 100 };
  }).filter((x) => x.name || x.rate > 0);
  const total = Math.round(items.reduce((s, x) => s + x.amount, 0) * 100) / 100;
  const discount = Math.min(total, Math.max(0, Number(b.discount) || 0));
  return { no: clean(b.no, 40), date: clean(b.date, 20), items, total, discount, grand: Math.round((total - discount) * 100) / 100 };
}
const phone10 = (v) => digits(v).slice(-10);
function snapshot(o) { return { deliveryType: o.deliveryType, from: o.from, to: o.to, packageType: o.packageType, weight: o.weight || 0, cod: o.cod || 0, description: o.description || '', priority: o.priority || 'Normal' }; }
// Saves/updates the customer behind an order. The newest order's name, address and alternate phone win.
function upsertCustomer(list, o, when = new Date().toISOString()) {
  const p = phone10(o.phone); if (p.length < 10) return;
  let c = list.find((x) => phone10(x.phone) === p || (x.phone2 && phone10(x.phone2) === p));
  if (!c) { c = { id: crypto.randomUUID(), createdAt: when }; list.push(c); }
  Object.assign(c, { name: o.name, address: o.address, phone: c.phone || o.phone, phone2: o.phone2 || c.phone2 || '', last: snapshot(o), lastOrderAt: when, updatedAt: when });
}
function statsByPhone(orders) {
  const m = new Map();
  const add = (p, o) => { if (p.length < 10) return; let s = m.get(p); if (!s) m.set(p, (s = { orders: 0, delivered: 0, returned: 0 })); s.orders++; const k = kind(o.status); if (k === 'delivered') s.delivered++; else if (k === 'returned') s.returned++; };
  for (const o of orders) { const a = phone10(o.phone), b = phone10(o.phone2); add(a, o); if (b && b !== a) add(b, o); }
  return m;
}
const cleanWeight = (v) => Math.min(1000, Math.max(0, Math.round((Number(v) || 0) * 100) / 100));
const cleanOrder = (b) => ({
  deliveryType: clean(b.deliveryType, 20), from: clean(b.from, 60), to: clean(b.to, 60),
  name: clean(b.name, 100), address: clean(b.address, 250), phone: digits(b.phone), phone2: digits(b.phone2),
  packageType: clean(b.packageType, 100), cod: Math.max(0, Math.round(Number(b.cod) || 0)),
  description: clean(b.description, 300), priority: clean(b.priority, 10), weight: cleanWeight(b.weight),
});
const orderProblem = (o) =>
  !DELIVERY_TYPES.includes(o.deliveryType) ? 'Choose a delivery type' :
  !o.from || !o.to ? 'Choose origin and destination' :
  !o.name || !o.address ? 'Customer name and address are required' :
  o.phone.length < 10 ? 'Enter a valid 10-digit phone number' :
  o.phone2 && o.phone2.length < 10 ? 'Phone number 2 must be 10 digits, or leave it empty' :
  !o.packageType ? 'Enter the package type' :
  !PRIORITIES.includes(o.priority) ? 'Choose a priority' : '';
// NCM has no priority field, so priority + description go into the instruction text
function ncmPayload(o) {
  const instruction = [o.priority !== 'Normal' ? '[' + o.priority.toUpperCase() + ']' : '', o.description].filter(Boolean).join(' ');
  const p = { name: o.name, phone: o.phone, phone2: o.phone2 || undefined, cod_charge: String(o.cod), address: o.address,
    fbranch: o.from, branch: o.to, package: o.packageType, vref_id: VREF_ID, instruction, delivery_type: o.deliveryType };
  if (o.weight > 0) p.weight = String(o.weight);
  return p;
}
const FINAL = /deliver|return/i;
const kind = (s = '') => (/return/i.test(s) ? 'returned' : /delivered/i.test(s) ? 'delivered' : 'other');

// ---------- helpers ----------
const clean = (v, max = 300) => String(v ?? '').trim().slice(0, max);
const digits = (v) => String(v ?? '').replace(/\D/g, '');
function send(res, code, obj, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const ip = clientIp(req);
      if (isLocked('login', ip)) return send(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
      const { passcode } = await readBody(req);
      if (passcode !== PASSCODE) { noteFail('login', ip); return send(res, 401, { error: 'Wrong passcode' }); }
      attempts.login.delete(ip);
      return send(res, 200, { ok: true }, { 'Set-Cookie': `sess=${makeSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
    }
    if (url.pathname === '/api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': 'sess=; Path=/; Max-Age=0' });

    if (url.pathname.startsWith('/api/')) {
      if (!isAuthed(req)) return send(res, 401, { error: 'login' });

      if (url.pathname === '/api/config') return send(res, 200, { vref: VREF_ID, testMode: TEST_MODE, deliveryTypes: DELIVERY_TYPES, priorities: PRIORITIES, trackUrl: TRACK_URL, deleteEnabled: !!DELETE_PASSKEY });
      if (url.pathname === '/api/branches') return send(res, 200, { branches: await getBranches() });
      if (url.pathname === '/api/branchdata') return send(res, 200, { branches: (await getBranchObjs()).map((b) => ({ name: b.name, district: b.district || '', areas: b.areas || [] })) });

      if (url.pathname === '/api/branch') {
        const b = (await getBranchObjs()).find((x) => x.name === url.searchParams.get('name'));
        if (!b) return send(res, 404, { error: 'Unknown branch' });
        return send(res, 200, { name: b.name, areas: b.areas, district: b.district, phone: b.phone });
      }

      if (url.pathname === '/api/rate') {
        const from = clean(url.searchParams.get('from'), 60), to = clean(url.searchParams.get('to'), 60), type = url.searchParams.get('type');
        if (!from || !to || !RATE_TYPE[type]) return send(res, 400, { error: 'from, to and type are required' });
        if (TEST_MODE) return send(res, 200, { charge: null, note: 'Delivery charge shows once the API key is added' });
        const w = Math.max(0, Number(url.searchParams.get('weight')) || 0), key = [from, to, type, w].join('|');
        const hit = rateCache.get(key);
        if (hit && Date.now() - hit.t < 6 * 3600e3) return send(res, 200, { charge: hit.charge });
        const q = new URLSearchParams({ creation: from, destination: to, type: RATE_TYPE[type] });
        if (w > 0) q.set('weight', String(w));
        const d = await ncm('GET', '/api/v1/shipping-rate?' + q);
        const charge = d.charge ?? d.delivery_charge ?? (d.data && (d.data.charge ?? d.data.delivery_charge)) ?? null;
        if (charge !== null) rateCache.set(key, { t: Date.now(), charge });
        return send(res, 200, { charge });
      }

      if (url.pathname === '/api/history') {
        const p = digits(url.searchParams.get('phone')).slice(-10);
        if (p.length < 10) return send(res, 200, { orders: [], delivered: 0, returned: 0, other: 0 });
        const all = await loadOrders();
        const mine = all.filter((o) => digits(o.phone).endsWith(p) || digits(o.phone2).endsWith(p));
        let changed = false;
        for (const o of mine.slice(-10)) {
          if (!FINAL.test(o.status || '')) { const s = await statusOf(o); if (s !== o.status) { o.status = s; changed = true; } }
        }
        if (changed) await saveOrders(all);
        const cust = (await loadCustomers()).find((x) => phone10(x.phone) === p || (x.phone2 && phone10(x.phone2) === p));
        const orders = mine.slice().reverse().slice(0, 20);
        const count = (k) => mine.filter((o) => kind(o.status) === k).length;
        return send(res, 200, { orders, delivered: count('delivered'), returned: count('returned'), other: count('other'), lastName: orders[0]?.name, lastAddress: orders[0]?.address, customer: cust ? { name: cust.name, address: cust.address, phone2: cust.phone2 || '' } : null });
      }

      if (url.pathname === '/api/orders' && req.method === 'POST') {
        // Saving only keeps the order on this site as a draft. It is sent to NCM later, from the Orders tab.
        const o = cleanOrder(await readBody(req));
        const err = orderProblem(o);
        if (err) return send(res, 400, { error: err });
        const all = await loadOrders();
        const rec = { id: crypto.randomUUID().slice(0, 8), ...o, ncmId: null, trackId: '', draft: true, status: 'Draft (not sent to NCM)', createdAt: new Date().toISOString() };
        all.push(rec); await saveOrders(all);
        try { const cs = await loadCustomers(); upsertCustomer(cs, rec); await saveCustomers(cs); } catch (e) { console.error('customer save failed:', e.message); }
        return send(res, 200, { ok: true, order: rec });
      }

      if (url.pathname === '/api/lastbill') {
        const all = await loadOrders();
        for (let i = all.length - 1; i >= 0; i--) if (all[i].bill && all[i].bill.no) return send(res, 200, { no: all[i].bill.no });
        return send(res, 200, { no: '' });
      }

      if (url.pathname === '/api/customers' && req.method === 'GET') {
        const cs = await loadCustomers(), orders = await loadOrders();
        if (!(await loadList('meta')).length) { // first time: build the list from orders placed so far (oldest first, so the newest wins)
          for (const o of orders) upsertCustomer(cs, o, o.createdAt);
          await saveCustomers(cs); await saveList('meta', [{ backfilled: new Date().toISOString() }]);
        }
        const q = clean(url.searchParams.get('q'), 60).toLowerCase(), st = statsByPhone(orders);
        let list = q ? cs.filter((c) => [c.name, c.phone, c.phone2, c.address].join(' ').toLowerCase().includes(q)) : cs.slice();
        list.sort((a, b) => String(b.lastOrderAt || b.createdAt).localeCompare(String(a.lastOrderAt || a.createdAt)));
        const empty = { orders: 0, delivered: 0, returned: 0 };
        return send(res, 200, { total: list.length, customers: list.slice(0, 200).map((c) => ({ ...c, stats: st.get(phone10(c.phone)) || (c.phone2 && st.get(phone10(c.phone2))) || empty })) });
      }
      if (url.pathname === '/api/customers' && req.method === 'POST') {
        const b = await readBody(req);
        const c0 = { name: clean(b.name, 100), address: clean(b.address, 250), phone: digits(b.phone), phone2: digits(b.phone2) };
        if (!c0.name || phone10(c0.phone).length < 10) return send(res, 400, { error: 'A name and a 10-digit phone number are required' });
        if (c0.phone2 && c0.phone2.length < 10) return send(res, 400, { error: 'Phone number 2 must be 10 digits, or leave it empty' });
        const cs = await loadCustomers(), now = new Date().toISOString();
        const dup = cs.find((x) => x.id !== b.id && (phone10(x.phone) === phone10(c0.phone) || (x.phone2 && phone10(x.phone2) === phone10(c0.phone))));
        if (dup) return send(res, 400, { error: 'A customer with this phone number already exists (' + dup.name + ')' });
        if (b.id) { const c = cs.find((x) => x.id === b.id); if (!c) return send(res, 404, { error: 'Customer not found' }); Object.assign(c, c0, { updatedAt: now }); }
        else cs.push({ id: crypto.randomUUID(), ...c0, createdAt: now, updatedAt: now });
        await saveCustomers(cs);
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/customers/delete' && req.method === 'POST') {
        const b = await readBody(req);
        const bad = checkDeleteKey(req, b.passkey); if (bad) return send(res, bad.code, { error: bad.error });
        const cs = await loadCustomers();
        if (!cs.some((x) => x.id === b.id)) return send(res, 404, { error: 'Customer not found' });
        await saveCustomers(cs.filter((x) => x.id !== b.id));
        return send(res, 200, { ok: true });
      }

      if (url.pathname === '/api/order' && req.method === 'GET') {
        const o = byId(await loadOrders(), clean(url.searchParams.get('id'), 40));
        return o ? send(res, 200, { order: o }) : send(res, 404, { error: 'Order not found' });
      }

      // ---- order list + tracking ----
      if (url.pathname === '/api/orders' && req.method === 'GET') {
        const q = clean(url.searchParams.get('q'), 60).toLowerCase();
        let list = (await loadOrders()).slice().reverse();
        const flt = url.searchParams.get('filter');
        if (flt === 'draft') list = list.filter((o) => o.draft); else if (flt === 'sent') list = list.filter((o) => !o.draft);
        if (q) list = list.filter((o) => [o.name, o.phone, o.phone2, o.ncmId, o.trackId, o.bill && o.bill.no, o.to, o.status, o.draft ? 'draft not sent' : ''].join(' ').toLowerCase().includes(q));
        return send(res, 200, { orders: list.slice(0, 100), total: list.length });
      }

      if (url.pathname === '/api/track') {
        const id = clean(url.searchParams.get('id'), 40);
        const all = await loadOrders();
        const order = byId(all, id);
        if (!order) return send(res, 404, { error: 'Order not found' });
        if (TEST_MODE || order.draft || !order.ncmId || String(order.ncmId).startsWith('TEST-')) return send(res, 200, { order, history: [{ status: order.status, time: order.createdAt }], comments: [] });
        const pick = (x, ...keys) => { for (const k of keys) if (x && x[k] != null && x[k] !== '') return x[k]; return ''; };
        const arr = toList;
        const [st, cm] = await Promise.allSettled([ncm('GET', '/api/v1/order/status?id=' + encodeURIComponent(order.ncmId)), ncm('GET', '/api/v1/order/comment?id=' + encodeURIComponent(order.ncmId))]);
        const history = st.status === 'fulfilled' ? arr(st.value).map((x) => typeof x === 'string' ? { status: x, time: '' } : { status: pick(x, 'status', 'Status'), time: pick(x, 'added_time', 'addedTime', 'time', 'date') }) : [];
        const comments = cm.status === 'fulfilled' ? arr(cm.value).map((x) => typeof x === 'string' ? { text: x } : { text: pick(x, 'comments', 'comment', 'text'), by: pick(x, 'addedBy', 'added_by', 'user'), time: pick(x, 'added_time', 'addedTime', 'time', 'date') }) : [];
        if (!history.length && st.status === 'rejected') return send(res, 502, { error: 'Courier tracking unavailable: ' + st.reason.message });
        const latest = history.length ? history[history.length - 1].status : order.status;
        let dirty = false;
        if (latest && latest !== order.status) { order.status = latest; dirty = true; }
        if (!order.trackId && !order.trackTried) { order.trackId = await fetchTrackId(order.ncmId); order.trackTried = true; dirty = true; }
        if (dirty) await saveOrders(all);
        return send(res, 200, { order, history, comments });
      }

      // ---- edit / delete / message ----
      // NCM's public API has no documented edit or cancel call, so edits and deletes change THIS site's list only.
      // To reach NCM, we post a comment on the order (the same comment feature NCM shows its staff).
      if (url.pathname.startsWith('/api/order/') && req.method === 'POST') {
        const b = await readBody(req);
        const all = await loadOrders();
        const o = byId(all, b.id ?? b.ncmId);
        if (!o) return send(res, 404, { error: 'Order not found' });
        const live = !o.draft && !TEST_MODE && !!o.ncmId && !String(o.ncmId).startsWith('TEST-');
        const comment = (text) => ncm('POST', '/api/v1/order/comment', { orderid: Number(o.ncmId) || o.ncmId, comments: String(text).slice(0, 500) });

        if (url.pathname === '/api/order/send') {
          // The one place an NCM shipment is created. Guarded so one order can never be sent twice.
          if (!o.draft) return send(res, 409, { error: 'This order was already sent to NCM' + (o.ncmId ? ' (Order ID #' + o.ncmId + ')' : '') });
          if (sending.has(o.id)) return send(res, 409, { error: 'This order is already being sent, please wait a moment' });
          const bad = orderProblem(o); if (bad) return send(res, 400, { error: bad });
          sending.add(o.id);
          try {
            let ncmId = null, trackId = '', status;
            if (TEST_MODE) { ncmId = 'TEST-' + Date.now().toString().slice(-6); status = 'Test order (not sent to NCM)'; }
            else {
              const r = await ncm('POST', '/api/v1/order/create', ncmPayload(o));
              ncmId = r.orderid ?? r.order_id ?? r.id ?? (r.data && (r.data.orderid ?? r.data.id)) ?? (findKey(r, /^order_?id$/i) || null);
              trackId = findKey(r, /track/i);
              if (!trackId && ncmId) trackId = await fetchTrackId(ncmId);
              status = ncmId ? 'Pickup Order Created' : 'Sent to NCM (order ID not returned)';
            }
            // NCM now has it. Re-read the list so edits made meanwhile aren't lost, then mark it sent.
            const fresh = await loadOrders();
            const t = byId(fresh, o.id) || (fresh.push(o), o);
            Object.assign(t, { ncmId, trackId, status, sentAt: new Date().toISOString() }); delete t.draft;
            await saveOrders(fresh);
            return send(res, 200, { ok: true, order: t });
          } finally { sending.delete(o.id); }
        }

        if (url.pathname === '/api/order/update') {
          const next = { deliveryType: clean(b.deliveryType, 20), from: clean(b.from, 60), to: clean(b.to, 60), priority: clean(b.priority, 10),
            name: clean(b.name, 100), address: clean(b.address, 250), phone: digits(b.phone), phone2: digits(b.phone2),
            packageType: clean(b.packageType, 100), cod: Math.max(0, Math.round(Number(b.cod) || 0)), description: clean(b.description, 300), weight: cleanWeight(b.weight) };
          const bad = orderProblem(next); if (bad) return send(res, 400, { error: bad });
          const changes = Object.keys(next).filter((k) => String(o[k] ?? '') !== String(next[k]));
          Object.assign(o, next, { editedAt: new Date().toISOString() });
          await saveOrders(all);
          let noteSent = false, noteError = '';
          if (b.notify && live && changes.length) {
            try { await comment('Vendor updated details: ' + changes.map((k) => `${k}: ${next[k]}`).join('; ')); noteSent = true; } catch (e) { noteError = e.message; }
          }
          return send(res, 200, { ok: true, order: o, changes: changes.length, noteSent, noteError });
        }
        if (url.pathname === '/api/order/note') {
          const text = clean(b.text, 500);
          if (!text) return send(res, 400, { error: 'Write a message first' });
          if (o.draft) return send(res, 400, { error: 'This order has not been sent to NCM yet. Send it first.' });
          if (!live) return send(res, 200, { ok: true, note: 'Test order: message not sent to NCM' });
          await comment(text);
          return send(res, 200, { ok: true });
        }
        if (url.pathname === '/api/order/bill') {
          if (b.remove) { delete o.bill; await saveOrders(all); return send(res, 200, { ok: true }); }
          if (!b.bill || !clean(b.bill.no, 40)) return send(res, 400, { error: 'Enter a bill number' });
          const bill = makeBill({ ...b.bill, on: true }, o);
          if (!bill.items.length) return send(res, 400, { error: 'Add at least one product to the bill' });
          o.bill = bill;
          await saveOrders(all);
          return send(res, 200, { ok: true, bill: o.bill });
        }
        if (url.pathname === '/api/order/delete') {
          const bad = checkDeleteKey(req, b.passkey); if (bad) return send(res, bad.code, { error: bad.error });
          await saveOrders(all.filter((x) => x !== o));
          return send(res, 200, { ok: true });
        }
        return send(res, 404, { error: 'Not found' });
      }

      if (url.pathname === '/api/refresh' && req.method === 'POST') {
        const all = await loadOrders();
        let n = 0;
        for (const o of all.slice().reverse()) {
          if (n >= 25) break;
          if (FINAL.test(o.status || '') || !o.ncmId || String(o.ncmId).startsWith('TEST-')) continue;
          n++; const s = await statusOf(o); if (s) o.status = s;
        }
        if (n) await saveOrders(all);
        return send(res, 200, { refreshed: n });
      }
      return send(res, 404, { error: 'Not found' });
    }

    // static files
    let f = url.pathname === '/' ? '/index.html' : url.pathname;
    if (f === '/bill') f = '/bill.html';
    const full = path.join(__dirname, 'public', path.normalize(f).replace(/^(\.\.[/\\])+/, ''));
    if (!full.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    console.error(e.status || '', e.message, JSON.stringify(e.data || ''));
    const msg = e.data ? (typeof e.data === 'string' ? e.data : JSON.stringify(e.data)) : e.message;
    if (e.status === 401 || e.status === 403) {
      return send(res, 400, { error: 'NCM rejected the API key (' + msg.slice(0, 80) + '). Check NCM_TOKEN on Render: paste only the key, and make sure it belongs to the same system as NCM_BASE_URL (a live-portal key needs https://portal.nepalcanmove.com, a sandbox key needs the sandbox address).' });
    }
    send(res, e.status && e.status < 500 ? 400 : 502, { error: (e.status ? 'Courier said: ' : 'Problem: ') + msg.slice(0, 300) });
  }
}).listen(PORT, () => console.log(`Running on :${PORT}  ${TEST_MODE ? '(TEST MODE: no NCM_TOKEN set)' : '(live: ' + NCM_BASE + ')'}`));
