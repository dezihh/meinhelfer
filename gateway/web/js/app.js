const API = '/admin/api';
let bootstrap = { settings: {}, actions: [], functions: [], servers: [], prompts: [] };

function token() {
  return localStorage.getItem('va_token') ?? '';
}

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token()}`,
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function loadBootstrap() {
  try {
    bootstrap = await api('/bootstrap');
    renderSettings();
    renderPromptKeys();
    renderActions();
    renderFunctions();
    renderServers();
  } catch (e) {
    alert(`Bootstrap fehlgeschlagen: ${e.message}`);
  }
}

function showTab(name) {
  document.querySelectorAll('.sidebar nav a').forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  const titles = { settings: 'Grundeinstellungen', monitor: 'Monitor / Test', actions: 'Vorgänge', functions: 'Funktionen', mcp: 'MCP-Registry', logs: 'Logs' };
  $('tab-title').textContent = titles[name] ?? '';
  if (name === 'logs') loadLogs();
}

const SETTINGS_FIELDS = [
  {
    key: 'assistant_name',
    label: 'Assistenten-Name',
    type: 'text',
    help: 'So stellt sich der Agent im Gespräch vor (Standard: Smart Pilot). Gilt für Sprache und Text; die Überschrift auf dem Echo-Display wird separat unter „Display-Titel" gesetzt.',
  },
  {
    key: 'display_title',
    label: 'Display-Titel (APL)',
    type: 'text',
    help: 'Überschrift des APL-Displays auf Echo-Show-Geräten. Wirkt ab der nächsten Anfrage, kein Neustart nötig.',
  },
  {
    key: 'fuzzy_global',
    label: 'Fuzzy-Trigger global',
    type: 'select',
    options: [['1', 'An'], ['0', 'Aus']],
    help: 'Trigger-Phrasen der Vorgänge müssen nicht wortwörtlich getroffen werden – kleine Abweichungen („wie ist der Hausstatus" statt „hausstatus abfragen") reichen. „Aus" = nur exakte Übereinstimmung. Feiner steuerbar über den Schwellwert im jeweiligen Vorgang.',
  },
  {
    key: 'session_followup',
    label: 'Nachfrage (Mikro offen halten)',
    type: 'select',
    options: [['llm', 'Wenn das LLM es vorschlägt'], ['keyword', 'Bei Session-Keyword'], ['beides', 'Beides'], ['0', 'Nie']],
    help: 'Nach der Antwort bleibt das Mikro offen und es folgt „Was kann ich noch für Sie tun?". „LLM-vorgeschlagen": das Modell meldet eine Rückfrage als sinnvoll (z. B. nach Berichten). „Bei Session-Keyword": sobald die Frage eines der Keywords unten enthält. „Nie": Session schließt immer. In einer laufenden Chat-Session bleibt das Mikro ohnehin offen.',
  },
  {
    key: 'session_keywords',
    label: 'Session-Keywords',
    type: 'text',
    help: 'Komma-getrennte Liste (z. B. zusammenfassung, bericht, news). Wirkt nur, wenn die Nachfrage auf „Bei Session-Keyword" oder „Beides" steht.',
  },
  {
    key: 'debug_logging',
    label: 'Debug-Logging',
    type: 'select',
    options: [['0', 'Aus (Betrieb)'], ['1', 'An (Fehlersuche)']],
    help: 'Schreibt ausführliche Schritte (Tool-Aufrufe, Router-Entscheidungen) ins Gateway-Log (docker logs). Für den Alltag aus lassen – spart Lautstärke und macht Logs lesbar.',
  },
];

function renderSettings() {
  const form = $('settings-form');
  form.innerHTML = '';
  const known = new Set(SETTINGS_FIELDS.map((f) => f.key));
  for (const field of SETTINGS_FIELDS) {
    if (!(field.key in bootstrap.settings)) continue;
    form.append(buildSettingField(field));
  }
  for (const key of Object.keys(bootstrap.settings)) {
    if (!known.has(key)) form.append(buildSettingField({ key, label: key, type: 'text', help: '' }));
  }
  form.onclick = (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button.help') : null;
    if (!btn) return;
    const fieldEl = btn.closest('.field');
    const helpText = fieldEl?.querySelector('.field-help');
    if (helpText) helpText.classList.toggle('hidden');
  };
}

function buildSettingField(field) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const head = document.createElement('div');
  head.className = 'field-head';
  const label = document.createElement('label');
  label.textContent = field.label;
  head.append(label);
  const controlValue = bootstrap.settings[field.key] ?? '';
  if (field.help) {
    const help = document.createElement('button');
    help.type = 'button';
    help.className = 'help';
    help.textContent = '?';
    help.setAttribute('aria-label', `Hilfe zu ${field.label}`);
    help.title = field.help;
    head.append(help);
  }
  let control;
  if (field.type === 'select') {
    control = document.createElement('select');
    const current = String(controlValue);
    for (const [value, text] of field.options) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      if (value === current) opt.selected = true;
      control.append(opt);
    }
  } else {
    control = document.createElement('input');
    control.type = 'text';
    control.value = controlValue;
  }
  control.dataset.key = field.key;
  wrap.append(head, control);
  if (field.help) {
    const helpText = document.createElement('div');
    helpText.className = 'field-help hidden';
    helpText.textContent = field.help;
    wrap.append(helpText);
  }
  return wrap;
}

function growPromptTextarea() {
  const ta = $('prompt-content');
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight + 4, 480)}px`;
}

