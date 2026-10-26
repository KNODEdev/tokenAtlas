

export function appendLogTail(target: { log_tail: string[] }, line: string, limit = 60): void {
  const clean = line.trimEnd();
  if (!clean.trim()) return;
  target.log_tail.push(clean);
  if (target.log_tail.length > limit) target.log_tail.splice(0, target.log_tail.length - limit);
}

/** Buffering a child's pipe to completion hides everything it says until it
 *  exits, which is exactly the wait these states exist to narrate. */
export async function readProcessLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  }
  pending += decoder.decode();
  if (pending) onLine(pending);
}
