// 通訳コールセンターPoC サーバ
// ロール別アカウント認証（admin/user/interpreter/guide）＋単一ログイン。
// 言語別キュー / パターンA・B / 案内人 / 録画 / 管理画面 / 永続ログ / 位置情報。

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const geoip = require('geoip-lite');
const { AccessToken, EgressClient, EncodedFileOutput, EncodedFileType } = require('livekit-server-sdk');

const {
  LIVEKIT_URL = 'ws://localhost:7880',
  LIVEKIT_API_KEY = 'devkey',
  LIVEKIT_API_SECRET = 'secret',
  ADMIN_PASSWORD = 'admin1234',
  DATA_DIR = './data',
  PORT = 3001,
} = process.env;
const LIVEKIT_HTTP_URL = (process.env.LIVEKIT_HTTP_URL || LIVEKIT_URL).replace(/^ws/, 'http');
const egressClient = new EgressClient(LIVEKIT_HTTP_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

// ---------- Stripe（実決済・フェーズ2。キー未設定なら記録のみのフェーズ1動作にフォールバック） ----------
const { STRIPE_SECRET_KEY = '', STRIPE_PUBLISHABLE_KEY = '', STRIPE_WEBHOOK_SECRET = '', PUBLIC_BASE_URL = 'http://localhost:' + PORT } = process.env;
let stripe = null;
if (STRIPE_SECRET_KEY) { try { stripe = require('stripe')(STRIPE_SECRET_KEY); console.log('[stripe] 有効（実決済モード）'); } catch (e) { console.error('[stripe] SDK読み込み失敗（npm i stripe）:', e.message); } }
const stripeEnabled = () => !!stripe;
// 割当方式: 既定は手動（スタッフが一覧から応答）。AUTO_ASSIGN=1 で従来の自動割当に戻す。
const AUTO_ASSIGN = process.env.AUTO_ASSIGN === '1';

// ---------- DB ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT, name TEXT, language TEXT, mode TEXT, connect_mode TEXT,
  interpreter_name TEXT, guide_name TEXT,
  enqueued_at INTEGER, assigned_at INTEGER, ended_at INTEGER,
  wait_sec INTEGER, talk_sec INTEGER, recorded INTEGER DEFAULT 0, status TEXT,
  location TEXT, country TEXT, lat REAL, lon REAL, accuracy REAL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, type TEXT, actor TEXT, detail TEXT
);
CREATE TABLE IF NOT EXISTS languages (
  code TEXT PRIMARY KEY, label TEXT, enabled INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE, pass TEXT, role TEXT, display_name TEXT,
  languages TEXT, mode TEXT, connect_mode TEXT, enabled INTEGER DEFAULT 1
);
`);
const ensureCol = (t, c, ty) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${ty}`); };
['location TEXT', 'country TEXT', 'lat REAL', 'lon REAL', 'accuracy REAL'].forEach((s) => { const [c, ty] = s.split(' '); ensureCol('calls', c, ty); });

// ---- 課金（PPV）スキーマ（追加のみ・既定は課金OFF） ----
db.exec(`
CREATE TABLE IF NOT EXISTS settings ( key TEXT PRIMARY KEY, value TEXT );
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id INTEGER, session_id TEXT, user_id INTEGER, username TEXT,
  kind TEXT, amount INTEGER, currency TEXT DEFAULT 'jpy',
  status TEXT DEFAULT 'recorded', provider TEXT DEFAULT 'none', provider_ref TEXT,
  created_at INTEGER
);
`);
ensureCol('users', 'billing_required', 'INTEGER DEFAULT 0');
ensureCol('users', 'billing_mode', "TEXT DEFAULT 'member'");
ensureCol('calls', 'billed', 'INTEGER DEFAULT 0');
ensureCol('calls', 'charge_base', 'INTEGER DEFAULT 0');
ensureCol('calls', 'charge_ext', 'INTEGER DEFAULT 0');
ensureCol('calls', 'ext_count', 'INTEGER DEFAULT 0');
ensureCol('calls', 'charge_total', 'INTEGER DEFAULT 0');
ensureCol('calls', 'allowed_sec', 'INTEGER');
ensureCol('calls', 'currency', 'TEXT');
ensureCol('users', 'stripe_customer_id', 'TEXT');
ensureCol('users', 'stripe_pm_id', 'TEXT');
ensureCol('users', 'card_brand', 'TEXT');
ensureCol('users', 'card_last4', 'TEXT');

// パスワードハッシュ（scrypt・組み込みcrypto、追加依存なし）
const hashPw = (pw) => { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex'); };
const verifyPw = (pw, stored) => {
  if (!stored || !stored.includes(':')) return false;
  const [salt, h] = stored.split(':');
  const hh = crypto.scryptSync(pw, salt, 32).toString('hex');
  return h.length === hh.length && crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hh, 'hex'));
};

// 初期データ（言語マスタ / デモ用アカウント）
if (db.prepare('SELECT COUNT(*) c FROM languages').get().c === 0) {
  const ins = db.prepare('INSERT INTO languages(code,label,enabled,sort_order) VALUES(?,?,1,?)');
  [['en', 'English（英語）', 1], ['zh', '中文（中国語）', 2], ['ko', '한국어（韓国語）', 3], ['vi', 'Tiếng Việt（ベトナム語）', 4]].forEach((r) => ins.run(r[0], r[1], r[2]));
}
if (db.prepare('SELECT COUNT(*) c FROM users').get().c === 0) {
  const ins = db.prepare('INSERT INTO users(username,pass,role,display_name,languages,mode,connect_mode,enabled) VALUES(?,?,?,?,?,?,?,1)');
  ins.run('admin', hashPw(ADMIN_PASSWORD), 'admin', '管理者', null, null, null);
  // 動作確認用デモアカウント（本番では管理画面で作り直す）
  ins.run('reception1', hashPw('reception1'), 'user', '受付端末1', null, 'B', 'both');
  ins.run('int_en', hashPw('int_en'), 'interpreter', '通訳(英語)', JSON.stringify(['en']), null, null);
  ins.run('guide1', hashPw('guide1'), 'guide', '案内1', null, null, null);
  console.log('[seed] users: admin / reception1 / int_en / guide1（デモ。パスワードは要変更）');
}

