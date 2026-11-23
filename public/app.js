/* 泛微 OA Mock 管理页逻辑（无依赖） */
'use strict';

const COLUMN_DEFS = {
  users: {
    endpoint: 'users',
    fields: [
      { key: 'workcode', label: '工号' },
      { key: 'lastname', label: '姓名' },
      { key: 'status', label: '状态', options: [['0', '0 正式'], ['1', '1 试用'], ['2', '2 实习'], ['3', '3 兼职'], ['4', '4 离职'], ['5', '5 待离职']] },
      { key: 'accounttype', label: '账号类型', options: [['0', '0 主账号'], ['1', '1 次账号']] },
      { key: 'departmentid', label: '部门ID' },
      { key: 'subcompanyid1', label: '分部ID' },
      { key: 'mobile', label: '手机' },
      { key: 'email', label: '邮箱' },
      { key: 'telephone', label: '电话' }
    ],
    csv: ['workcode', 'lastname', 'status', 'accounttype', 'departmentid', 'subcompanyid1', 'mobile', 'email', 'telephone'],
    sample: ['77000136', '张三', '0', '0', '11', '1', '13800000136', 'zhangsan@example.com', '']
  },
  departments: {
    endpoint: 'departments',
    fields: [
      { key: 'id', label: 'ID' },
      { key: 'departmentname', label: '部门名称' },
      { key: 'supdepid', label: '上级部门ID' },
      { key: 'subcompanyid1', label: '分部ID' },
      { key: 'canceled', label: '注销', options: [['0', '0 在用'], ['1', '1 注销']] }
    ],
    csv: ['id', 'departmentname', 'supdepid', 'subcompanyid1', 'canceled'],
    sample: ['21', '测试部', '0', '1', '0']
  },
  subcompanies: {
    endpoint: 'subcompanies',
    fields: [
      { key: 'id', label: 'ID' },
      { key: 'subcompanyname', label: '分部名称' },
      { key: 'supsubcomid', label: '上级分部ID' },
      { key: 'canceled', label: '注销', options: [['0', '0 在用'], ['1', '1 注销']] }
    ],
    csv: ['id', 'subcompanyname', 'supsubcomid', 'canceled'],
    sample: ['3', '子公司A', '0', '0']
  }
};

const state = { data: null, editing: {} }; // editing[collection][rowIndex] = boolean

function el(id) { return document.getElementById(id); }

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

async function refresh() {
  state.data = await api('/api/data');
  state.editing = { users: {}, departments: {}, subcompanies: {} };
  renderStats();
  Object.keys(COLUMN_DEFS).forEach(renderTable);
}

function renderStats() {
  const d = state.data;
  el('stats').textContent =
    `人员 ${d.users.length} · 部门 ${d.departments.length} · 分部 ${d.subcompanies.length}` +
    `（在职 ${d.users.filter((u) => ['0', '1', '2', '3'].includes(String(u.status))).length}）`;
}

function cellValue(item, field) {
  const v = item[field.key];
  if (field.options) {
    const found = field.options.find(([val]) => val === String(v ?? ''));
    return found ? found[1] : String(v ?? '');
  }
  return String(v ?? '');
}

function renderTable(collection) {
  const def = COLUMN_DEFS[collection];
  const tbody = el(`${collection === 'users' ? 'user' : collection === 'departments' ? 'dept' : 'sub'}Table`).querySelector('tbody');
  tbody.innerHTML = '';
  const rows = state.data[collection];
  rows.forEach((item, index) => {
    const tr = document.createElement('tr');
    if (state.editing[collection][index]) {
      tr.innerHTML = def.fields
        .map((field) => {
          const value = String(item[field.key] ?? '');
          if (field.options) {
            return `<td><select data-key="${field.key}">${field.options
              .map(([val, label]) => `<option value="${val}" ${val === value ? 'selected' : ''}>${label}</option>`)
              .join('')}</select></td>`;
          }
          return `<td><input data-key="${field.key}" value="${escapeAttr(value)}"></td>`;
        })
        .join('');
      const actions = document.createElement('td');
      actions.className = 'row-actions';
      const save = document.createElement('button');
      save.textContent = '保存';
      save.onclick = () => saveRow(collection, index, tr);
      const cancel = document.createElement('button');
      cancel.textContent = '取消';
      cancel.onclick = () => { delete state.editing[collection][index]; renderTable(collection); };
      actions.append(save, cancel);
      tr.appendChild(actions);
    } else {
      tr.innerHTML = def.fields.map((field) => `<td>${escapeHtml(cellValue(item, field))}</td>`).join('');
      const actions = document.createElement('td');
      actions.className = 'row-actions';
      const edit = document.createElement('button');
      edit.textContent = '编辑';
      edit.onclick = () => { state.editing[collection][index] = true; renderTable(collection); };
      const del = document.createElement('button');
      del.textContent = '删除';
      del.onclick = async () => {
        if (!confirm(`确认删除 ${item.workcode || item.departmentname || item.subcompanyname || item.id} ？`)) return;
        try {
          await api(`/api/${def.endpoint}/${item.id}`, { method: 'DELETE' });
          refresh();
        } catch (err) { alert(err.message); }
      };
      actions.append(edit, del);
      tr.appendChild(actions);
    }
    tbody.appendChild(tr);
  });
}

