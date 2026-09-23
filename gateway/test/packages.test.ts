import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDb } from '../src/db/schema.js';
import {
  installPackage,
  uninstallPackage,
  listInstalledPackages,
  listPackageItems,
  conflictItems,
} from '../src/db/packages.js';
import {
  parseManifest,
  validateManifest,
  substituteParams,
  manifestDangerous,
  manifestItems,
  paramValues,
  manifestHash,
} from '../src/core/packages.js';
import { getSetting, setSetting } from '../src/db/settings.js';
import { getDb } from '../src/db/schema.js';

const OK_MANIFEST = {
  id: 'test-package',
  version: '1.0.0',
  name: 'Test-Paket',
  summary: 'Kurz',
  description: 'Lang',
  params: [
    { key: 'host', label: 'Host', default: '127.0.0.1', required: true },
    { key: 'token', label: 'Token', secret: true, default: 'geheim' },
  ],
  servers: [{ name: 'Test MCP', transport: 'http', url: 'http://${host}:8086/mcp', auth_token: '${token}' }],
  functions: [{ name: 'test_fn', template: 'Server ${host} meldet sich.', parameters: { type: 'object', properties: {} }, budget: 1 }],
  indexes: [{ key: '', config: { tool: 'x_tool', args: {} } }],
  allowTools: ['x_tool', 'fn_test_fn'],
};

before(() => {
  closeDb();
  initDb('/tmp/opencode/test-meinhelfer.db');
  const db = getDb();
  db.exec("DELETE FROM packages WHERE id = 'test-package'");
  db.exec("DELETE FROM package_items WHERE package_id = 'test-package'");
  db.exec("DELETE FROM mcp_servers WHERE name = 'Test MCP'");
  db.exec("DELETE FROM tpl_functions WHERE name = 'test_fn'");
  db.exec("DELETE FROM settings WHERE key = 'entity_index_test'");
});