const logEvent = (type, actor, detail) => db.prepare('INSERT INTO events(ts,type,actor,detail) VALUES(?,?,?,?)').run(Date.now(), type, actor || '', detail ? JSON.stringify(detail) : null);
const enabledLangs = () => db.prepare('SELECT code,label FROM languages WHERE enabled=1 ORDER BY sort_order,code').all();
const langLabel = (code) => (db.prepare('SELECT label FROM languages WHERE code=?').get(code)?.label || code);

// ================= 課金（PPV）ヘルパ =================
const BILLING_DEFAULTS = { base_price: 100, base_minutes: 5, ext_unit_minutes: 5, ext_price: 100, grace_sec: 15, currency: 'jpy' };
const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value;
const setSetting = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
for (const [k, v] of Object.entries(BILLING_DEFAULTS)) { if (getSetting('billing_' + k) == null) setSetting('billing_' + k, v); }
function getBilling() {
  const g = (k) => getSetting('billing_' + k);
  return {
    base_price: Number(g('base_price')), base_minutes: Number(g('base_minutes')),
    ext_unit_minutes: Number(g('ext_unit_minutes')), ext_price: Number(g('ext_price')),
    grace_sec: Number(g('grace_sec')) || 0, currency: g('currency') || 'jpy',
  };
}
function recordPayment(s, kind, amount, currency) {
  db.prepare('INSERT INTO payments(call_id,session_id,user_id,username,kind,amount,currency,status,provider,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(s.callId, s.id, s.userId || null, s.username || '', kind, amount, currency, 'recorded', 'none', Date.now());
}
// ---- Stripeヘルパ ----
async function ensureCustomer(urow) {
  if (!stripe) return null;
  if (urow.stripe_customer_id) return urow.stripe_customer_id;
  const c = await stripe.customers.create({ name: urow.display_name || urow.username, metadata: { app: 'interpreter-poc', user_id: String(urow.id), username: urow.username } });
  db.prepare('UPDATE users SET stripe_customer_id=? WHERE id=?').run(c.id, urow.id);
  return c.id;
}
// 保存カードへ off-session 課金
async function chargeOffSession(urow, amount, currency, meta) {
  const cust = await ensureCustomer(urow);
  if (!urow.stripe_pm_id) throw new Error('no_card');
  const pi = await stripe.paymentIntents.create({ amount, currency, customer: cust, payment_method: urow.stripe_pm_id, off_session: true, confirm: true, metadata: meta });
  if (pi.status !== 'succeeded') throw new Error('pi_status_' + pi.status);
  return pi;
}
// Webhook処理（カード保存確定・決済結果の反映）
async function handleStripeEvent(event) {
  const t = event.type; const o = (event.data && event.data.object) || {};
  if (t === 'checkout.session.completed' && o.mode === 'setup') {
    const si = typeof o.setup_intent === 'string' ? await stripe.setupIntents.retrieve(o.setup_intent) : o.setup_intent;
    const pmId = si && si.payment_method;
    if (pmId && o.customer) {
      let brand = null, last4 = null;
      try { const pm = await stripe.paymentMethods.retrieve(pmId); brand = pm.card && pm.card.brand; last4 = pm.card && pm.card.last4; } catch (_) {}
      db.prepare('UPDATE users SET stripe_pm_id=?,card_brand=?,card_last4=? WHERE stripe_customer_id=?').run(pmId, brand, last4, o.customer);
      try { await stripe.customers.update(o.customer, { invoice_settings: { default_payment_method: pmId } }); } catch (_) {}
      logEvent('card_registered', 'system', { customer: o.customer, brand, last4 });
    }
  } else if (t === 'payment_intent.succeeded') {
    db.prepare("UPDATE payments SET status='paid' WHERE provider_ref=?").run(o.id);
  } else if (t === 'payment_intent.payment_failed') {
    db.prepare("UPDATE payments SET status='failed' WHERE provider_ref=?").run(o.id);
  }
}

// 接続時の基本料課金。Stripe有効時は off-session 課金し、失敗なら通話を終了。
function chargeBase(s) {
  if (!s.billingRequired || s.baseCharged) return;
  const b = s.billing || getBilling();
  s.allowedSec = b.base_minutes * 60; s.extCount = 0; s.baseCharged = true; s.chargeTotal = b.base_price;
  const st = stripeEnabled() ? 'pending' : 'recorded';
  const info = db.prepare('INSERT INTO payments(call_id,session_id,user_id,username,kind,amount,currency,status,provider,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(s.callId, s.id, s.userId || null, s.username || '', 'base', b.base_price, b.currency, st, stripeEnabled() ? 'stripe' : 'none', Date.now());
  s.basePaymentRowId = info.lastInsertRowid;
  db.prepare('UPDATE calls SET billed=1,charge_base=?,charge_total=?,allowed_sec=?,ext_count=0,currency=? WHERE id=?')
    .run(b.base_price, b.base_price, s.allowedSec, b.currency, s.callId);
  logEvent('charge_base', s.username || '', { session: s.id, amount: b.base_price, allowedSec: s.allowedSec });
  if (stripeEnabled()) { s.baseChargeState = 'pending'; settleBase(s); } else { s.baseChargeState = 'paid'; }
}
async function settleBase(s) {
  try {
    const urow = db.prepare('SELECT * FROM users WHERE id=?').get(s.userId);
    const b = s.billing || getBilling();
    const pi = await chargeOffSession(urow, b.base_price, b.currency, { app: 'interpreter-poc', kind: 'base', call_id: String(s.callId), session: s.id });
    db.prepare("UPDATE payments SET status='paid',provider='stripe',provider_ref=? WHERE id=?").run(pi.id, s.basePaymentRowId);
    s.baseChargeState = 'paid';
    logEvent('charge_base_paid', s.username || '', { session: s.id, pi: pi.id, amount: b.base_price });
  } catch (e) {
    db.prepare("UPDATE payments SET status='failed',provider='stripe' WHERE id=?").run(s.basePaymentRowId);
    s.baseChargeState = 'failed'; s.billingError = 'カード決済に失敗しました（カード登録をご確認ください）';
    logEvent('charge_base_failed', s.username || '', { session: s.id, error: String(e.message || e) });
    endSession(s);
  }
}

const JP_PREF = { '01': '北海道', '02': '青森県', '03': '岩手県', '04': '宮城県', '05': '秋田県', '06': '山形県', '07': '福島県', '08': '茨城県', '09': '栃木県', '10': '群馬県', '11': '埼玉県', '12': '千葉県', '13': '東京都', '14': '神奈川県', '15': '新潟県', '16': '富山県', '17': '石川県', '18': '福井県', '19': '山梨県', '20': '長野県', '21': '岐阜県', '22': '静岡県', '23': '愛知県', '24': '三重県', '25': '滋賀県', '26': '京都府', '27': '大阪府', '28': '兵庫県', '29': '奈良県', '30': '和歌山県', '31': '鳥取県', '32': '島根県', '33': '岡山県', '34': '広島県', '35': '山口県', '36': '徳島県', '37': '香川県', '38': '愛媛県', '39': '高知県', '40': '福岡県', '41': '佐賀県', '42': '長崎県', '43': '熊本県', '44': '大分県', '45': '宮崎県', '46': '鹿児島県', '47': '沖縄県' };
function geoOf(req) {
  const ip = (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  const g = ip ? geoip.lookup(ip) : null;
  const dbg = { ip, region: g?.region || '', city: g?.city || '', v6: ip.includes(':') };
  if (!g) return { location: 'ローカル/不明', country: '', ...dbg };
  if (g.country === 'JP') {
    const pref = JP_PREF[g.region] || g.region || '';
    const loc = [pref, g.city || ''].filter(Boolean).join(' ') || '日本';
    return { location: loc, country: 'JP', ...dbg };
  }
  return { location: [g.city, g.region, g.country].filter(Boolean).join(', ') || g.country || '不明', country: g.country || '', ...dbg };
}

const app = express();
app.set('trust proxy', true);
app.use(cors());
// Stripe Webhook（署名検証のため express.json より前・rawボディ）
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripeEnabled()) return res.status(400).send('stripe disabled');
  let event;
  try { event = STRIPE_WEBHOOK_SECRET ? stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), STRIPE_WEBHOOK_SECRET) : JSON.parse(req.body.toString('utf8')); }
  catch (e) { return res.status(400).send('signature error: ' + e.message); }
  handleStripeEvent(event).catch((err) => console.error('[stripe] webhook handler error', err));
  res.json({ received: true });
});
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'web')));

