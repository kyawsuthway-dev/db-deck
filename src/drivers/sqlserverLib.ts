/**
 * tedious, loaded on the first SQL Server connection (`drivers.md`: libraries load on first use) through
 * `await import('./sqlserverLib')`. `require` (not `import * as`) is what hands back tedious's own value-parser
 * exports: esbuild's `import *` gives a copy, and wrapping `readValue` on a copy would change nothing.
 */
import tedious = require('tedious');
import valueParser = require('tedious/lib/value-parser');
import helpers = require('tedious/lib/token/helpers');
import handler = require('tedious/lib/token/handler');
import { installExactValues, type TediousHelpers, type TediousValueParser } from './sqlserverValues';

/** Where the command of the statement that just finished is kept on a tedious Request. */
export const DONE_COMMAND = Symbol('dbDeckDoneCommand');

installExactValues(valueParser as unknown as TediousValueParser, helpers as unknown as TediousHelpers);
recordDoneCommands(handler as unknown as { RequestTokenHandler: { prototype: DoneHandlers } });

interface DoneHandlers {
  onDone(token: DoneToken): void;
  onDoneInProc(token: DoneToken): void;
  onDoneProc(token: DoneToken): void;
}
interface DoneToken {
  curCmd?: number;
}

/**
 * tedious's done events carry the row count but not the statement's command (TDS `CurCmd`), which is what says
 * whether a count means "rows affected": `DECLARE @x int = 5` and `SET @x = 1` report one row as SELECT does.
 * Each request's handler is wrapped once to keep the command on the request just before the event fires.
 * Checked against tedious 19.2.2 (pinned).
 */
function recordDoneCommands(lib: { RequestTokenHandler: { prototype: DoneHandlers } }): void {
  const proto = lib.RequestTokenHandler.prototype as DoneHandlers & { [DONE_COMMAND]?: true };
  if (proto[DONE_COMMAND]) return;
  proto[DONE_COMMAND] = true;
  for (const name of ['onDone', 'onDoneInProc', 'onDoneProc'] as const) {
    const original = proto[name];
    proto[name] = function (this: { request?: Record<symbol, unknown> }, token: DoneToken) {
      if (this.request) this.request[DONE_COMMAND] = token.curCmd;
      return original.call(this, token);
    };
  }
}

export { tedious };