test('Manifest-Validierung: korrekt + ungueltig', () => {
  const ok = validateManifest(OK_MANIFEST);
  assert.equal(ok.ok, true);
  const bad = validateManifest({ id: 'x', version: 'no' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length >= 2);
});

test('Substitution ersetzt Platzhalter; fehlende werfen', () => {
  assert.equal(substituteParams('http://${host}:${port}/mcp', { host: 'h', port: '8' }), 'http://h:8/mcp');
  assert.throws(() => substituteParams('${fehlt}', {}));
});

test('manifestDangerous: shell = gefaehrlich, http = Info', () => {
  const d = manifestDangerous({ id: 'a', version: '1.0.0', name: 'a', summary: 's', description: 'd', functions: [{ name: 'f', template: "{{ shell('ls') }}" }] });
  assert.equal(d.dangerous, true);
  assert.equal(d.items.length, 1);
  const h = manifestDangerous({ id: 'a', version: '1.0.0', name: 'a', summary: 's', description: 'd', functions: [{ name: 'f', template: "{{ http('https://x') }}" }] });
  assert.equal(h.dangerous, false);
  assert.equal(h.info.length, 1);
});

test('parseManifest: JSON + Fehler-Faelle', () => {
  const ok = parseManifest(JSON.stringify(OK_MANIFEST));
  assert.equal(ok.ok, true);
  const bad = parseManifest('{ defekt');
  assert.equal(bad.ok, false);
});

test('manifestItems fuehrt alle Artefakte', () => {
  const items = manifestItems(OK_MANIFEST as never);
  assert.deepEqual(items.map((i) => i.kind).sort(), ['allowTools', 'function', 'index', 'server']);
});

test('paramValues: Defaults + required', () => {
  const values = paramValues(OK_MANIFEST as never);
  assert.equal(values.host, '127.0.0.1');
  assert.equal(values.token, 'geheim');
});

test('manifestHash stabil', () => {
  assert.equal(manifestHash(OK_MANIFEST as never), manifestHash(OK_MANIFEST as never));
  assert.notEqual(manifestHash(OK_MANIFEST as never), manifestHash({ ...OK_MANIFEST, version: '2.0.0' } as never));
});

test('Install: Upsert + Provenienz + agent_tools-Merge; Reinstall aktualisiert', () => {
  setSetting('agent_tools', 'web_url_read');
  const report = installPackage(OK_MANIFEST as never, { source: 'registry', values: { host: '10.0.0.5', token: 'tok' } });
  assert.deepEqual(report.created.sort(), ['allowTools:x_tool,fn_test_fn', 'function:test_fn', 'index:entity_index', 'server:Test MCP'].sort());
  // Server-URL substituiert, Token in auth_token
  const row = getDb().prepare("SELECT url, auth_token FROM mcp_servers WHERE name = 'Test MCP'").get() as { url: string; auth_token: string };
  assert.equal(row.url, 'http://10.0.0.5:8086/mcp');
  assert.equal(row.auth_token, 'tok');
  const fnRow = getDb().prepare("SELECT template FROM tpl_functions WHERE name = 'test_fn'").get() as { template: string };
  assert.equal(fnRow.template, 'Server 10.0.0.5 meldet sich.');
  // agent_tools: vereinigt, alte bleiben
  const tools = (getSetting('agent_tools') ?? '').split(',').map((s) => s.trim());
  assert.ok(tools.includes('web_url_read'));
  assert.ok(tools.includes('x_tool'));
  // Neu-Install: updated statt created
  const report2 = installPackage(OK_MANIFEST as never, { source: 'registry', values: { host: '10.0.0.5', token: 'tok' } });
  assert.deepEqual(report2.updated.sort(), ['function:test_fn', 'index:entity_index', 'server:Test MCP'].sort());
  // Provenienz
  const pkgs = listInstalledPackages();
  assert.equal(pkgs.length, 1);
  assert.equal(pkgs[0].id, 'test-package');
  assert.ok(pkgs[0].params.includes('10.0.0.5'));
  // Secret-Wert nicht in der Provenienz
  const safe = JSON.parse(pkgs[0].params) as Record<string, string>;
  assert.equal(safe.token, '(gesetzt)');
  assert.equal(safe.host, '10.0.0.5');
  const items = listPackageItems('test-package');
  assert.equal(items.length, 4); // server, function, index, allowTools
});

test('Deinstall-Schutz: lokal geaenderte Zeile bleibt', () => {
  const db = getDb();
  // Funktion lokal aendern (Hash weicht ab)
  db.prepare("UPDATE tpl_functions SET template = 'GEAENDERT' WHERE name = 'test_fn'").run();
  const report = uninstallPackage('test-package');
  assert.equal(report.removed.includes('server:Test MCP'), true);
  assert.equal(report.kept.length, 1);
  const fn = db.prepare("SELECT template FROM tpl_functions WHERE name = 'test_fn'").get() as { template: string } | undefined;
  assert.ok(fn);
  assert.equal(fn.template, 'GEAENDERT');
  const pkgs = listInstalledPackages();
  assert.equal(pkgs.length, 0);
});

test('Backup-Roundtrip (Export -> Restore) ueber Route-Logik simuliert', () => {
  // Minimale Sicherungsstruktur wiederherstellen: settings ersetzt
  const db = getDb();
  db.prepare('DELETE FROM settings').run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('x1', 'a')").run();
  const backup = { kind: 'meinhelfer-config-backup', settings: [{ key: 'x1', value: 'b' }], prompts: [], servers: [], functions: [], actions: [] };
  db.transaction(() => {
    if (Array.isArray(backup.settings)) {
      db.prepare('DELETE FROM settings').run();
      for (const s of backup.settings as { key: string; value: string }[]) {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(s.key, s.value);
      }
    }
  })();
  assert.equal(getSetting('x1'), 'b');
});

test('Reinstall-Diff: lokal geaenderte Zeile wird gemeldet; Entscheidung take/keep; dryRun schreibt nicht', () => {
  const db = getDb();
  db.prepare("DELETE FROM tpl_functions WHERE name = 'test_fn'").run();
  db.prepare("DELETE FROM mcp_servers WHERE name = 'Test MCP'").run();
  db.prepare("DELETE FROM packages WHERE id = 'test-package'").run();
  db.prepare("DELETE FROM package_items WHERE package_id = 'test-package'").run();
  const opts = { source: 'registry', values: { host: '10.0.0.5', token: 'tok' } } as const;
  installPackage(OK_MANIFEST as never, opts);

  // lokal aendern -> Konflikt
  db.prepare("UPDATE tpl_functions SET template = 'LOKAL' WHERE name = 'test_fn'").run();
  assert.deepEqual(conflictItems('test-package'), ['function:test_fn']);

  // Reinstall ohne Entscheidung: ueberschreibt, meldet aber den Konflikt
  const r1 = installPackage(OK_MANIFEST as never, opts);
  assert.deepEqual(r1.conflicts, ['function:test_fn']);
  let fn = db.prepare("SELECT template FROM tpl_functions WHERE name = 'test_fn'").get() as { template: string };
  assert.equal(fn.template, 'Server 10.0.0.5 meldet sich.');

  // erneut lokal aendern, diesmal 'keep'
  db.prepare("UPDATE tpl_functions SET template = 'LOKAL2' WHERE name = 'test_fn'").run();
  const r2 = installPackage(OK_MANIFEST as never, { ...opts, decisions: { 'function:test_fn': 'keep' } });
  assert.deepEqual(r2.kept, ['function:test_fn']);
  fn = db.prepare("SELECT template FROM tpl_functions WHERE name = 'test_fn'").get() as { template: string };
  assert.equal(fn.template, 'LOKAL2');

  // dryRun berechnet den Report, schreibt aber nichts
  const dry = installPackage(OK_MANIFEST as never, { ...opts, dryRun: true });
  const nach = db.prepare("SELECT template FROM tpl_functions WHERE name = 'test_fn'").get() as { template: string };
  assert.equal(nach.template, 'LOKAL2', 'dryRun schreibt nicht');
  assert.deepEqual(dry.conflicts, ['function:test_fn']);
});