// ---------- リアルタイム状態（メモリ） ----------
const sessions = new Map();
const queue = [];
const interpreters = new Map();
const guides = new Map();
const authTokens = new Map(); // token -> {id,username,role,displayName,languages,mode,connectMode}
let seq = 0;

const issueToken = (room, identity, name, role) => {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity, name, ttl: '30m', metadata: JSON.stringify({ role }) });
  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
  return at.toJwt();
};
const waitingSids = () => queue.filter((sid) => sessions.get(sid)?.status === 'waiting');
const availInterpreter = (lang) => [...interpreters.values()].find((i) => i.status === 'available' && i.languages.includes(lang));
const availGuide = () => [...guides.values()].find((g) => g.status === 'available');
const nameOf = (m, id) => (id ? m.get(id)?.name || '' : '');

function assignInterpreter(s, intp) { s.room = s.room || `room-${s.id}`; s.interpreterId = intp.id; intp.status = 'busy'; intp.room = s.room; intp.sessionId = s.id; }
function assignGuide(s, gd) { s.room = s.room || `room-${s.id}`; s.guideId = gd.id; s.needGuide = false; gd.status = 'busy'; gd.room = s.room; gd.sessionId = s.id; }
function tryAssign() {
  if (!AUTO_ASSIGN) return; // 手動割当モードでは自動割当しない
  let changed = true;
  while (changed) {
    changed = false;
    for (const sid of [...queue]) {
      const s = sessions.get(sid);
      if (!s || s.status !== 'waiting') continue;
      const intp = availInterpreter(s.language);
      if (!intp) continue;
      if (s.mode === 'B' && s.connectMode === 'both') { const gd = availGuide(); if (!gd) continue; assignInterpreter(s, intp); assignGuide(s, gd); }
      else { assignInterpreter(s, intp); if (s.mode === 'B') s.needGuide = true; }
      const i = queue.indexOf(sid); if (i !== -1) queue.splice(i, 1);
      s.status = 'assigned'; s.assignedAt = Date.now();
      db.prepare('UPDATE calls SET assigned_at=?, wait_sec=?, interpreter_name=?, guide_name=?, status=? WHERE id=?')
        .run(s.assignedAt, Math.round((s.assignedAt - s.enqueuedAt) / 1000), nameOf(interpreters, s.interpreterId), nameOf(guides, s.guideId), 'active', s.callId);
      logEvent('assign', 'system', { session: s.id, language: s.language, mode: s.mode, interpreter: nameOf(interpreters, s.interpreterId), guide: nameOf(guides, s.guideId) });
      chargeBase(s);
      changed = true;
    }
    for (const s of sessions.values()) {
      if (s.status === 'assigned' && s.mode === 'B' && s.needGuide && !s.guideId) {
        const gd = availGuide(); if (gd) { assignGuide(s, gd); db.prepare('UPDATE calls SET guide_name=? WHERE id=?').run(nameOf(guides, s.guideId), s.callId); changed = true; }
      }
    }
  }
}
function endSession(s) {
  if (!s || s.status === 'ended') return;
  const now = Date.now(); const wasActive = s.status === 'assigned';
  if (s.interpreterId) { const i = interpreters.get(s.interpreterId); if (i) { i.status = 'available'; i.room = null; i.sessionId = null; } }
  if (s.guideId) { const g = guides.get(s.guideId); if (g) { g.status = 'available'; g.room = null; g.sessionId = null; } }
  s.status = 'ended';
  db.prepare('UPDATE calls SET ended_at=?, talk_sec=?, status=? WHERE id=?').run(now, s.assignedAt ? Math.round((now - s.assignedAt) / 1000) : 0, wasActive ? 'ended' : 'abandoned', s.callId);
  logEvent('end', 'system', { session: s.id, status: wasActive ? 'ended' : 'abandoned' });
}

