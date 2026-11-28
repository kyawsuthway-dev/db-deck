/**
 * node-oracledb (Thin mode), loaded on the first Oracle connection (`oracleLib()` in oracle.ts) from its own file,
 * dist/oracle.js (esbuild.mjs LIBRARY_BUNDLES). `require` (not `import * as`) hands back the library's own decoder
 * class, so replacing `parseOracleDate` on it reaches every value Thin decodes. `initOracleClient()` (Thick mode) is
 * never called, so the package's native `.node` files are never loaded (core.md rule 1). Checked against 26.0.0 (pinned).
 */
import oracledb = require('oracledb');
import buffer = require('oracledb/lib/impl/datahandlers/buffer.js');
import { installExactDates } from './oracleValues';

installExactDates(buffer.BaseBuffer);

export { oracledb };
