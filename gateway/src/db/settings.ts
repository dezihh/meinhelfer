import { getDb } from './schema.js';

export function getSettings(): Record<string, string> {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function deleteSetting(key: string): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
}

export function getSetting(key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

// Settings-Override mit Fallback: DB-Wert (Web-UI) gewinnt, Code/.env liefert
// den Default. Leerer String zaehlt als "nicht gesetzt".
export function getSettingNum(key: string, fallback: number): number {
  const v = getSetting(key);
  if (v == null || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function setSetting(key: string, value: string): void {
  getDb().prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

export function getPrompt(key: string): string | undefined {
  const row = getDb().prepare('SELECT content FROM prompts WHERE key = ?').get(key) as
    | { content: string }
    | undefined;
  return row?.content;
}

export function setPrompt(key: string, content: string): void {
  getDb().prepare(
    'INSERT INTO prompts (key, content) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET content = excluded.content, updated_at = datetime(\'now\')'
  ).run(key, content);
}

export function listPrompts(): { key: string; content: string; updated_at: string }[] {
  return getDb().prepare('SELECT key, content, updated_at FROM prompts ORDER BY key').all() as {
    key: string;
    content: string;
    updated_at: string;
  }[];
}