// ================= 認証 =================
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username=? AND enabled=1').get(username || '');
  if (!u || !verifyPw(password || '', u.pass)) return res.status(401).json({ error: 'ユーザー名またはパスワードが違います' });
  const token = crypto.randomUUID();
  const info = { id: u.id, username: u.username, role: u.role, displayName: u.display_name || u.username, languages: u.languages ? JSON.parse(u.languages) : [], mode: u.mode || 'A', connectMode: u.connect_mode || 'both' };
  authTokens.set(token, info);
  logEvent('login', u.username, { role: u.role });
  res.json({ token, ...info });
});
const requireAuth = (...roles) => (req, res, next) => {
  const t = req.get('x-auth-token');
  const u = t && authTokens.get(t);
  if (!u) return res.status(401).json({ error: '未認証です' });
  if (roles.length && !roles.includes(u.role)) return res.status(403).json({ error: '権限がありません' });
  req.user = u; req.authToken = t; next();
};
app.get('/api/auth/me', requireAuth(), (req, res) => res.json(req.user));
app.post('/api/auth/logout', requireAuth(), (req, res) => { authTokens.delete(req.authToken); res.json({ ok: true }); });

// ---------- 公開: 言語マスタ ----------
app.get('/api/languages', (_req, res) => res.json(enabledLangs()));

// ---------- 利用者（role=user）----------
app.post('/api/user/join', requireAuth('user'), (req, res) => {
  const u = req.user;
  const { language, name, gpsLocation, gpsLat, gpsLon, gpsAcc } = req.body || {};
  if (!language) return res.status(400).json({ error: 'language は必須です' });
  if (!enabledLangs().some((l) => l.code === language)) return res.status(400).json({ error: '未対応の言語です' });
  const bacct = db.prepare('SELECT billing_required, stripe_pm_id FROM users WHERE id=?').get(u.id) || {};
  if (bacct.billing_required && stripeEnabled() && !bacct.stripe_pm_id) return res.status(402).json({ error: 'カードが未登録です。先に「カード登録」を行ってください。', needCard: true });
  const mode = u.mode || 'A';
  const cm = mode === 'B' ? (u.connectMode === 'staged' ? 'staged' : 'both') : null;
  const custName = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 40) : u.displayName;
  const id = 'S' + (++seq); const now = Date.now();
  const geo = geoOf(req);
  const gps = (typeof gpsLocation === 'string' && gpsLocation.trim()) ? gpsLocation.trim().slice(0, 120) : '';
  const location = gps || geo.location; const locSource = gps ? 'gps' : 'ip';
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  let lat = num(gpsLat), lon = num(gpsLon), acc = num(gpsAcc);
  if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) { lat = null; lon = null; acc = null; }
  const info = db.prepare('INSERT INTO calls(session_id,name,language,mode,connect_mode,enqueued_at,status,location,country,lat,lon,accuracy) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, custName, language, mode, cm, now, 'waiting', location, geo.country, lat, lon, acc);
  const acct = db.prepare('SELECT billing_required,billing_mode FROM users WHERE id=?').get(u.id) || {};
  const billingRequired = !!acct.billing_required; const billingMode = acct.billing_mode || 'member'; const bcfg = getBilling();
  sessions.set(id, { id, name: custName, language, mode, connectMode: cm, status: 'waiting', room: null, interpreterId: null, guideId: null, needGuide: false, lastSeen: now, enqueuedAt: now, assignedAt: null, callId: info.lastInsertRowid, location, userId: u.id, username: u.username, billingRequired, billingMode, billing: bcfg, extCount: 0, baseCharged: false, allowedSec: billingRequired ? bcfg.base_minutes * 60 : null });
  queue.push(id);
  logEvent('user_join', custName, { session: id, language, mode, location, source: locSource, ip: geo.ip });
  tryAssign();
  res.json({ sessionId: id, mode });
});
app.get('/api/user/status', async (req, res) => {
  const s = sessions.get(req.query.sessionId);
  if (!s) return res.status(404).json({ error: 'session not found' });
  s.lastSeen = Date.now();
  if (s.status === 'waiting') {
    const pos = waitingSids().filter((x) => sessions.get(x).language === s.language).indexOf(s.id) + 1;
    return res.json({ status: 'waiting', position: pos, language: langLabel(s.language) });
  }
  if (s.status === 'assigned') {
    if (s.billingRequired && stripeEnabled()) {
      if (s.baseChargeState === 'failed') return res.json({ status: 'payment_failed', error: s.billingError || 'カード決済に失敗しました' });
      if (s.baseChargeState !== 'paid') return res.json({ status: 'preparing' });
    }
    const token = await issueToken(s.room, 'user-' + s.id, s.name, 'terminal');
    let billing = null;
    if (s.billingRequired) {
      const b = s.billing || getBilling();
      const talk = s.assignedAt ? Math.round((Date.now() - s.assignedAt) / 1000) : 0;
      const allowed = s.allowedSec || b.base_minutes * 60;
      billing = { required: true, talkSec: talk, allowedSec: allowed, remainingSec: Math.max(0, allowed - talk), extUnitMin: b.ext_unit_minutes, extPrice: b.ext_price, currency: b.currency, chargeTotal: s.chargeTotal || b.base_price, extCount: s.extCount || 0 };
    }
    return res.json({ status: 'assigned', room: s.room, url: LIVEKIT_URL, token, mode: s.mode, guidePending: s.mode === 'B' && !s.guideId, billing });
  }
  if (s.billingError) return res.json({ status: 'payment_failed', error: s.billingError });
  return res.json({ status: s.status });
});

