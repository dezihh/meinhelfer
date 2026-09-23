import { getDb } from './schema.js';
import type { SideEffect } from '../types.js';

export interface ParsedFunction {
  id: number;
  name: string;
  description: string | null;
  template: string;
  parameters: unknown | null;
  budget: number | null;
  inventory_prompt: string | null;
  side_effect: SideEffect;
  enabled: boolean;
}

export interface FunctionInput {
  name: string;
  description: string | null;
  template: string;
  parameters: string | null;
  budget: number | null;
  inventory_prompt: string | null;
  side_effect?: SideEffect;
  enabled: number;
}

interface FunctionRow {
  id: number;
  name: string;
  description: string | null;
  template: string;
  parameters: string | null;
  budget: number | null;
  inventory_prompt: string | null;
  side_effect: SideEffect | null;
  enabled: number;
}

function parseFunction(row: FunctionRow): ParsedFunction {
  let parameters: unknown | null = null;
  try {
    parameters = row.parameters ? (JSON.parse(row.parameters) as unknown) : null;
  } catch {
    parameters = null;
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    template: row.template,
    parameters,
    budget: row.budget ?? null,
    inventory_prompt: row.inventory_prompt ?? null,
    side_effect: row.side_effect ?? 'write',
    enabled: !!row.enabled,
  };
}

export function listFunctions(enabledOnly: boolean): ParsedFunction[] {
  const rows = enabledOnly
    ? (getDb().prepare('SELECT * FROM tpl_functions WHERE enabled = 1 ORDER BY name').all() as FunctionRow[])
    : (getDb().prepare('SELECT * FROM tpl_functions ORDER BY name').all() as FunctionRow[]);
  return rows.map(parseFunction);
}

export function getFunction(id: number): ParsedFunction | undefined {
  const row = getDb().prepare('SELECT * FROM tpl_functions WHERE id = ?').get(id) as FunctionRow | undefined;
  return row ? parseFunction(row) : undefined;
}

export function getFunctionByName(name: string): ParsedFunction | undefined {
  const row = getDb().prepare('SELECT * FROM tpl_functions WHERE name = ? AND enabled = 1').get(name) as FunctionRow | undefined;
  return row ? parseFunction(row) : undefined;
}

export function createFunction(data: FunctionInput): ParsedFunction {
  const info = getDb().prepare(
      `INSERT INTO tpl_functions (name, description, template, parameters, budget, inventory_prompt, side_effect, enabled)
       VALUES (@name, @description, @template, @parameters, @budget, @inventory_prompt, @side_effect, @enabled)`
    )
    .run({ ...data, side_effect: data.side_effect ?? 'write' });
  const row = getFunction(Number(info.lastInsertRowid));
  if (!row) throw new Error('Funktion konnte nicht gelesen werden');
  return row;
}

export function updateFunction(id: number, data: FunctionInput): ParsedFunction | undefined {
  getDb().prepare(
    `UPDATE tpl_functions SET name = @name, description = @description, template = @template,
     parameters = @parameters, budget = @budget, inventory_prompt = @inventory_prompt, side_effect = @side_effect, enabled = @enabled, updated_at = datetime('now') WHERE id = @id`
  ).run({ ...data, side_effect: data.side_effect ?? 'write', id });
  return getFunction(id);
}

export function deleteFunction(id: number): void {
  getDb().prepare('DELETE FROM tpl_functions WHERE id = ?').run(id);
}
