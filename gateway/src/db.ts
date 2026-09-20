import { config } from './config.js';
import { initDb } from './db/schema.js';

// Runtime-Init (Tests initialisieren bewusst selbst mit Temp-Pfad).
initDb(config.dbPath);

export { initDb, getDb } from './db/schema.js';
export {
  parseAction,
  listActions,
  getAction,
  createAction,
  updateAction,
  deleteAction,
  type ActionInput,
} from './db/actions.js';
export {
  listFunctions,
  getFunction,
  getFunctionByName,
  createFunction,
  updateFunction,
  deleteFunction,
  type ParsedFunction,
  type FunctionInput,
} from './db/functions.js';
export {
  listMcpServers,
  getMcpServer,
  createMcpServer,
  updateMcpServer,
  deleteMcpServer,
  type McpServerInput,
} from './db/mcpServers.js';
export {
  getSettings,
  getSetting,
  getSettingNum,
  setSetting,
  deleteSetting,
  getPrompt,
  setPrompt,
  listPrompts,
} from './db/settings.js';
export {
  addLog,
  listLogs,
  summarizeUsage,
  recentAgentTurns,
  type LogEntry,
} from './db/logs.js';