// 延長（明示ボタン・追加課金）。Stripe有効時は先に保存カードへ off-session 課金し、成功時のみ延長。失敗は402。
app.post('/api/user/extend', requireAuth('user'), async (req, res) => {
  const s = sessions.get(req.body?.sessionId);
  if (!s || s.status !== 'assigned') return res.status(404).json({ error: '通話中ではありません' });
  if (s.userId !== req.user.id) return res.status(403).json({ error: '権限がありません' });
  if (!s.billingRequired) return res.status(400).json({ error: 'このアカウントは課金対象外です' });
  const b = s.billing || getBilling();
  let provider = 'none', providerRef = null, payStatus = 'recorded';
  if (stripeEnabled()) {
    try {
      const urow = db.prepare('SELECT * FROM users WHERE id=?').get(s.userId);
      const pi = await chargeOffSession(urow, b.ext_price, b.currency, { app: 'interpreter-poc', kind: 'extension', call_id: String(s.callId), session: s.id });
      provider = 'stripe'; providerRef = pi.id; payStatus = 'paid';
    } catch (e) {
      logEvent('charge_ext_failed', s.username || '', { session: s.id, error: String(e.message || e) });
      return res.status(402).json({ error: '延長の決済に失敗しました（カードをご確認ください）' });
    }
  }
  s.extCount = (s.extCount || 0) + 1;
  s.allowedSec = b.base_minutes * 60 + s.extCount * b.ext_unit_minutes * 60;
  s.chargeTotal = (s.chargeTotal || b.base_price) + b.ext_price;
  db.prepare('UPDATE calls SET ext_count=?,charge_ext=?,charge_total=?,allowed_sec=? WHERE id=?')
    .run(s.extCount, s.extCount * b.ext_price, s.chargeTotal, s.allowedSec, s.callId);
  db.prepare('INSERT INTO payments(call_id,session_id,user_id,username,kind,amount,currency,status,provider,provider_ref,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(s.callId, s.id, s.userId || null, s.username || '', 'extension', b.ext_price, b.currency, payStatus, provider, providerRef, Date.now());
  logEvent('charge_ext', s.username || '', { session: s.id, extCount: s.extCount, amount: b.ext_price });
  const talk = s.assignedAt ? Math.round((Date.now() - s.assignedAt) / 1000) : 0;
  res.json({ ok: true, extCount: s.extCount, allowedSec: s.allowedSec, remainingSec: Math.max(0, s.allowedSec - talk), chargeTotal: s.chargeTotal, extUnitMin: b.ext_unit_minutes, extPrice: b.ext_price });
});

// 利用者の退出（即時セッション終了＝スタッフを速やかに解放）
app.post('/api/user/leave', requireAuth('user'), (req, res) => {
  const s = sessions.get(req.body?.sessionId);
  if (s && s.userId === req.user.id && s.status !== 'ended') {
    const i = queue.indexOf(s.id); if (i !== -1) queue.splice(i, 1);
    logEvent('user_leave', s.username || '', { session: s.id });
    endSession(s); tryAssign();
  }
  res.json({ ok: true });
});

// カード登録状態
app.get('/api/user/card', requireAuth('user'), (req, res) => {
  const u = db.prepare('SELECT stripe_customer_id,stripe_pm_id,card_brand,card_last4 FROM users WHERE id=?').get(req.user.id) || {};
  res.json({ enabled: stripeEnabled(), registered: !!u.stripe_pm_id, brand: u.card_brand || null, last4: u.card_last4 || null });
});
// カード登録用 Checkout(setup) セッション作成
app.post('/api/user/card/session', requireAuth('user'), async (req, res) => {
  if (!stripeEnabled()) return res.status(400).json({ error: '決済が未設定です（管理者にお問い合わせください）' });
  try {
    const urow = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    const cust = await ensureCustomer(urow);
    const session = await stripe.checkout.sessions.create({ mode: 'setup', customer: cust, payment_method_types: ['card'], success_url: PUBLIC_BASE_URL + '/user.html?card=ok', cancel_url: PUBLIC_BASE_URL + '/user.html?card=cancel' });
    res.json({ url: session.url });
  } catch (e) { res.status(500).json({ error: 'カード登録セッションの作成に失敗: ' + e.message }); }
});

// ---------- スタッフ（role=interpreter/guide、アカウント連動）----------
function presenceOf(u) {
  const id = 'U' + u.id; const isGuide = u.role === 'guide';
  const map = isGuide ? guides : interpreters;
  let st = map.get(id);
  if (!st) {
    st = isGuide ? { id, name: u.displayName, status: 'available', room: null, sessionId: null, lastSeen: Date.now() }
                 : { id, name: u.displayName, languages: u.languages || [], status: 'available', room: null, sessionId: null, lastSeen: Date.now() };
    map.set(id, st); tryAssign();
  }
  st.lastSeen = Date.now();
  return { st, isGuide };
}
app.get('/api/staff/poll', requireAuth('interpreter', 'guide'), async (req, res) => {
  const { st, isGuide } = presenceOf(req.user);
  if (st.status === 'busy' && st.room) {
    const s = [...sessions.values()].find((x) => x.room === st.room);
    const role = isGuide ? 'guide' : 'interpreter';
    const token = await issueToken(st.room, role + '-' + st.id, st.name, role);
    return res.json({ assigned: true, room: st.room, url: LIVEKIT_URL, token, role, customer: s?.name || '', language: s ? langLabel(s.language) : '', mode: s?.mode || '' });
  }
  if (isGuide) {
    const glist = [...sessions.values()].filter((x) => x.status === 'assigned' && x.mode === 'B' && !x.guideId)
      .map((x) => ({ sessionId: x.id, name: x.name, language: langLabel(x.language), mode: x.mode, location: x.location || '', interpreter: nameOf(interpreters, x.interpreterId), waitSec: x.assignedAt ? Math.round((Date.now() - x.assignedAt) / 1000) : 0 }));
    return res.json({ assigned: false, status: st.status, role: 'guide', displayName: st.name, guideNeeded: glist.length, guideList: glist });
  }
  const byLang = {}; for (const c of st.languages) byLang[c] = waitingSids().filter((x) => sessions.get(x).language === c).length;
  const wlist = waitingSids().map((sid) => sessions.get(sid)).filter((x) => x && st.languages.includes(x.language))
    .map((x) => ({ sessionId: x.id, name: x.name, language: langLabel(x.language), mode: x.mode, location: x.location || '', waitSec: Math.round((Date.now() - x.enqueuedAt) / 1000) }));
  res.json({ assigned: false, status: st.status, role: 'interpreter', displayName: st.name, languages: st.languages, waitingByLang: byLang, waitingList: wlist });
});
// スタッフが待機中の通話を選んで応答（手動割当）
app.post('/api/staff/accept', requireAuth('interpreter', 'guide'), (req, res) => {
  const { st, isGuide } = presenceOf(req.user);
  const s = sessions.get(req.body?.sessionId);
  if (!s) return res.status(404).json({ error: 'この通話は見つかりません（終了した可能性）' });
  if (st.status === 'busy') return res.status(409).json({ error: 'すでに対応中です' });
  if (isGuide) {
    if (!(s.status === 'assigned' && s.mode === 'B' && !s.guideId)) return res.status(409).json({ error: '受け付けできません（対応済み/対象外）' });
    assignGuide(s, st);
    db.prepare('UPDATE calls SET guide_name=? WHERE id=?').run(nameOf(guides, s.guideId), s.callId);
    logEvent('guide_accept', st.name, { session: s.id });
    return res.json({ ok: true });
  }
  if (s.status !== 'waiting') return res.status(409).json({ error: 'この利用者は既に対応中です' });
  if (!st.languages.includes(s.language)) return res.status(400).json({ error: '対応言語が一致しません' });
  assignInterpreter(s, st);
  const i = queue.indexOf(s.id); if (i !== -1) queue.splice(i, 1);
  s.status = 'assigned'; s.assignedAt = Date.now();
  if (s.mode === 'B') s.needGuide = true;
  db.prepare('UPDATE calls SET assigned_at=?, wait_sec=?, interpreter_name=?, guide_name=?, status=? WHERE id=?')
    .run(s.assignedAt, Math.round((s.assignedAt - s.enqueuedAt) / 1000), nameOf(interpreters, s.interpreterId), nameOf(guides, s.guideId), 'active', s.callId);
  logEvent('accept', st.name, { session: s.id, language: s.language, mode: s.mode });
  chargeBase(s);
  res.json({ ok: true });
});

app.post('/api/staff/status', requireAuth('interpreter', 'guide'), (req, res) => {
  const { st } = presenceOf(req.user);
  if (st.status !== 'busy') st.status = req.body?.status === 'available' ? 'available' : 'offline';
  tryAssign(); res.json({ ok: true, status: st.status });
});
app.post('/api/staff/hangup', requireAuth('interpreter', 'guide'), async (req, res) => {
  const id = 'U' + req.user.id; const st = interpreters.get(id) || guides.get(id);
  if (!st) return res.json({ ok: true });
  const s = st.sessionId ? sessions.get(st.sessionId) : [...sessions.values()].find((x) => x.room === st.room);
  if (s && s.egressId) { try { await egressClient.stopEgress(s.egressId); } catch (_) {} s.egressId = null; }
  logEvent('hangup', st.name, { session: s?.id });
  endSession(s); tryAssign(); res.json({ ok: true });
});
// 録画（通訳者）
app.post('/api/staff/record/start', requireAuth('interpreter'), async (req, res) => {
  const st = interpreters.get('U' + req.user.id);
  if (!st || !st.room) return res.status(400).json({ error: '対応中の通話がありません' });
  const s = sessions.get(st.sessionId);
  if (s?.egressId) return res.status(409).json({ error: 'すでに録画中です' });
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-'); const filepath = `/out/${st.room}-${ts}.mp4`;
    const infoE = await egressClient.startRoomCompositeEgress(st.room, { file: new EncodedFileOutput({ fileType: EncodedFileType.MP4, filepath }) }, { layout: 'grid' });
    s.egressId = infoE.egressId; s.recFilepath = filepath;
    db.prepare('UPDATE calls SET recorded=1 WHERE id=?').run(s.callId);
    logEvent('record_start', st.name, { session: s.id, filepath }); res.json({ ok: true, filepath });
  } catch (e) { res.status(500).json({ error: '録画開始に失敗（Egress起動を確認）: ' + e.message }); }
});
app.post('/api/staff/record/stop', requireAuth('interpreter'), async (req, res) => {
  const st = interpreters.get('U' + req.user.id); const s = st && sessions.get(st.sessionId);
  if (!s?.egressId) return res.status(400).json({ error: '録画していません' });
  try { await egressClient.stopEgress(s.egressId); const saved = s.recFilepath; s.egressId = null; s.recFilepath = null; logEvent('record_stop', st.name, { session: s.id, filepath: saved }); res.json({ ok: true, filepath: saved }); }
  catch (e) { res.status(500).json({ error: '録画停止に失敗: ' + e.message }); }
});

