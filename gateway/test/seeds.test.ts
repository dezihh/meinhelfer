import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { initDb, closeDb, getDb } from '../src/db/schema.js';

const FRESH_DB = '/tmp/opencode/test-seeds-fresh.db';

function freshInit(): void {
  closeDb();
  // WAL/SHM mitloeschen: eine alte -wal-Datei kann sonst eine neue .db
  // "rekonstruieren" (SQLite-WAL-Recovery) und laesst Seed-Referenzdaten in
  // hermetische Tests rutschen.
  rmSync(FRESH_DB, { force: true });
  rmSync(FRESH_DB + '-wal', { force: true });
  rmSync(FRESH_DB + '-shm', { force: true });
  initDb(FRESH_DB, true);
}

test('Fresh-Install-Fill: Systeme, Funktionen, Vorgaenge, Prompts, entity_index', () => {
  freshInit();
  const db = getDb();
  const servers = db.prepare('SELECT name FROM mcp_servers').all() as { name: string }[];
  assert.equal(servers.length, 4, '4 Systeme geseedet');
  const recherche = db.prepare("SELECT * FROM tpl_functions WHERE name = 'recherche'").get() as { budget: number; inventory_note: string; parameters: string } | undefined;
  assert.ok(recherche, 'fn_recherche geseedet');
  assert.equal(recherche.budget, 2);
  assert.match(recherche.inventory_note, /Recherche/);
  assert.ok(JSON.parse(recherche.parameters).properties.query, 'parameters-Schema gesetzt');
  const hausstatus = db.prepare("SELECT LENGTH(template) AS len FROM tpl_functions WHERE name = 'hausstatus_gw'").get() as { len: number } | undefined;
  assert.ok(hausstatus && hausstatus.len > 3000, 'hausstatus_gw-Template vollstaendig');
  const inv = db.prepare("SELECT content FROM prompts WHERE key = 'agent_inventory'").get() as { content: string };
  assert.ok(inv.content.includes('{{AGENT_FNS}}'), 'Marker im Inventory-Seed');
  assert.ok(inv.content.includes('Musik-Falscherkennungen'), 'Regeln-Block');
  const sys = db.prepare("SELECT content FROM prompts WHERE key = 'agent_system'").get() as { content: string };
  assert.ok(sys.content.includes('fn_find_entities'), 'agent_system auf fn-Namen');
  const hilfe = db.prepare("SELECT * FROM actions WHERE name = 'hilfe'").get() as { mode: string; system_prompt: string; tools: string } | undefined;
  assert.ok(hilfe && hilfe.mode === 'llm' && hilfe.system_prompt.includes('Tool-Inventory'), 'hilfe-Action mit Katalog-Beispielen im Prompt');
  assert.equal(hilfe?.tools, '[]', 'hilfe bewusst ohne Tools');
  const hausAction = db.prepare("SELECT function_ref FROM actions WHERE name = 'hausstatus'").get() as { function_ref: string } | undefined;
  assert.equal(hausAction?.function_ref, 'hausstatus_gw');
  const idx = db.prepare("SELECT value FROM settings WHERE key = 'entity_index'").get() as { value: string } | undefined;
  assert.ok(idx && idx.value.includes('ha_eval_template'), 'entity_index geseedet');
  const boerse = db.prepare("SELECT fuzzy_threshold FROM actions WHERE name = 'boerse'").get() as { fuzzy_threshold: number } | undefined;
  assert.equal(boerse?.fuzzy_threshold, 0.75, 'boerse-Schwelle gegen status-Fuzzy-Fehltreffer');
  closeDb();
});

test('Seed ist idempotent: erneutes Init fuegt nichts hinzu, User-Edits bleiben', () => {
  freshInit();
  getDb().prepare("UPDATE tpl_functions SET inventory_note = 'USER-EDIT' WHERE name = 'recherche'").run();
  closeDb();
  initDb(FRESH_DB, true); // zweiter Lauf auf existierender DB
  const note = getDb().prepare("SELECT inventory_note FROM tpl_functions WHERE name = 'recherche'").get() as { inventory_note: string };
  assert.equal(note.inventory_note, 'USER-EDIT', 'Seed ueberschreibt nicht');
  const servers = getDb().prepare('SELECT COUNT(*) AS n FROM mcp_servers').get() as { n: number };
  assert.equal(servers.n, 4);
  closeDb();
});