async function saveRow(collection, index, tr) {
  const def = COLUMN_DEFS[collection];
  const item = state.data[collection][index];
  const payload = { ...item };
  tr.querySelectorAll('[data-key]').forEach((input) => {
    payload[input.dataset.key] = input.value.trim();
  });
  try {
    await api(`/api/${def.endpoint}/${item.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    refresh();
  } catch (err) { alert(err.message); }
}

async function addRow(collection) {
  const def = COLUMN_DEFS[collection];
  const blank = {};
  def.fields.forEach((field) => { blank[field.key] = field.key === 'canceled' || field.key === 'status' || field.key === 'accounttype' ? '0' : ''; });
  try {
    await api(`/api/${def.endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(blank) });
    refresh().then(() => {
      const rows = state.data[collection];
      state.editing[collection][rows.length - 1] = true;
      renderTable(collection);
    });
  } catch (err) { alert(err.message); }
}

/* ---------- CSV ---------- */
function parseCsv(text) {
  const rows = [];
  let cur = [''];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { cur.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      cur.push(field); field = '';
      if (cur.some((v) => v !== '')) rows.push(cur);
      cur = [''];
    } else field += ch;
  }
  if (field !== '' || cur.some((v) => v !== '')) { cur.push(field); rows.push(cur); }
  return rows;
}

function csvToObjects(text) {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (rows.length < 2) throw new Error('CSV 至少需要表头 + 1 行数据');
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cells) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (cells[i] ?? '').trim(); });
    return obj;
  });
}

function objectsToCsv(objects, headers) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [headers.join(','), ...objects.map((obj) => headers.map((h) => esc(obj[h])).join(','))].join('\r\n');
}

function importCsv(collection) {
  const def = COLUMN_DEFS[collection];
  const prefix = collection === 'users' ? 'user' : collection === 'departments' ? 'dept' : 'sub';
  const fileEl = el(`${prefix}Csv`);
  const mode = el(`${prefix}CsvMode`).value;
  if (!fileEl.files[0]) { alert('请选择 CSV 文件'); return; }
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const rows = csvToObjects(String(reader.result));
      const result = await api('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: def.endpoint, mode, rows }) });
      alert(`导入完成：写入 ${result.imported} 条，跳过 ${result.skipped} 条（缺工号）`);
      fileEl.value = '';
      refresh();
    } catch (err) { alert(`导入失败：${err.message}`); }
  };
  reader.readAsText(fileEl.files[0], 'utf-8');
}

function exportCsv(collection) {
  const def = COLUMN_DEFS[collection];
  const csv = objectsToCsv(state.data[collection], def.csv);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${def.endpoint}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function downloadTemplate(collection) {
  const def = COLUMN_DEFS[collection];
  const csv = objectsToCsv([Object.fromEntries(def.csv.map((h) => [h, def.sample[def.csv.indexOf(h)] || '']))], def.csv);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${def.endpoint}-template.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function escapeHtml(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(v) {
  return escapeHtml(v).replace(/"/g, '&quot;');
}

/* ---------- 绑定 ---------- */
document.querySelectorAll('nav .tab').forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll('nav .tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.id !== `tab-${tab.dataset.tab}`; });
  };
});

el('userAdd').onclick = () => addRow('users');
el('deptAdd').onclick = () => addRow('departments');
el('subAdd').onclick = () => addRow('subcompanies');
el('userCsvImport').onclick = () => importCsv('users');
el('deptCsvImport').onclick = () => importCsv('departments');
el('subCsvImport').onclick = () => importCsv('subcompanies');
el('userCsvExport').onclick = () => exportCsv('users');
el('deptCsvExport').onclick = () => exportCsv('departments');
el('subCsvExport').onclick = () => exportCsv('subcompanies');
el('userTemplate').onclick = (e) => { e.preventDefault(); downloadTemplate('users'); };
el('deptTemplate').onclick = (e) => { e.preventDefault(); downloadTemplate('departments'); };
el('subTemplate').onclick = (e) => { e.preventDefault(); downloadTemplate('subcompanies'); };
el('resetBtn').onclick = async () => {
  if (!confirm('确认恢复为示例数据？当前数据将被覆盖。')) return;
  await api('/api/reset', { method: 'POST' });
  refresh();
};

refresh().catch((err) => { el('stats').textContent = `加载失败：${err.message}`; });