// ================= 管理API（role=admin）=================
app.get('/api/admin/overview', requireAuth('admin'), (_req, res) => {
  const waitingByLang = {};
  for (const l of enabledLangs()) waitingByLang[l.code] = { label: l.label, count: waitingSids().filter((x) => sessions.get(x).language === l.code).length };
  const active = [...sessions.values()].filter((s) => s.status === 'assigned').map((s) => ({ session: s.id, name: s.name, language: langLabel(s.language), mode: s.mode, interpreter: nameOf(interpreters, s.interpreterId), guide: nameOf(guides, s.guideId), location: s.location || '', recording: !!s.egressId, talkSec: s.assignedAt ? Math.round((Date.now() - s.assignedAt) / 1000) : 0 }));
  res.json({ interpreters: [...interpreters.values()].map((i) => ({ name: i.name, languages: i.languages, status: i.status })), guides: [...guides.values()].map((g) => ({ name: g.name, status: g.status })), waitingByLang, activeCalls: active });
});
function callsQuery(q) {
  const where = []; const args = [];
  if (q.lang) { where.push('language=?'); args.push(q.lang); }
  if (q.status) { where.push('status=?'); args.push(q.status); }
  args.push(Math.min(Number(q.limit) || 200, 2000));
  return db.prepare('SELECT * FROM calls' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY id DESC LIMIT ?').all(...args);
}
app.get('/api/admin/calls', requireAuth('admin'), (req, res) => res.json(callsQuery(req.query)));
app.get('/api/admin/calls.csv', requireAuth('admin'), (req, res) => {
  const rows = callsQuery(req.query);
  const cols = ['id', 'session_id', 'name', 'language', 'mode', 'connect_mode', 'location', 'country', 'lat', 'lon', 'accuracy', 'interpreter_name', 'guide_name', 'enqueued_at', 'assigned_at', 'ended_at', 'wait_sec', 'talk_sec', 'recorded', 'status'];
  const iso = (v) => (v ? new Date(v).toISOString() : '');
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map((c) => esc(['enqueued_at', 'assigned_at', 'ended_at'].includes(c) ? iso(r[c]) : r[c])).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="calls.csv"');
  res.send('﻿' + lines.join('\n'));
});
app.get('/api/admin/report', requireAuth('admin'), (req, res) => {
  const from = Number(req.query.from) || 0, to = Number(req.query.to) || Date.now();
  const rows = db.prepare('SELECT * FROM calls WHERE enqueued_at BETWEEN ? AND ?').all(from, to);
  const answered = rows.filter((r) => r.status === 'ended' || r.status === 'active');
  const avg = (arr, k) => (arr.length ? Math.round(arr.reduce((a, r) => a + (r[k] || 0), 0) / arr.length) : 0);
  const byLang = {};
  for (const l of enabledLangs()) { const lr = rows.filter((r) => r.language === l.code); byLang[l.code] = { label: l.label, total: lr.length, answered: lr.filter((r) => r.status !== 'abandoned' && r.status !== 'waiting').length, abandoned: lr.filter((r) => r.status === 'abandoned').length, avgWait: avg(lr.filter((r) => r.assigned_at), 'wait_sec'), avgTalk: avg(lr.filter((r) => r.ended_at), 'talk_sec') }; }
  res.json({ total: rows.length, answered: answered.length, abandoned: rows.filter((r) => r.status === 'abandoned').length, answerRate: rows.length ? Math.round((answered.length / rows.length) * 100) : 0, avgWaitSec: avg(rows.filter((r) => r.assigned_at), 'wait_sec'), avgTalkSec: avg(rows.filter((r) => r.ended_at), 'talk_sec'), recorded: rows.filter((r) => r.recorded).length, byLang });
});
app.get('/api/admin/events', requireAuth('admin'), (req, res) => res.json(db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(Math.min(Number(req.query.limit) || 200, 2000))));

// マスタ: 言語
app.get('/api/admin/languages', requireAuth('admin'), (_q, res) => res.json(db.prepare('SELECT code,label,enabled,sort_order FROM languages ORDER BY sort_order,code').all()));
app.post('/api/admin/languages', requireAuth('admin'), (req, res) => {
  const { code, label, enabled = 1, sort_order = 0 } = req.body || {};
  if (!code || !label) return res.status(400).json({ error: 'code, label は必須' });
  db.prepare('INSERT INTO languages(code,label,enabled,sort_order) VALUES(?,?,?,?) ON CONFLICT(code) DO UPDATE SET label=excluded.label,enabled=excluded.enabled,sort_order=excluded.sort_order').run(code, label, enabled ? 1 : 0, Number(sort_order) || 0);
  logEvent('lang_upsert', req.user.username, { code }); res.json({ ok: true });
});
app.post('/api/admin/languages/delete', requireAuth('admin'), (req, res) => { db.prepare('DELETE FROM languages WHERE code=?').run(req.body?.code); res.json({ ok: true }); });

// マスタ: ユーザー
app.get('/api/admin/users', requireAuth('admin'), (_q, res) => res.json(db.prepare('SELECT id,username,role,display_name,languages,mode,connect_mode,enabled,billing_required,billing_mode FROM users ORDER BY role,username').all().map((u) => ({ ...u, languages: u.languages ? JSON.parse(u.languages) : [] }))));
app.post('/api/admin/users', requireAuth('admin'), (req, res) => {
  const { id, username, password, role, display_name, languages, mode, connect_mode, enabled = 1, billing_required = 0, billing_mode = 'member' } = req.body || {};
  if (!username || !role) return res.status(400).json({ error: 'username, role は必須' });
  if (!['admin', 'user', 'interpreter', 'guide'].includes(role)) return res.status(400).json({ error: 'role が不正' });
  const langs = Array.isArray(languages) ? JSON.stringify(languages) : null;
  const br = billing_required ? 1 : 0; const bm = billing_mode === 'guest' ? 'guest' : 'member';
  try {
    if (id) {
      const ex = db.prepare('SELECT * FROM users WHERE id=?').get(id);
      if (!ex) return res.status(404).json({ error: 'not found' });
      const pass = password ? hashPw(password) : ex.pass;
      db.prepare('UPDATE users SET username=?,pass=?,role=?,display_name=?,languages=?,mode=?,connect_mode=?,enabled=?,billing_required=?,billing_mode=? WHERE id=?').run(username, pass, role, display_name || username, langs, mode || null, connect_mode || null, enabled ? 1 : 0, br, bm, id);
    } else {
      if (!password) return res.status(400).json({ error: '新規はpassword必須' });
      db.prepare('INSERT INTO users(username,pass,role,display_name,languages,mode,connect_mode,enabled,billing_required,billing_mode) VALUES(?,?,?,?,?,?,?,1,?,?)').run(username, hashPw(password), role, display_name || username, langs, mode || null, connect_mode || null, br, bm);
    }
  } catch (e) { return res.status(409).json({ error: 'そのユーザー名は既に使われています' }); }
  logEvent('user_upsert', req.user.username, { username, role }); res.json({ ok: true });
});
app.post('/api/admin/users/delete', requireAuth('admin'), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.body?.id);
  if (!u) return res.json({ ok: true });
  if (u.role === 'admin' && db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND enabled=1").get().c <= 1) return res.status(400).json({ error: '最後の管理者は削除できません' });
  db.prepare('DELETE FROM users WHERE id=?').run(u.id); logEvent('user_delete', req.user.username, { username: u.username }); res.json({ ok: true });
});

