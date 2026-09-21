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

test('Fresh-Install-Fill: Prompts + Grundeinstellungen-Defaults, sonst nichts', () => {
  freshInit();
  const db = getDb();
  const sys = db.prepare("SELECT content FROM prompts WHERE key = 'agent_system'").get() as { content: string };
  assert.ok(sys.content.includes('AUSSCHLIESSLICH ein JSON-Objekt'), 'agent_system mit JSON-Antwortformat');
  assert.ok(sys.content.includes('keep_open=true nur'), 'keep_open erklaert');
  assert.ok(!sys.content.includes('HassTurnOn') && !sys.content.includes('nordoel'), 'keine Domänen-Zeilen im Basis-Prompt');
  assert.ok(sys.content.includes('{"needs_clarification"'), 'JSON-Antwortformat');
  const inv = db.prepare("SELECT content FROM prompts WHERE key = 'agent_inventory'").get() as { content: string };
  assert.ok(inv.content.includes('{{AGENT_FNS}}'), 'Marker im Inventory-Seed');
  assert.ok(inv.content.includes('Musik-Falscherkennungen'), 'Regeln-Block');
  const mt = db.prepare("SELECT value FROM settings WHERE key = 'memory_turns'").get() as { value: string } | undefined;
  const mm = db.prepare("SELECT value FROM settings WHERE key = 'memory_minutes'").get() as { value: string } | undefined;
  assert.equal(mt?.value, '4', 'memory_turns-Default');
  assert.equal(mm?.value, '30', 'memory_minutes-Default');
  // Bewusst NICHT geseedet: Systeme/MCP, Vorgaenge, Index, Agent-Funktionen.
  // Nur die 2 generischen Lesefunktionen (find_entities/get_entity) kommen
  // aus dem Schema-Basis-Seed (MCP-neutral, Teil der Migration).
  assert.equal((db.prepare('SELECT COUNT(*) n FROM mcp_servers').get() as { n: number }).n, 0, 'keine MCP-Server');
  assert.equal((db.prepare('SELECT COUNT(*) n FROM tpl_functions').get() as { n: number }).n, 2, 'nur die 2 generischen Lesefunktionen');
  const recherche = db.prepare("SELECT 1 FROM tpl_functions WHERE name = 'recherche'").get();
  assert.ok(!recherche, 'keine Agent-Funktionen geseedet');
  assert.equal((db.prepare('SELECT COUNT(*) n FROM actions').get() as { n: number }).n, 0, 'keine Vorgaenge');
  const idx = db.prepare("SELECT value FROM settings WHERE key = 'entity_index'").get() as { value: string } | undefined;
  assert.equal(idx, undefined, 'kein entity_index-Setting');
  closeDb();
});

test('Seed ist idempotent: erneutes Init fuegt nichts hinzu, User-Edits bleiben', () => {
  freshInit();
  getDb().prepare("UPDATE prompts SET content = 'USER-EDIT' WHERE key = 'agent_inventory'").run();
  closeDb();
  initDb(FRESH_DB, true); // zweiter Lauf auf existierender DB
  const inv = getDb().prepare("SELECT content FROM prompts WHERE key = 'agent_inventory'").get() as { content: string };
  assert.equal(inv.content, 'USER-EDIT', 'Seed ueberschreibt nicht');
  const mt = getDb().prepare("SELECT value FROM settings WHERE key = 'memory_turns'").get() as { value: string };
  assert.equal(mt.value, '4');
  closeDb();
});
