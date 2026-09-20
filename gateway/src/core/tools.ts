// Tool-Spec-Bau: MCP-Tools + Funktionen als LLM-Tool-Specs (Allowlist-Filter,
// Namens-Kollisionen, Budgets). Reine Bau-Funktion - kein LLM-Kontext.
import type { McpContext } from '../mcp/registry.js';
import type { ToolSpec } from '../llm/client.js';
import { listFunctions } from '../db/functions.js';

export type ToolRoute =
  | { kind: 'mcp'; client: McpContext['servers'][number]['client']; toolName: string }
  | { kind: 'function'; name: string };

export type ToolRouteMap = { specs: ToolSpec[]; routes: Map<string, ToolRoute>; budgets: Map<string, number> };

export const LLM_BLOCKED_TOOLS = new Set(['googe_ai', 'gargedoor_open_script', '_433_gray4_off', '_433_gray4_on', 'XXXXXXXXXXXXXXhausstatus']);

export function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function buildMcpTools(
  mcp: McpContext,
  allowlist: string[] | null,
  routes: Map<string, ToolRoute>,
  specs: ToolSpec[]
): void {
  const used = new Set(routes.keys());
  for (const server of mcp.servers) {
    for (const def of server.tools) {
      if (LLM_BLOCKED_TOOLS.has(def.name)) continue;
      let name = sanitizeToolName(def.name);
      if (routes.has(def.name) || used.has(name)) {
        name = `${sanitizeToolName(server.name)}__${sanitizeToolName(def.name)}`;
      }
      if (used.has(name)) continue;
      if (allowlist && !allowlist.includes(def.name) && !allowlist.includes(name)) continue;
      used.add(name);
      routes.set(name, { kind: 'mcp', client: server.client, toolName: def.name });
      specs.push({
        type: 'function',
        function: {
          name,
          description: (def.description ?? '').slice(0, 160),
          parameters: def.inputSchema ?? { type: 'object' },
        },
      });
    }
  }
}

export function buildTools(
  mcp: McpContext,
  allowlist: string[] | null
): ToolRouteMap {
  const routes = new Map<string, ToolRoute>();
  const specs: ToolSpec[] = [];
  const budgets = new Map<string, number>();
  buildMcpTools(mcp, allowlist, routes, specs);
  // Funktionen (Stufe 2.5): registrierte Funktionen als dynamische LLM-Tools,
  // optional mit Parameter-Schema; Argumente landen als args im Template.
  for (const fn of listFunctions(true)) {
    const toolName = `fn_${fn.name}`;
    if (allowlist && !allowlist.includes(fn.name) && !allowlist.includes(toolName)) continue;
    routes.set(toolName, { kind: 'function', name: fn.name });
    if (fn.budget && fn.budget > 0) budgets.set(toolName, fn.budget);
    specs.push({
      type: 'function',
      function: {
        name: toolName,
        description: (fn.description ?? `Funktion ${fn.name}`).slice(0, 300),
        parameters:
          fn.parameters && typeof fn.parameters === 'object'
            ? (fn.parameters as ToolSpec['function']['parameters'])
            : { type: 'object', properties: {} },
      },
    });
  }
  return { specs, routes, budgets };
}
