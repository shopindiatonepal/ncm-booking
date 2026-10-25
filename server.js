// NCM partner booking site — zero dependencies, needs Node 18+.
// The vendor API token lives ONLY here (environment variable), never in the browser.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const NCM_TOKEN = process.env.NCM_TOKEN || '';
const NCM_BASE = (process.env.NCM_BASE_URL || 'https://portal.nepalcanmove.com').replace(/\/$/, '');
const VREF_ID = process.env.VREF_ID || '31180'; // fixed, partner cannot change it
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
async function loadOrders() {
  if (KV_URL) { const v = await kv(['GET', 'orders']); return v ? JSON.parse(v) : []; }
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return []; }
}
async function saveOrders(o) {
  if (KV_URL) return void (await kv(['SET', 'orders', JSON.stringify(o)]));
  fs.writeFileSync(DATA_FILE, JSON.stringify(o, null, 1));
}

// ---------- tiny session cookie ----------
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
function makeSession() { const exp = String(Date.now() + 1000 * 60 * 60 * 24 * 30); return exp + '.' + sign(exp); }
function isAuthed(req) {
  const m = /(?:^|;\s*)sess=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  return !!exp && sig === sign(exp) && Number(exp) > Date.now();
}
let failedLogins = {};

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
  if (TEST_MODE) return ['KATHMANDU', 'TINKUNE', 'POKHARA', 'BIRATNAGAR', 'BUTWAL', 'CHITWAN'].map((name) => ({ name, raw: {} }));
  const d = await ncm('GET', '/api/v1/branchlist');
  const nameOf = (b) => typeof b === 'string' ? b : Array.isArray(b) ? b.find((x) => typeof x === 'string') : b && (b.name || b.branch_name || b.branch || b.Name);
  const list = toList(d).map((b) => ({ name: nameOf(b), raw: b && typeof b === 'object' && !Array.isArray(b) ? b : {} })).filter((b) => b.name);
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
      const ip = req.socket.remoteAddress;
      if ((failedLogins[ip] || 0) >= 10) return send(res, 429, { error: 'Too many attempts. Try later.' });
      const { passcode } = await readBody(req);
      if (passcode !== PASSCODE) { failedLogins[ip] = (failedLogins[ip] || 0) + 1; return send(res, 401, { error: 'Wrong passcode' }); }
      return send(res, 200, { ok: true }, { 'Set-Cookie': `sess=${makeSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
    }
    if (url.pathname === '/api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': 'sess=; Path=/; Max-Age=0' });

    if (url.pathname.startsWith('/api/')) {
      if (!isAuthed(req)) return send(res, 401, { error: 'login' });

      if (url.pathname === '/api/config') return send(res, 200, { vref: VREF_ID, testMode: TEST_MODE, deliveryTypes: DELIVERY_TYPES, priorities: PRIORITIES });
      if (url.pathname === '/api/branches') return send(res, 200, { branches: await getBranches() });

      if (url.pathname === '/api/branch') {
        const b = (await getBranchObjs()).find((x) => x.name === url.searchParams.get('name'));
        if (!b) return send(res, 404, { error: 'Unknown branch' });
        return send(res, 200, { name: b.name, areas: areasOf(b.raw), district: b.raw.district || '', phone: b.raw.phone || '' });
      }

      if (url.pathname === '/api/rate') {
        const from = clean(url.searchParams.get('from'), 60), to = clean(url.searchParams.get('to'), 60), type = url.searchParams.get('type');
        if (!from || !to || !RATE_TYPE[type]) return send(res, 400, { error: 'from, to and type are required' });
        if (TEST_MODE) return send(res, 200, { charge: null, note: 'Delivery charge shows once the API key is added' });
        const key = [from, to, type].join('|');
        const hit = rateCache.get(key);
        if (hit && Date.now() - hit.t < 6 * 3600e3) return send(res, 200, { charge: hit.charge });
        const q = new URLSearchParams({ creation: from, destination: to, type: RATE_TYPE[type] });
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
        const orders = mine.slice().reverse().slice(0, 20);
        const count = (k) => mine.filter((o) => kind(o.status) === k).length;
        return send(res, 200, { orders, delivered: count('delivered'), returned: count('returned'), other: count('other'), lastName: orders[0]?.name, lastAddress: orders[0]?.address });
      }

      if (url.pathname === '/api/orders' && req.method === 'POST') {
        const b = await readBody(req);
        const o = {
          deliveryType: clean(b.deliveryType, 20), from: clean(b.from, 60), to: clean(b.to, 60),
          name: clean(b.name, 100), address: clean(b.address, 250), phone: digits(b.phone), phone2: digits(b.phone2),
          packageType: clean(b.packageType, 100), cod: Math.max(0, Math.round(Number(b.cod) || 0)),
          description: clean(b.description, 300), priority: clean(b.priority, 10),
        };
        const err =
          !DELIVERY_TYPES.includes(o.deliveryType) ? 'Choose a delivery type' :
          !o.from || !o.to ? 'Choose origin and destination' :
          !o.name || !o.address ? 'Customer name and address are required' :
          o.phone.length < 10 ? 'Enter a valid 10-digit phone number' :
          !o.packageType ? 'Enter the package type' :
          !PRIORITIES.includes(o.priority) ? 'Choose a priority' : '';
        if (err) return send(res, 400, { error: err });

        // NCM has no priority field, so priority + description go into the instruction text
        const instruction = [o.priority !== 'Normal' ? `[${o.priority.toUpperCase()}]` : '', o.description].filter(Boolean).join(' ');
        const payload = {
          name: o.name, phone: o.phone, phone2: o.phone2 || undefined, cod_charge: String(o.cod), address: o.address,
          fbranch: o.from, branch: o.to, package: o.packageType, vref_id: VREF_ID,
          instruction, delivery_type: o.deliveryType,
        };
        let ncmId = null, status = 'Created';
        if (TEST_MODE) { ncmId = 'TEST-' + Date.now().toString().slice(-6); status = 'Test order (not sent to NCM)'; }
        else {
          const r = await ncm('POST', '/api/v1/order/create', payload);
          ncmId = r.orderid ?? r.order_id ?? r.id ?? (r.data && (r.data.orderid ?? r.data.id)) ?? null;
          status = 'Pickup Order Created';
        }
        const all = await loadOrders();
        const rec = { ...o, ncmId, status, createdAt: new Date().toISOString() };
        all.push(rec); await saveOrders(all);
        return send(res, 200, { ok: true, order: rec });
      }

      // ---- order list + tracking ----
      if (url.pathname === '/api/orders' && req.method === 'GET') {
        const q = clean(url.searchParams.get('q'), 60).toLowerCase();
        let list = (await loadOrders()).slice().reverse();
        if (q) list = list.filter((o) => [o.name, o.phone, o.phone2, o.ncmId, o.to, o.status].join(' ').toLowerCase().includes(q));
        return send(res, 200, { orders: list.slice(0, 100), total: list.length });
      }

      if (url.pathname === '/api/track') {
        const id = clean(url.searchParams.get('id'), 40);
        const all = await loadOrders();
        const order = all.find((o) => String(o.ncmId) === id);
        if (!order) return send(res, 404, { error: 'Order not found' });
        if (TEST_MODE || String(id).startsWith('TEST-')) return send(res, 200, { order, history: [{ status: order.status, time: order.createdAt }], comments: [] });
        const pick = (x, ...keys) => { for (const k of keys) if (x && x[k] != null && x[k] !== '') return x[k]; return ''; };
        const arr = toList;
        const [st, cm] = await Promise.allSettled([ncm('GET', '/api/v1/order/status?id=' + encodeURIComponent(id)), ncm('GET', '/api/v1/order/comment?id=' + encodeURIComponent(id))]);
        const history = st.status === 'fulfilled' ? arr(st.value).map((x) => typeof x === 'string' ? { status: x, time: '' } : { status: pick(x, 'status', 'Status'), time: pick(x, 'added_time', 'addedTime', 'time', 'date') }) : [];
        const comments = cm.status === 'fulfilled' ? arr(cm.value).map((x) => typeof x === 'string' ? { text: x } : { text: pick(x, 'comments', 'comment', 'text'), by: pick(x, 'addedBy', 'added_by', 'user'), time: pick(x, 'added_time', 'addedTime', 'time', 'date') }) : [];
        if (!history.length && st.status === 'rejected') return send(res, 502, { error: 'Courier tracking unavailable: ' + st.reason.message });
        const latest = history.length ? history[history.length - 1].status : order.status;
        if (latest && latest !== order.status) { order.status = latest; await saveOrders(all); }
        return send(res, 200, { order, history, comments });
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
    send(res, e.status && e.status < 500 ? 400 : 502, { error: (e.status ? 'Courier said: ' : 'Problem: ') + msg.slice(0, 300) });
  }
}).listen(PORT, () => console.log(`Running on :${PORT}  ${TEST_MODE ? '(TEST MODE: no NCM_TOKEN set)' : '(live: ' + NCM_BASE + ')'}`));
