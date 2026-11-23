/**
 * mock-weaver —— 泛微 OA 模拟器
 *
 * 为 FastGPT 泛微同步 + 泛微 SSO 提供一个可自造数据的假 OA：
 * 1. HR REST 同步接口（供 sso 服务 weaver provider 拉取人员/组织）
 *    - POST /api/ec/dev/auth/applytoken
 *    - POST /api/hrm/resful/getHrmsubcompanyWithPage
 *    - POST /api/hrm/resful/getHrmdepartmentWithPage
 *    - POST /api/hrm/resful/getHrmUserInfoWithPage
 * 2. OAuth2 登录（供 sso 服务 oauth2 provider 完成泛微 SSO）
 *    - GET  /sso/oauth2.0/authorize   （登录页：从已导入人员中点选）
 *    - POST /sso/oauth2.0/accessToken
 *    - GET  /sso/oauth2.0/profile
 * 3. 管理 API + 管理页（/ ：CSV 导入 + 手动编辑分部/部门/人员）
 *
 * 零依赖，Node >= 16。数据持久化在 data/orgs.json。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 9100);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'orgs.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// 泛微接口路径与图表/Provider 保持一致；可按需覆盖
const AUTHORIZE_PATH = process.env.MOCK_AUTHORIZE_PATH || '/sso/oauth2.0/authorize';
const TOKEN_PATH = process.env.MOCK_TOKEN_PATH || '/sso/oauth2.0/accessToken';
const PROFILE_PATH = process.env.MOCK_PROFILE_PATH || '/sso/oauth2.0/profile';

// 校验开关：默认宽松（有 appid/secret 头即可换 token；业务接口不强制 token）
const EXPECT_APP_ID = process.env.MOCK_EXPECT_APP_ID || '';
const EXPECT_SECRET = process.env.MOCK_EXPECT_SECRET || '';
const STRICT_TOKEN = process.env.MOCK_STRICT_TOKEN === '1';

// ---------------------------------------------------------------------------
// 数据存储
// ---------------------------------------------------------------------------
const SAMPLE_DATA = {
  subcompanies: [
    { id: '1', subcompanyname: '泛微网络', subcompanydesc: '', supsubcomid: '0', canceled: '0' },
    { id: '2', subcompanyname: '泛微研究院', subcompanydesc: '', supsubcomid: '1', canceled: '0' }
  ],
  departments: [
    { id: '11', departmentname: '研发部', departmentmark: '', supdepid: '0', subcompanyid1: '1', canceled: '0' },
    { id: '12', departmentname: '产品部', departmentmark: '', supdepid: '0', subcompanyid1: '1', canceled: '0' },
    { id: '13', departmentname: '人事部', departmentmark: '', supdepid: '0', subcompanyid1: '1', canceled: '0' },
    { id: '111', departmentname: '平台组', departmentmark: '', supdepid: '11', subcompanyid1: '1', canceled: '0' }
  ],
  users: [
    { id: '1', workcode: '77000136', loginid: '77000136', lastname: '张三', status: '0', accounttype: '0', departmentid: '11', subcompanyid1: '1', mobile: '13800000136', email: 'zhangsan@example.com', telephone: '' },
    { id: '2', workcode: '81000139', loginid: '81000139', lastname: '李四', status: '0', accounttype: '0', departmentid: '12', subcompanyid1: '1', mobile: '13800000139', email: 'lisi@example.com', telephone: '' },
    { id: '3', workcode: '77000140', loginid: '77000140', lastname: '王五', status: '1', accounttype: '0', departmentid: '111,12', subcompanyid1: '1', mobile: '13800000140', email: '', telephone: '' },
    { id: '4', workcode: '77000141', loginid: '77000141', lastname: '赵六', status: '0', accounttype: '0', departmentid: '13', subcompanyid1: '1', mobile: '', email: 'zhaoliu@example.com', telephone: '021-8888' },
    { id: '5', workcode: '77000142', loginid: '77000142', lastname: '钱七', status: '4', accounttype: '0', departmentid: '11', subcompanyid1: '1', mobile: '13800000142', email: '', telephone: '' },
    { id: '6', workcode: '77000143', loginid: 'wx_0136', lastname: '孙八(次账号)', status: '0', accounttype: '1', departmentid: '11', subcompanyid1: '1', mobile: '13800000136', email: '', telephone: '' }
  ]
};

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    return {
      subcompanies: Array.isArray(data.subcompanies) ? data.subcompanies : [],
      departments: Array.isArray(data.departments) ? data.departments : [],
      users: Array.isArray(data.users) ? data.users : []
    };
  } catch {
    const data = JSON.parse(JSON.stringify(SAMPLE_DATA));
    saveData(data);
    return data;
  }
}

function saveData(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

let store = loadData();

function nextId(list) {
  const max = list.reduce((acc, item) => Math.max(acc, Number(item.id) || 0), 0);
  return String(max + 1);
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------
function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readBodyParams(req) {
  const text = await readBody(req);
  if (!text) return {};
  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return { __raw: text };
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function serveStatic(res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

function paginate(list, params) {
  const pageSize = Math.max(1, Number.parseInt(String(params.pagesize ?? '100'), 10) || 100);
  const curpage = Math.max(1, Number.parseInt(String(params.curpage ?? '1'), 10) || 1);
  const start = (curpage - 1) * pageSize;
  return {
    totalSize: list.length,
    curpage,
    pageSize,
    dataList: list.slice(start, start + pageSize)
  };
}

// ---------------------------------------------------------------------------
// 1. HR REST 同步接口
// ---------------------------------------------------------------------------
const issuedHrTokens = new Map(); // token -> expiresAt

async function handleApplyToken(req, res) {
  const appId = String(req.headers.appid || '');
  const secret = String(req.headers.secret || '');
  if (!appId || !secret) {
    return sendJson(res, 200, { code: '-2', msg: 'missing appid/secret headers' });
  }
  if (EXPECT_APP_ID && appId !== EXPECT_APP_ID) {
    return sendJson(res, 200, { code: '-2', msg: 'appid mismatch' });
  }
  if (EXPECT_SECRET && secret.length < 8) {
    // 真实接口收的是 RSA 密文；mock 只做非空长度防御，无法验签
    return sendJson(res, 200, { code: '-2', msg: 'secret mismatch' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  issuedHrTokens.set(token, Date.now() + 30 * 60 * 1000);
  sendJson(res, 200, { token, expires_in: 1800, code: '1', msg: 'ok' });
}

function checkHrAuth(req) {
  if (!STRICT_TOKEN) return true;
  const token = String(req.headers.token || '');
  const exp = issuedHrTokens.get(token);
  return Boolean(exp && exp > Date.now());
}

function handleHrPage(res, list, params) {
  sendJson(res, 200, { code: '1', msg: 'success', data: paginate(list, params) });
}

// getHrmUserInfoWithPage 支持的过滤参数与真实接口一致：
// - departmentid: 逗号多值
// - subcompanyid1: 单值
function filterUsers(params) {
  let users = store.users;
  const subId = String(params.subcompanyid1 ?? '').trim();
  if (subId) {
    users = users.filter((u) => String(u.subcompanyid1 ?? '').trim() === subId);
  }
  const depRaw = String(params.departmentid ?? '').trim();
  if (depRaw) {
    const ids = new Set(depRaw.split(',').map((s) => s.trim()).filter(Boolean));
    users = users.filter((u) =>
      String(u.departmentid ?? '')
        .split(',')
        .map((s) => s.trim())
        .some((id) => ids.has(id))
    );
  }
  const workcode = String(params.workcode ?? '').trim();
  if (workcode) {
    users = users.filter((u) => String(u.workcode ?? '').trim() === workcode);
  }
  return users;
}

// ---------------------------------------------------------------------------
// 2. OAuth2 登录（CAS 风格三段）
// ---------------------------------------------------------------------------
const oauthCodes = new Map(); // code -> { userId, redirectUri, state, expiresAt }
const oauthTokens = new Map(); // access_token -> { userId, expiresAt }

function findUserById(id) {
  return store.users.find((u) => String(u.id) === String(id));
}

function ssoActiveUsers() {
  const statuses = new Set(
    (process.env.MOCK_SSO_ACTIVE_STATUSES || '0,1,2,3')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  return store.users.filter(
    (u) => statuses.has(String(u.status ?? '').trim()) && String(u.accounttype ?? '0').trim() !== '1'
  );
}

function renderLoginPage(res, query, errorMsg) {
  const users = ssoActiveUsers();
  const rows = users
    .map(
      (u) => `<tr>
        <td>${escapeHtml(u.workcode || '')}</td>
        <td>${escapeHtml(u.lastname || '')}</td>
        <td>${escapeHtml(u.mobile || u.email || '-')}</td>
        <td><button onclick="login('${u.id}')">以此身份登录</button></td>
      </tr>`
    )
    .join('\n');
  const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>泛微 OA 登录（Mock）</title>
<style>
 body{font-family:system-ui,sans-serif;margin:40px auto;max-width:760px;color:#222}
 table{border-collapse:collapse;width:100%}
 th,td{border:1px solid #ddd;padding:6px 10px;text-align:left;font-size:14px}
 th{background:#f5f5f5}
 button{cursor:pointer}
 .hint{color:#888;font-size:13px}
 .err{color:#c00}
 form.inline{display:flex;gap:8px;margin-top:12px}
</style></head><body>
<h2>泛微 OA 登录（Mock）</h2>
<p class="hint">模拟泛微 OA 的统一登录页：选择下方在职人员即可完成 SSO 授权。<br/>
redirect_uri=<code>${escapeHtml(query.redirect_uri || '')}</code> state=<code>${escapeHtml(query.state || '')}</code></p>
${errorMsg ? `<p class="err">${escapeHtml(errorMsg)}</p>` : ''}
<script>
 function login(id){
   const u = new URL(location.href);
   u.searchParams.set('__pick', id);
   location.href = u.toString();
 }
</script>
<table><thead><tr><th>工号</th><th>姓名</th><th>联系方式</th><th>操作</th></tr></thead>
<tbody>${rows || '<tr><td colspan="4">暂无在职人员，请先到 <a href="/">管理页</a> 导入</td></tr>'}</tbody></table>
<h3>任意工号登录（模拟名单外用户）</h3>
<form class="inline" onsubmit="pickCustom(event)">
  <input id="wc" placeholder="工号，如 99999999" required>
  <input id="nm" placeholder="姓名(可选)">
  <button type="submit">登录</button>
</form>
<script>
 function pickCustom(e){
   e.preventDefault();
   const u = new URL(location.href);
   u.searchParams.set('__workcode', document.getElementById('wc').value.trim());
   const nm = document.getElementById('nm').value.trim();
   if (nm) u.searchParams.set('__name', nm);
   location.href = u.toString();
 }
</script>
</body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function handleAuthorize(req, res, url) {
  const redirectUri = url.searchParams.get('redirect_uri') || '';
  if (!redirectUri) {
    return renderLoginPage(res, {}, '缺少 redirect_uri 参数');
  }

  // 1) 点选用户 → 发 code 并跳回 redirect_uri
  const pickId = url.searchParams.get('__pick');
  const customCode = url.searchParams.get('__workcode');
  let userId = null;
  if (pickId) {
    const user = findUserById(pickId);
    if (user && ssoActiveUsers().includes(user)) {
      userId = user.id;
    } else {
      return renderLoginPage(res, { redirect_uri: redirectUri, state: url.searchParams.get('state') || '' }, '该用户不存在或不在职');
    }
  } else if (customCode) {
    // 名单外工号：不落库，仅在本次授权会话内成立
    userId = `__adhoc:${customCode}:${url.searchParams.get('__name') || ''}`;
  } else {
    return renderLoginPage(res, { redirect_uri: redirectUri, state: url.searchParams.get('state') || '' });
  }

  const code = crypto.randomBytes(16).toString('hex');
  oauthCodes.set(code, {
    userId,
    redirectUri,
    state: url.searchParams.get('state') || '',
    expiresAt: Date.now() + 5 * 60 * 1000
  });
  const sep = redirectUri.includes('?') ? '&' : '?';
  redirect(res, `${redirectUri}${sep}code=${code}&state=${encodeURIComponent(url.searchParams.get('state') || '')}`);
}

function resolveAdhocUser(userId) {
  if (typeof userId === 'string' && userId.startsWith('__adhoc:')) {
    const [, workcode, name] = userId.split(':');
    return {
      id: workcode,
      workcode,
      loginid: workcode,
      lastname: name || workcode,
      status: '0',
      accounttype: '0',
      departmentid: '',
      subcompanyid1: '',
      mobile: '',
      email: '',
      telephone: ''
    };
  }
  return findUserById(userId);
}

async function handleAccessToken(req, res) {
  const body = await readBodyParams(req);
  const code = String(body.code ?? '');
  const grantType = String(body.grant_type ?? '');
  const entry = oauthCodes.get(code);

  const fail = (msg) => sendJson(res, 400, { error: 'invalid_grant', error_description: msg });

  if (grantType !== 'authorization_code') return fail('unsupported grant_type');
  if (!entry) return fail('unknown code');
  if (entry.expiresAt < Date.now()) {
    oauthCodes.delete(code);
    return fail('code expired');
  }
  // code 一次性
  oauthCodes.delete(code);

  const token = crypto.randomBytes(24).toString('hex');
  oauthTokens.set(token, { userId: entry.userId, expiresAt: Date.now() + 30 * 60 * 1000 });
  sendJson(res, 200, {
    access_token: token,
    expires_in: 1800,
    token_type: 'Bearer'
  });
}

async function handleProfile(req, res) {
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const entry = oauthTokens.get(token);
  if (!entry || entry.expiresAt < Date.now()) {
    return sendJson(res, 401, { error: 'invalid_token' });
  }
  const user = resolveAdhocUser(entry.userId);
  if (!user) return sendJson(res, 401, { error: 'invalid_token' });

  // 字段结构与图表注释里的映射一致：
  // OAUTH2_USERNAME_MAP=attributes.workcode / MEMBER_NAME_MAP=attributes.lastname / CONTACT_MAP=attributes.mobile
  sendJson(res, 200, {
    id: String(user.workcode ?? user.id),
    name: user.lastname || '',
    username: String(user.workcode ?? user.id),
    attributes: {
      workcode: String(user.workcode ?? ''),
      lastname: user.lastname || '',
      loginid: user.loginid || '',
      mobile: user.mobile || '',
      email: user.email || '',
      telephone: user.telephone || '',
      departmentid: user.departmentid || '',
      subcompanyid1: user.subcompanyid1 || ''
    }
  });
}

// ---------------------------------------------------------------------------
// 3. 管理 API（CSV 导入 + CRUD + 重置）
// ---------------------------------------------------------------------------
function normalizeSubcompany(row) {
  return {
    id: String(row.id ?? '').trim(),
    subcompanyname: String(row.subcompanyname ?? '').trim(),
    subcompanydesc: String(row.subcompanydesc ?? '').trim(),
    supsubcomid: String(row.supsubcomid ?? '0').trim() || '0',
    canceled: String(row.canceled ?? '0').trim() || '0'
  };
}

function normalizeDepartment(row) {
  return {
    id: String(row.id ?? '').trim(),
    departmentname: String(row.departmentname ?? '').trim(),
    departmentmark: String(row.departmentmark ?? '').trim(),
    supdepid: String(row.supdepid ?? '0').trim() || '0',
    subcompanyid1: String(row.subcompanyid1 ?? '0').trim() || '0',
    canceled: String(row.canceled ?? '0').trim() || '0'
  };
}

function normalizeUser(row) {
  const workcode = String(row.workcode ?? '').trim();
  return {
    id: String(row.id ?? '').trim(),
    workcode,
    loginid: String(row.loginid ?? '').trim() || workcode,
    lastname: String(row.lastname ?? '').trim(),
    status: String(row.status ?? '0').trim() || '0',
    accounttype: String(row.accounttype ?? '0').trim() || '0',
    departmentid: String(row.departmentid ?? '').trim(),
    subcompanyid1: String(row.subcompanyid1 ?? '').trim(),
    mobile: String(row.mobile ?? '').trim(),
    email: String(row.email ?? '').trim(),
    telephone: String(row.telephone ?? '').trim()
  };
}

function importRows(type, rows, mode) {
  const normalizers = { subcompany: normalizeSubcompany, department: normalizeDepartment, user: normalizeUser };
  const normalize = normalizers[type];
  if (!normalize || !Array.isArray(rows)) throw new Error('invalid type or rows');
  const collection = type === 'subcompany' ? store.subcompanies : type === 'department' ? store.departments : store.users;

  if (mode === 'replace') collection.length = 0;
  const skipped = [];
  for (const row of rows) {
    const item = normalize(row);
    if (type === 'user' && !item.workcode) {
      skipped.push(row);
      continue;
    }
    if (type !== 'user' && !item.id) item.id = nextId(collection);
    if (type !== 'user') {
      const existing = collection.find((x) => x.id === item.id);
      if (existing) Object.assign(existing, item);
      else collection.push(item);
    } else {
      // 用户按 workcode 去重（主键语义），id 自动补
      if (!item.id) item.id = nextId(store.users);
      const existing = collection.find((x) => x.workcode === item.workcode);
      if (existing) Object.assign(existing, item);
      else collection.push(item);
    }
  }
  saveData(store);
  return { imported: rows.length - skipped.length, skipped: skipped.length };
}

function handleAdminApi(req, res, url) {
  const { pathname } = url;
  const segments = pathname.split('/').filter(Boolean); // ['api', ...]

  if (req.method === 'GET' && pathname === '/api/data') {
    return sendJson(res, 200, store);
  }
  if (req.method === 'POST' && pathname === '/api/reset') {
    store = JSON.parse(JSON.stringify(SAMPLE_DATA));
    saveData(store);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST' && pathname === '/api/import') {
    return readBodyParams(req).then(({ type, mode, rows }) => {
      try {
        sendJson(res, 200, importRows(String(type), rows, mode === 'append' ? 'append' : 'replace'));
      } catch (err) {
        sendJson(res, 400, { error: String(err.message || err) });
      }
    });
  }

  // CRUD: /api/{collection}[/id]
  const collectionMap = { subcompanies: 'subcompany', departments: 'department', users: 'user' };
  const collectionName = segments[1];
  if (collectionMap[collectionName]) {
    const collection = store[collectionName];
    const normalizers = { subcompany: normalizeSubcompany, department: normalizeDepartment, user: normalizeUser };
    const id = segments[2];

    if (req.method === 'POST' && !id) {
      return readBodyParams(req).then((row) => {
        const item = normalizers[collectionName](row);
        if (collectionName === 'users' && !item.workcode) {
          return sendJson(res, 400, { error: 'workcode required' });
        }
        if (collectionName !== 'users') {
          if (!item.id) item.id = nextId(collection);
          if (collection.find((x) => x.id === item.id)) {
            return sendJson(res, 400, { error: `id ${item.id} already exists` });
          }
        } else {
          if (collection.find((x) => x.workcode === item.workcode)) {
            return sendJson(res, 400, { error: `workcode ${item.workcode} already exists` });
          }
          item.id = nextId(collection);
        }
        collection.push(item);
        saveData(store);
        sendJson(res, 200, item);
      });
    }

    if ((req.method === 'PUT' || req.method === 'POST') && id) {
      return readBodyParams(req).then((row) => {
        const item = collection.find((x) => String(x.id) === String(id));
        if (!item) return sendJson(res, 404, { error: 'not found' });
        Object.assign(item, normalizers[collectionName](row), { id: item.id });
        saveData(store);
        sendJson(res, 200, item);
      });
    }

    if (req.method === 'DELETE' && id) {
      const idx = collection.findIndex((x) => String(x.id) === String(id));
      if (idx < 0) return sendJson(res, 404, { error: 'not found' });
      collection.splice(idx, 1);
      saveData(store);
      return sendJson(res, 200, { ok: true });
    }
  }

  sendJson(res, 404, { error: 'unknown admin api' });
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
    if (req.method === 'OPTIONS') return sendJson(res, 200, {});

    // 健康检查
    if (pathname === '/healthz') {
      return sendJson(res, 200, { ok: true, users: store.users.length, departments: store.departments.length, subcompanies: store.subcompanies.length });
    }

    // ---- HR REST ----
    if (pathname === '/api/ec/dev/auth/applytoken') {
      return await handleApplyToken(req, res);
    }
    if (pathname.startsWith('/api/hrm/resful/')) {
      if (!checkHrAuth(req)) {
        return sendJson(res, 200, { code: '-2', msg: 'token invalid or expired' });
      }
      const body = await readBodyParams(req);
      const params = body.params && typeof body.params === 'object' ? body.params : body;
      if (pathname === '/api/hrm/resful/getHrmsubcompanyWithPage') {
        return handleHrPage(res, store.subcompanies, params);
      }
      if (pathname === '/api/hrm/resful/getHrmdepartmentWithPage') {
        return handleHrPage(res, store.departments, params);
      }
      if (pathname === '/api/hrm/resful/getHrmUserInfoWithPage') {
        return handleHrPage(res, filterUsers(params), params);
      }
      return sendJson(res, 200, { code: '-1', msg: `unknown hrm api: ${pathname}` });
    }

    // ---- OAuth2 ----
    if (pathname === AUTHORIZE_PATH && req.method === 'GET') {
      return await handleAuthorize(req, res, url);
    }
    if (pathname === TOKEN_PATH && req.method === 'POST') {
      return await handleAccessToken(req, res);
    }
    if (pathname === PROFILE_PATH && req.method === 'GET') {
      return await handleProfile(req, res);
    }

    // ---- 管理 API ----
    if (pathname.startsWith('/api/') && !pathname.startsWith('/api/ec/') && !pathname.startsWith('/api/hrm/')) {
      return await handleAdminApi(req, res, url);
    }

    // ---- 管理页 ----
    if (pathname === '/' || pathname === '/index.html') {
      return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8');
    }
    if (pathname === '/app.js') {
      return serveStatic(res, path.join(PUBLIC_DIR, 'app.js'), 'text/javascript; charset=utf-8');
    }
    if (pathname === '/style.css') {
      return serveStatic(res, path.join(PUBLIC_DIR, 'style.css'), 'text/css; charset=utf-8');
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (err) {
    console.error('[mock-weaver] request error:', err);
    sendJson(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`[mock-weaver] listening on http://0.0.0.0:${PORT}`);
  console.log(`  HR sync:  POST /api/ec/dev/auth/applytoken, /api/hrm/resful/*`);
  console.log(`  OAuth2:   GET ${AUTHORIZE_PATH} | POST ${TOKEN_PATH} | GET ${PROFILE_PATH}`);
  console.log(`  Admin UI: http://localhost:${PORT}/`);
  console.log(`  Data:     ${DATA_FILE}`);
});