function renderPromptKeys() {
  const select = $('prompt-key');
  const ta = $('prompt-content');
  select.innerHTML = '';
  for (const p of bootstrap.prompts) {
    const opt = document.createElement('option');
    opt.value = p.key;
    opt.textContent = p.key;
    select.append(opt);
  }
  select.onchange = () => {
    const p = bootstrap.prompts.find((x) => x.key === select.value);
    ta.value = p ? p.content : '';
    growPromptTextarea();
  };
  select.onchange();
  ta.addEventListener('input', growPromptTextarea);
  const helpBtn = $('prompt-help-btn');
  if (helpBtn) {
    helpBtn.onclick = () => $('prompt-help').classList.toggle('hidden');
  }
}

function renderActions() {
  const tbody = $('actions-table').querySelector('tbody');
  tbody.innerHTML = '';
  for (const a of bootstrap.actions) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(a.name)}</td>
      <td><span class="badge">${esc(a.mode)}</span></td>
      <td>${esc((a.triggers ?? []).join(', '))}</td>
      <td>${a.enabled ? '✔' : '✖'}</td>
      <td class="actions"><button class="btn small">Bearbeiten</button></td>`;
    tr.querySelector('button').onclick = () => openActionEditor(a.id);
    tbody.append(tr);
  }
}

function syncActionToolsInput() {
  const checks = document.querySelectorAll('#action-tools-list input[type=checkbox]:checked');
  $('action-tools').value = Array.from(checks).map((c) => c.value).join('\n');
}

async function loadToolPicker(selected) {
  const list = $('action-tools-list');
  const sel = new Set(selected ?? []);
  function group(label, names) {
    if (!names.length) return;
    const det = document.createElement('details');
    det.className = 'tool-group';
    const sum = document.createElement('summary');
    sum.textContent = `${label} (${names.length})`;
    det.append(sum);
    for (const name of names) {
      const lab = document.createElement('label');
      lab.className = 'check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = name;
      cb.checked = sel.has(name);
      cb.addEventListener('change', syncActionToolsInput);
      lab.append(cb, ' ', name);
      det.append(lab);
    }
    list.append(det);
  }
  try {
    const info = await api('/tools');
    group('Funktionen (als LLM-Tools)', info.functions ?? []);
    for (const srv of info.mcp ?? []) group(`${srv.server} (MCP)`, srv.tools ?? []);
  } catch {
    // Tools nicht ladbar: Editor trotzdem nutzbar (dann manuell)
  }
}

function renderFunctions() {
  const tbody = $('functions-table').querySelector('tbody');
  tbody.innerHTML = '';
  for (const f of bootstrap.functions ?? []) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><code>{{ fn('${esc(f.name)}') }}</code></td>
      <td>${esc(f.description)}</td>
      <td>${f.enabled ? '✔' : '✖'}</td>
      <td class="actions"><button class="btn small">Bearbeiten</button></td>`;
    tr.querySelector('button').onclick = () => openFunctionEditor(f.id);
    tbody.append(tr);
  }
}

