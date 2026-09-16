import { listMcpServers } from '../db.js';
import type { ToolDef } from '../types.js';
import { McpClient, type McpTransport } from './client.js';
import { McpStdioClient } from './stdio.js';

export interface McpServerContext {
  id: number;
  name: string;
  client: McpTransport;
  tools: ToolDef[];
}

export interface McpContext {
  servers: McpServerContext[];
}

// Freschheitsschwelle, ab der beim naechsten Zugriff im Hintergrund neu
// geladen wird. Serve-stale: liefert sofort die letzten bekannten Daten und
// stoesst parallel einen Refresh an -> die naechste Anfrage bekommt frische
// Tools, keine Anfrage wartet auf die MCP-Initialisierung. Bewusst hoch:
// stdio-Clients werden beim Refresh komplett neu gespawnt, zu kleine Werte
// erzeugen dauerhaft Prozess-Churn.
const FRESH_MS = 300_000;
const REFRESH_IN_FLIGHT = new Map<number, Promise<void>>();
const cache = new Map<number, { client: McpTransport; tools: ToolDef[]; ts: number }>();

function stopClient(client: McpTransport | undefined): void {
  if (client && typeof client.stop === 'function') client.stop();
}

export function invalidateMcpCache(): void {
  for (const entry of cache.values()) stopClient(entry.client);
  cache.clear();
}

function parseJsonArray(raw: string | null): string[] {
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw: string | null): Record<string, string> {
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
  } catch {
    return {};
  }
}

function createClient(row: { transport: 'http' | 'stdio'; url: string; auth_token: string | null; command: string | null; args: string | null; env: string | null }): McpTransport {
  if (row.transport === 'stdio') {
    return new McpStdioClient({
      command: row.command ?? '',
      args: parseJsonArray(row.args),
      env: parseJsonObject(row.env),
    });
  }
  return new McpClient(row.url, row.auth_token);
}

export { createClient };

async function loadServer(row: { id: number; transport: 'http' | 'stdio'; url: string; auth_token: string | null; command: string | null; args: string | null; env: string | null }): Promise<{ client: McpTransport; tools: ToolDef[]; ts: number }> {
  const client = createClient(row);
  await client.init();
  const tools = await client.listTools();
  return { client, tools, ts: Date.now() };
}

async function refreshLater(id: number, row: { id: number; transport: 'http' | 'stdio'; url: string; auth_token: string | null; command: string | null; args: string | null; env: string | null }): Promise<void> {
  if (REFRESH_IN_FLIGHT.has(id)) return REFRESH_IN_FLIGHT.get(id);
  const p = (async () => {
    try {
      const fresh = await loadServer(row);
      const old = cache.get(id);
      if (old) stopClient(old.client);
      cache.set(id, fresh);
    } catch (e) {
      // Fehler beim Refresh: alten Cache unveraendert weiterverwenden
      console.error(`MCP-Refresh ${id} fehlgeschlagen:`, e);
    } finally {
      REFRESH_IN_FLIGHT.delete(id);
    }
  })();
  REFRESH_IN_FLIGHT.set(id, p);
  return p;
}

export async function getMcpContext(): Promise<McpContext> {
  const rows = listMcpServers(true);
  // Alle Server parallel: gecachte sofort liefern, Kaltstarts parallel laden
  // (serve-stale-Refresh sowieso). Fehler isoliert pro Server abfangen.
  const results = await Promise.all(
    rows.map(async (row): Promise<McpServerContext | null> => {
      const entry = cache.get(row.id);
      if (entry) {
        if (Date.now() - entry.ts > FRESH_MS) {
          // serve-stale: sofort liefern, Refresh im Hintergrund -> naechste Anfrage frisch
          void refreshLater(row.id, row);
        }
        return { id: row.id, name: row.name, client: entry.client, tools: entry.tools };
      }
      // Kaltstart: erstmalig laden (blockierend, da Daten zwingend noetig),
      // aber ueber alle Rows parallel statt sequenziell.
      try {
        const fresh = await loadServer(row);
        cache.set(row.id, fresh);
        return { id: row.id, name: row.name, client: fresh.client, tools: fresh.tools };
      } catch (e) {
        console.error(`MCP-Init ${row.id} fehlgeschlagen:`, e);
        return null;
      }
    })
  );
  return { servers: results.filter((s): s is McpServerContext => s !== null) };
}