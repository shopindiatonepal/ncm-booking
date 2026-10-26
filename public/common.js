// Shared by the booking page and the bill page. //

// AD -> BS. Table covers BS 2083 (14 Apr 2026 - 13 Apr 2027) only; outside that, type the date yourself.
const BS2083 = [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31];
function todayBS() {
  const start = Date.UTC(2026, 3, 14), now = new Date();
  let days = Math.floor((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - start) / 864e5);
  if (days < 0) return '';
  let m = 0;
  while (m < 12 && days >= BS2083[m]) { days -= BS2083[m]; m++; }
  if (m >= 12) return '';
  return `2083/${String(m + 1).padStart(2, '0')}/${String(days + 1).padStart(2, '0')}`;
}

// add 1 to the last number in the text, keeping zeros and letters: 099 -> 100, A-241 -> A-242
function incrBill(s) {
  const m = /^(.*?)(\d+)(\D*)$/.exec(s);
  if (!m) return s + '1';
  const n = String(Number(m[2]) + 1).padStart(m[2].length, '0');
  return m[1] + n + m[3];
}

// The bill counter lives in this browser, so the booking page and the bill page share it.
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
function lsDel(k) { try { localStorage.removeItem(k); } catch {} }
function nextBillNo() {
  const forced = lsGet('bill_next'), last = lsGet('bill_lastNo');
  return forced || (last ? incrBill(last) : '1');
}
function markBillUsed(no) {
  no = String(no || '').trim();
  if (no) { lsSet('bill_lastNo', no); lsDel('bill_next'); }
}