function openFunctionEditor(id) {
  const f = id ? (bootstrap.functions ?? []).find((x) => x.id === id) : null;
  $('fn-editor').classList.remove('hidden');
  $('fn-preview-out').classList.add('hidden');
  $('fn-editor-title').textContent = f ? `Funktion: ${f.name}` : 'Neue Funktion';
  $('fn-id').value = f?.id ?? '';
  $('fn-name').value = f?.name ?? '';
  $('fn-description').value = f?.description ?? '';
  $('fn-template').value = f?.template ?? '';
  $('fn-enabled').checked = f ? !!f.enabled : true;
}

function functionPayload() {
  return {
    name: $('fn-name').value.trim(),
    description: $('fn-description').value.trim() || null,
    template: $('fn-template').value.trim(),
    enabled: $('fn-enabled').checked,
  };
}

async function saveFunction() {
  try {
    const payload = functionPayload();
    const id = $('fn-id').value;
    if (id) await api(`/functions/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/functions', { method: 'POST', body: JSON.stringify(payload) });
    await loadBootstrap();
    $('fn-editor').classList.add('hidden');
  } catch (e) {
    alert(`Speichern fehlgeschlagen: ${e.message}`);
  }
}

async function deleteFunctionUi() {
  const id = $('fn-id').value;
  if (!id || !confirm('Funktion löschen?')) return;
  await api(`/functions/${id}`, { method: 'DELETE' });
  await loadBootstrap();
  $('fn-editor').classList.add('hidden');
}

async function previewFunction() {
  const out = $('fn-preview-out');
  out.classList.remove('hidden');
  out.textContent = 'Rendere …';
  try {
    const d = await api('/functions/preview', {
      method: 'POST',
      body: JSON.stringify({ template: $('fn-template').value.trim() }),
    });
    const steps = (d.trace ?? []).map((t) => t.step).join(' → ');
    out.textContent = `${d.rendered?.speech ?? ''}\n\n[trace] ${steps || '(keine Datenabrufe)'}`;
  } catch (e) {
    out.textContent = `Fehler: ${e.message}`;
  }
}

function fillFunctionSelect(selected) {
  const sel = $('action-function');
  sel.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '— Inline-Template verwenden —';
  sel.append(none);
  for (const f of bootstrap.functions ?? []) {
    const opt = document.createElement('option');
    opt.value = f.name;
    opt.textContent = `${f.name}${f.enabled ? '' : ' (inaktiv)'}${f.description ? ' — ' + f.description.slice(0, 60) : ''}`;
    if (f.name === selected) opt.selected = true;
    sel.append(opt);
  }
}

function openActionEditor(id) {
  const a = id ? bootstrap.actions.find((x) => x.id === id) : null;
  $('action-editor').classList.remove('hidden');
  $('action-editor-title').textContent = a ? `Vorgang: ${a.name}` : 'Neuer Vorgang';
  $('action-id').value = a?.id ?? '';
  $('action-name').value = a?.name ?? '';
  $('action-mode').value = a?.mode ?? 'llm';
  $('action-triggers').value = (a?.triggers ?? []).join('\n');
  $('action-threshold').value = a?.fuzzy_threshold ?? '';
  $('action-system').value = a?.system_prompt ?? '';
  fillFunctionSelect(a?.function_ref ?? '');
  $('action-tools-list').innerHTML = '';
  void loadToolPicker(a?.toolList ?? []).then(syncActionToolsInput);
  $('action-enabled').checked = a ? !!a.enabled : true;
  updateFunctionFieldVisibility();
}

function updateFunctionFieldVisibility() {
  $('action-function-field').classList.toggle('hidden', $('action-mode').value === 'llm');
}

function actionPayload() {
  const lines = (v) => v.split('\n').map((s) => s.trim()).filter(Boolean);
  const threshold = $('action-threshold').value.trim();
  return {
    name: $('action-name').value.trim(),
    mode: $('action-mode').value,
    trigger_phrases: lines($('action-triggers').value),
    fuzzy_threshold: threshold === '' ? null : Number(threshold),
    system_prompt: $('action-system').value.trim() || null,
    function_ref: $('action-function').value || null,
    template: null,
    tools: lines($('action-tools').value),
    enabled: $('action-enabled').checked,
  };
}

async function saveAction() {
  const mode = $('action-mode').value;
  if (mode !== 'llm' && !$('action-function').value) {
    alert(`Im ${mode === 'hybrid' ? 'hybriden' : 'deterministischen'} Modus muss eine Funktion gewählt sein (Funktionen-Tab zum Anlegen).`);
    return;
  }
  syncActionToolsInput();
  const payload = actionPayload();
  const id = $('action-id').value;
  if (id) await api(`/actions/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
  else await api('/actions', { method: 'POST', body: JSON.stringify(payload) });
  await loadBootstrap();
  $('action-editor').classList.add('hidden');
}

async function deleteActionUi() {
  const id = $('action-id').value;
  if (!id || !confirm('Vorgang wirklich löschen?')) return;
  await api(`/actions/${id}`, { method: 'DELETE' });
  await loadBootstrap();
  $('action-editor').classList.add('hidden');
}

function renderServers() {
  const tbody = $('mcp-table').querySelector('tbody');
  tbody.innerHTML = '';
  for (const s of bootstrap.servers) {
    const tr = document.createElement('tr');
    const target = s.transport === 'stdio' ? `[stdio] ${s.command ?? ''}` : s.url;
    tr.innerHTML = `
      <td>${esc(s.name)}</td>
      <td>${esc(target)}</td>
      <td>${s.enabled ? '✔' : '✖'}</td>
      <td class="actions"><button class="btn small">Bearbeiten</button></td>`;
    tr.querySelector('button').onclick = () => openServerEditor(s.id);
    tbody.append(tr);
  }
}

function toggleMcpTransportFields(transport) {
  const stdio = transport === 'stdio';
  for (const id of ['mcp-url-label', 'mcp-url', 'mcp-token-label', 'mcp-token']) {
    $(id).classList.toggle('hidden', stdio);
  }
  for (const id of ['mcp-command-label', 'mcp-command', 'mcp-args-label', 'mcp-args', 'mcp-env-label', 'mcp-env']) {
    $(id).classList.toggle('hidden', !stdio);
  }
}

function openServerEditor(id) {
  const s = id ? bootstrap.servers.find((x) => x.id === id) : null;
  $('mcp-editor').classList.remove('hidden');
  $('mcp-editor-title').textContent = s ? `MCP-Server: ${s.name}` : 'Neuer MCP-Server';
  $('mcp-id').value = s?.id ?? '';
  $('mcp-name').value = s?.name ?? '';
  $('mcp-transport').value = s?.transport ?? 'http';
  $('mcp-url').value = s?.url ?? '';
  $('mcp-token').value = '';
  $('mcp-command').value = s?.command ?? '';
  let argsText = '';
  let envText = '';
  try { argsText = s?.args ? JSON.parse(s.args).join(', ') : ''; } catch { argsText = ''; }
  try {
    if (s?.env) {
      envText = Object.entries(JSON.parse(s.env)).map(([k, v]) => `${k}=${v}`).join('\n');
    }
  } catch { envText = ''; }
  $('mcp-args').value = argsText;
  $('mcp-env').value = envText;
  $('mcp-enabled').checked = s ? !!s.enabled : true;
  $('mcp-tools').innerHTML = '';
  toggleMcpTransportFields($('mcp-transport').value);
}

async function saveServer() {
  const transport = $('mcp-transport').value;
  const payload = {
    name: $('mcp-name').value.trim(),
    transport,
    enabled: $('mcp-enabled').checked,
  };
  if (transport === 'stdio') {
    payload.command = $('mcp-command').value.trim();
    payload.args = $('mcp-args').value;
    payload.env = $('mcp-env').value;
    payload.url = '';
  } else {
    payload.url = $('mcp-url').value.trim();
    if ($('mcp-token').value) payload.auth_token = $('mcp-token').value;
  }
  const id = $('mcp-id').value;
  if (id) await api(`/mcp-servers/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
  else await api('/mcp-servers', { method: 'POST', body: JSON.stringify(payload) });
  await loadBootstrap();
  $('mcp-editor').classList.add('hidden');
}

async function healthServer() {
  const id = $('mcp-id').value;
  if (!id) {
    alert('Bitte zuerst speichern.');
    return;
  }
  $('mcp-tools').textContent = 'Abfrage läuft…';
  try {
    const res = await api(`/mcp-servers/${id}/health`, { method: 'POST' });
    $('mcp-tools').innerHTML = res.ok
      ? res.tools.map((t) => `<div>${esc(t)}</div>`).join('')
      : `<div class="error-text">${esc(res.error)}</div>`;
  } catch (e) {
    $('mcp-tools').innerHTML = `<div class="error-text">${esc(e.message)}</div>`;
  }
}

async function deleteServer() {
  const id = $('mcp-id').value;
  if (!id || !confirm('MCP-Server wirklich löschen?')) return;
  await api(`/mcp-servers/${id}`, { method: 'DELETE' });
  await loadBootstrap();
  $('mcp-editor').classList.add('hidden');
}

async function sendTest() {
  const text = $('test-text').value.trim();
  if (!text) return;
  $('test-send').disabled = true;
  $('test-result').innerHTML = '<div class="test-meta">Verarbeite…</div>';
  $('test-trace').innerHTML = '';
  try {
    const res = await api('/query', { method: 'POST', body: JSON.stringify({ sessionId: 'monitor', text }) });
    const r = res.response;
    const badge = res.route === 'action' ? 'badge action' : 'badge agent';
    $('test-result').innerHTML = `
      <div class="test-answer">${esc(r.speech)}</div>
      <div class="test-meta">
        Route: <span class="${badge}">${esc(res.route)}</span>
        ${res.score ? `Score: ${Number(res.score).toFixed(2)}` : ''}
        Dauer: ${res.durationMs} ms
        ${r.followUp ? '· Rückfrage (Session offen)' : ''}
      </div>`;
    $('test-trace').innerHTML = (res.trace ?? [])
      .map((t) => `<li><span class="ts">${new Date(t.ts).toLocaleTimeString()}</span>${esc(t.step)} <pre>${esc(t.detail ? JSON.stringify(t.detail) : '')}</pre></li>`)
      .join('');
  } catch (e) {
    $('test-result').innerHTML = `<div class="error-text">${esc(e.message)}</div>`;
  } finally {
    $('test-send').disabled = false;
  }
}

async function loadLogs() {
  try {
    const res = await api('/logs?limit=50');
    let usage = {};
    try { usage = await api('/usage'); } catch { /* Aeltere Gateway-Version ohne /usage */ }
    const u = usage.usage ?? {};
    const total = (u.promptTokens ?? 0) + (u.completionTokens ?? 0);
    $('usage-summary').innerHTML = u.llmRequests
      ? `LLM-Requests: <b>${u.llmRequests}</b> | Tokens gesamt: <b>${total.toLocaleString('de-DE')}</b> (Prompt ${u.promptTokens.toLocaleString('de-DE')} + Completion ${u.completionTokens.toLocaleString('de-DE')}) | davon Cache-Hits: ${u.cachedRequests}`
      : 'Noch keine LLM-Tokens erfasst.';
    const tbody = $('logs-table').querySelector('tbody');
    tbody.innerHTML = '';
    for (const l of res.logs) {
      const tr = document.createElement('tr');
      const tok = (l.prompt_tokens ?? 0) + (l.completion_tokens ?? 0);
      tr.innerHTML = `
        <td>${esc(l.ts)}</td>
        <td><span class="badge ${l.route === 'action' ? 'action' : 'agent'}">${esc(l.route)}</span></td>
        <td>${esc(l.query)}</td>
        <td>${esc(String(l.response ?? '').slice(0, 120))}</td>
        <td>${l.duration_ms} ms</td>
        <td>${tok > 0 ? tok.toLocaleString('de-DE') + ' (' + esc(l.llm_model ?? '') + ')' : '—'}</td>`;
      tbody.append(tr);
    }
  } catch (e) {
    alert(`Logs fehlgeschlagen: ${e.message}`);
  }
}

function init() {
  document.querySelectorAll('.sidebar nav a').forEach((a) => (a.onclick = () => showTab(a.dataset.tab)));
  $('token').value = token();
  $('token-save').onclick = () => {
    localStorage.setItem('va_token', $('token').value);
    loadBootstrap();
  };
  $('settings-save').onclick = async () => {
    const settings = {};
    $('settings-form').querySelectorAll('input[data-key], select[data-key]').forEach((i) => (settings[i.dataset.key] = i.value));
    await api('/settings', { method: 'PUT', body: JSON.stringify({ settings }) });
    await loadBootstrap();
  };
  $('prompt-save').onclick = async () => {
    await api(`/prompts/${$('prompt-key').value}`, {
      method: 'PUT',
      body: JSON.stringify({ content: $('prompt-content').value }),
    });
    await loadBootstrap();
  };
  $('test-send').onclick = sendTest;
  $('test-text').onkeydown = (e) => { if (e.key === 'Enter') sendTest(); };
$('action-new').onclick = () => openActionEditor(null);
$('action-save').onclick = saveAction;
$('action-delete').onclick = deleteActionUi;
$('fn-new').onclick = () => openFunctionEditor(null);
$('fn-save').onclick = saveFunction;
$('fn-delete').onclick = deleteFunctionUi;
$('fn-preview').onclick = previewFunction;
$('fn-editor').onclick = (e) => {
  if (!(e.target instanceof Element)) return;
  const btn = e.target.closest('button.help');
  if (!btn) return;
  const fieldEl = btn.closest('.field');
  const helpText = fieldEl?.querySelector('.field-help');
  if (helpText) helpText.classList.toggle('hidden');
};
$('action-editor').onclick = (e) => {
  if (!(e.target instanceof Element)) return;
  const btn = e.target.closest('button.help');
  if (!btn) return;
  const fieldEl = btn.closest('.field');
  const helpText = fieldEl?.querySelector('.field-help');
  if (helpText) helpText.classList.toggle('hidden');
};
$('action-mode').addEventListener('change', updateFunctionFieldVisibility);

$('mcp-new').onclick = () => openServerEditor(null);
$('mcp-save').onclick = saveServer;
$('mcp-health').onclick = healthServer;
$('mcp-delete').onclick = deleteServer;
$('mcp-transport').onchange = () => toggleMcpTransportFields($('mcp-transport').value);
  $('logs-refresh').onclick = loadLogs;
  loadBootstrap();
}

init();
