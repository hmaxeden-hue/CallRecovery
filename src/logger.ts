/**
 * Console logger implementing the core Logger port.
 *
 * One JSON object per line: greppable during development and directly usable
 * by any log shipper later, without pulling in a logging framework.
 */

import type { Logger } from './core/types.js';

type Level = 'info' | 'warn' | 'error';

function emit(level: Level, message: string, context?: Record<string, unknown>): void {
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    message,
    ...(context ?? {}),
  });

  if (level === 'error') console.error(line);
  else console.log(line);
}

export function createConsoleLogger(): Logger {
  return {
    info: (message, context) => emit('info', message, context),
    warn: (message, context) => emit('warn', message, context),
    error: (message, context) => emit('error', message, context),
  };
}
