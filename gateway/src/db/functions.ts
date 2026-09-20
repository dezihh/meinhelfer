import { getDb } from './schema.js';

export interface ParsedFunction {
  id: number;
  name: string;
  description: string | null;
  template: string;
  parameters: unknown | null;
  budget: number | null;
  enabled: boolean;
}

export interface FunctionInput {
  name: string;
  description: string | null;
  template: string;
  parameters: string | null;
  budget: number | null;
  enabled: number;
}

interface FunctionRow {
  id: number;
  name: string;
  description: string | null;
  template: string;
  parameters: string | null;
  budget: number | null;
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
      `INSERT INTO tpl_functions (name, description, template, parameters, budget, enabled)
       VALUES (@name, @description, @template, @parameters, @budget, @enabled)`
    )
    .run(data);
  const row = getFunction(Number(info.lastInsertRowid));
  if (!row) throw new Error('Funktion konnte nicht gelesen werden');
  return row;
}

export function updateFunction(id: number, data: FunctionInput): ParsedFunction | undefined {
  getDb().prepare(
    `UPDATE tpl_functions SET name = @name, description = @description, template = @template,
     parameters = @parameters, budget = @budget, enabled = @enabled, updated_at = datetime('now') WHERE id = @id`
  ).run({ ...data, id });
  return getFunction(id);
}

export function deleteFunction(id: number): void {
  getDb().prepare('DELETE FROM tpl_functions WHERE id = ?').run(id);
}
