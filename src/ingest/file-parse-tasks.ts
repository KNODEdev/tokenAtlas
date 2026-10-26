import { ParsePool, parseWorkerCount, type ParseFormat, type ParseFormats } from "./parse-pool";

export interface FileParseTask<T> { pooled(pool: ParsePool): Promise<T> }
export function fileParseTask<F extends ParseFormat>(format: F, input: ParseFormats[F]["input"]): FileParseTask<ParseFormats[F]["output"]> {
  return { pooled: pool => pool.run(format, input) };
}
export async function runFileTasks<T, R>(steps: Generator<FileParseTask<T>, R, T>, sharedPool?: ParsePool): Promise<R> {
  const pool = sharedPool ?? new ParsePool(parseWorkerCount());
  try {
    let next = steps.next();
    while (!next.done) {
      let value: T;
      try { value = await next.value.pooled(pool); }
      catch (error) { next = steps.throw(error); continue; }
      next = steps.next(value);
    }
    return next.value;
  } finally { if (!sharedPool) await pool.close(); }
}
