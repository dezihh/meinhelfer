// Gateway-Version aus der package.json (fuer den minGatewayVersion-Check der
// Pakete). Zur Laufzeit gelesen, damit Build und Tests denselben Wert sehen.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const GATEWAY_VERSION = readVersion();
