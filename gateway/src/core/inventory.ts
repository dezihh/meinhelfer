// Inventory-Generator: der Faehigkeits-Katalog des Agenten entsteht aus den
// registrierten Funktionen selbst (inventory_note), nicht aus einer langen
// Handpflege-Datei. `agent_inventory` bleibt der Regel-Block (Verhalten,
// Kaskaden, Alias-Listen); der Marker {{AGENT_FNS}} wird durch die
// Objekt-Zeilen ersetzt (Fallback: ans Ende).
// Reihenfolge/Inhalt deterministisch (fn.id), damit der LLM-Prefix stabil ist.
import { listFunctions, type ParsedFunction } from '../db/functions.js';
import { getPrompt, getSetting } from '../db/settings.js';

const FNS_MARKER = '{{AGENT_FNS}}';

function toolNameFor(fn: ParsedFunction): string {
  return `fn_${fn.name}`;
}

// Nur fns, die der Agent auch aufrufen darf (agent_tools-Allowlist-Semantik:
// nicht gesetzt/'alle' = alle, 'keine' = keine, Liste = exakt diese).
export function agentFnAllowlist(): string[] | null {
  const raw = (getSetting('agent_tools') ?? '').trim().toLowerCase();
  if (!raw || raw === 'alle') return null;
  if (raw === 'keine') return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function fnLines(allowlist: string[] | null): string[] {
  const lines: string[] = [];
  for (const fn of listFunctions(true)) {
    const note = (fn.inventory_note ?? '').trim();
    if (!note) continue;
    const toolName = toolNameFor(fn);
    if (allowlist && !allowlist.includes(fn.name) && !allowlist.includes(toolName)) continue;
    lines.push(`- ${toolName}: ${note}`);
  }
  return lines;
}

export function buildInventoryPrompt(): string {
  const rules = getPrompt('agent_inventory') ?? '';
  const lines = fnLines(agentFnAllowlist());
  if (lines.length === 0) return rules;
  if (rules.includes(FNS_MARKER)) {
    return rules.split(FNS_MARKER).join(lines.join('\n'));
  }
  return `${rules}\n\n## Werkzeuge (aus den registrierten Funktionen)\n${lines.join('\n')}`;
}