// ---- 課金設定・売上（管理者） ----
app.get('/api/admin/billing', requireAuth('admin'), (_q, res) => res.json(getBilling()));
app.post('/api/admin/billing', requireAuth('admin'), (req, res) => {
  const f = req.body || {};
  for (const k of ['base_price', 'base_minutes', 'ext_unit_minutes', 'ext_price', 'grace_sec']) {
    if (f[k] != null && f[k] !== '') { const n = Number(f[k]); if (!isFinite(n) || n < 0) return res.status(400).json({ error: k + ' が不正です' }); setSetting('billing_' + k, Math.round(n)); }
  }
  if (f.currency) setSetting('billing_currency', String(f.currency).slice(0, 8));
  logEvent('billing_update', req.user.username, f); res.json({ ok: true, ...getBilling() });
});
app.get('/api/admin/payments', requireAuth('admin'), (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 300, 2000);
  const rows = db.prepare('SELECT * FROM payments ORDER BY id DESC LIMIT ?').all(limit);
  const sum = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(amount),0) total FROM payments WHERE status IN ('recorded','paid')").get();
  const byKind = db.prepare("SELECT kind, COUNT(*) c, COALESCE(SUM(amount),0) total FROM payments WHERE status IN ('recorded','paid') GROUP BY kind").all();
  res.json({ rows, summary: { count: sum.c, total: sum.total, byKind } });
});

