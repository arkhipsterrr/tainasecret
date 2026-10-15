const $ = (id) => document.getElementById(id);
const out = (msg) => { $('out').textContent = msg; };

async function loadSettings() {
  const { server = '', token = '' } = await chrome.storage.local.get(['server', 'token']);
  $('server').value = server;
  $('token').value = token;
}

async function settings() {
  const server = $('server').value.trim().replace(/\/$/, '');
  const token = $('token').value.trim();
  return { server, token };
}

function authHeaders(token) {
  const h = { 'content-type': 'application/json' };
  if (token) h['authorization'] = 'Bearer ' + token;
  return h;
}

// Map a chrome.cookies.Cookie to a Playwright storageState cookie shape.
function toCookie(c) {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires: c.session ? -1 : Math.round(c.expirationDate || -1),
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: c.sameSite || 'unspecified',
  };
}

const LOGIN_URL = 'https://www.j-subculture.com/en/users/login';
const MYPAGE_URL = 'https://www.j-subculture.com/en/users/';

// j-subculture has no distinct "logged in" cookie — login lives server-side and
// the session cookie is present whether you're in or out. So the only reliable
// check is to actually request My Page (cookies are sent thanks to
// host_permissions) and see whether the site serves it or bounces us to /login.
// Returns: 'in' | 'out' | 'unknown'.
async function probeSiteLogin() {
  try {
    const res = await fetch(MYPAGE_URL, {
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
    });
    const finalUrl = res.url || '';
    let html = '';
    try { html = await res.text(); } catch {}
    const bouncedToLogin =
      /\/users\/login/i.test(finalUrl) ||
      /name=["']?login_(email|pass|memid)/i.test(html);
    let verdict = 'unknown';
    if (bouncedToLogin) verdict = 'out';
    else if (res.ok) verdict = 'in';
    return { verdict, status: res.status, finalUrl, redirected: res.redirected };
  } catch (e) {
    return { verdict: 'unknown', status: 0, finalUrl: '', redirected: false, error: e.message };
  }
}

async function getSiteCookies() {
  // Merge several queries: the plain domain filter misses cookies in some
  // cases (partitioned/CHIPS, host-only on a subdomain), so also query by the
  // concrete URLs we care about and dedupe by name+domain+path.
  const queries = [
    chrome.cookies.getAll({ domain: 'j-subculture.com' }),
    chrome.cookies.getAll({ url: 'https://www.j-subculture.com/' }),
    chrome.cookies.getAll({ url: 'https://j-subculture.com/' }),
    chrome.cookies.getAll({ url: 'https://www.j-subculture.com/en/users/' }),
  ];
  const results = await Promise.allSettled(queries);
  const seen = new Set();
  const merged = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const c of r.value) {
      const key = `${c.name}|${c.domain}|${c.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(c);
    }
  }
  return merged.map(toCookie);
}

// Human-readable dump for debugging what the browser actually exposes.
function describeCookies(cookies) {
  return cookies
    .map((c) => `${c.name} (${c.domain}${c.httpOnly ? ', httpOnly' : ''})`)
    .join('\n');
}

// Live check shown in the popup. Login can't be told from cookies here, so we
// ask the site directly (My Page vs redirect to login).
async function refreshStatus() {
  const el = $('status');
  try {
    const cookies = await getSiteCookies();
    el.textContent = `Checking login… (${cookies.length} cookies)`;
    el.style.color = '#555';
    const p = await probeSiteLogin();
    if (p.verdict === 'in') {
      el.textContent = `Site login: ✅ logged in (${cookies.length} cookies)`;
      el.style.color = '#1a7f37';
    } else if (p.verdict === 'out') {
      el.textContent = `Site login: ❌ not logged in (${cookies.length} cookies)`;
      el.style.color = '#b3261e';
    } else {
      el.textContent = `Site login: ? can't verify (HTTP ${p.status}) — ${cookies.length} cookies`;
      el.style.color = '#8a6d00';
    }
  } catch (e) {
    el.textContent = 'Site login: ? ' + e.message;
  }
}

$('save').addEventListener('click', async () => {
  const s = await settings();
  await chrome.storage.local.set(s);
  out('Settings saved.');
});

$('sync').addEventListener('click', async () => {
  const { server, token } = await settings();
  if (!server) return out('Set the server URL first.');
  out('Verifying login on j-subculture.com…');
  try {
    const cookies = await getSiteCookies();
    const p = await probeSiteLogin();

    // Only refuse when the site positively says we're logged out, so a WAF
    // hiccup or challenge (verdict 'unknown') can't permanently block a sync.
    if (p.verdict === 'out') {
      refreshStatus();
      return out(
        `NOT logged in on j-subculture.com — nothing was sent.\n` +
        `(My Page redirected to login: ${p.finalUrl || 'HTTP ' + p.status})\n` +
        `Log in on the site, then click Sync again.\n\n` +
        `cookies:\n${describeCookies(cookies)}`
      );
    }

    const note = p.verdict === 'in'
      ? 'login confirmed'
      : `login unverified (HTTP ${p.status}${p.error ? ', ' + p.error : ''}) — sending anyway`;
    out(`Sending ${cookies.length} cookies (${note})…`);
    const res = await fetch(server + '/session/import', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ cookies }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return out(`Import failed: HTTP ${res.status}\n${JSON.stringify(body)}`);
    out(`Imported ${body.importedCookies} cookies.\nSession valid until: ${body.authValidUntil || 'unknown'}`);
  } catch (e) {
    out('Error: ' + e.message);
  }
});

$('check').addEventListener('click', async () => {
  const { server, token } = await settings();
  if (!server) return out('Set the server URL first.');
  out('Checking…');
  try {
    const health = await fetch(server + '/health').then((r) => r.status).catch(() => 'unreachable');
    const sess = await fetch(server + '/session', { headers: authHeaders(token) })
      .then((r) => r.json()).catch(() => ({}));
    out(`/health: ${health}\n/session: ${JSON.stringify(sess)}`);
  } catch (e) {
    out('Error: ' + e.message);
  }
});

$('opensite').addEventListener('click', () => chrome.tabs.create({ url: LOGIN_URL }));

loadSettings();
refreshStatus();