app.get('/api/health', (_q, res) => res.json({ ok: true }));

// ---------- 切断検出（ハートビート） ----------
const STAFF_TIMEOUT_MS = 12000, USER_TIMEOUT_MS = 15000;
setInterval(() => {
  const now = Date.now();
  for (const st of [...interpreters.values(), ...guides.values()]) {
    if (now - (st.lastSeen || 0) > STAFF_TIMEOUT_MS) { if (st.sessionId) endSession(sessions.get(st.sessionId)); interpreters.delete(st.id); guides.delete(st.id); logEvent('staff_timeout', st.name, { id: st.id }); }
  }
  for (const s of sessions.values()) {
    if ((s.status === 'waiting' || s.status === 'assigned') && now - (s.lastSeen || 0) > USER_TIMEOUT_MS) { const i = queue.indexOf(s.id); if (i !== -1) queue.splice(i, 1); endSession(s); }
  }
  for (const s of sessions.values()) {
    if (s.status === 'assigned' && s.billingRequired && s.assignedAt) {
      const talk = (now - s.assignedAt) / 1000;
      if (talk > (s.allowedSec || 0) + (s.billing?.grace_sec || 0)) { logEvent('billing_timeout', s.username || '', { session: s.id, allowedSec: s.allowedSec }); endSession(s); }
    }
  }
  tryAssign();
}, 4000);

app.listen(Number(PORT), () => {
  console.log(`[interpreter-poc] http://localhost:${PORT}`);
  console.log(`[interpreter-poc] LiveKit=${LIVEKIT_URL} apiKey=${LIVEKIT_API_KEY}`);
  console.log(`[interpreter-poc] ログイン: /  （デモ: admin/reception1/int_en/guide1）`);
});
