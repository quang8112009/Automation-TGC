/**
 * Pure, incremental Server-Sent Events (SSE) frame parser.
 *
 * Extracted so the streaming clients (assistant, content generation) share ONE
 * well-defined, property-testable framing implementation instead of duplicating
 * ad-hoc line handling. It is framework-free and deterministic.
 *
 * SSE framing rules implemented:
 *  - Frames are separated by a blank line (`\n\n`). CRLF line endings are
 *    tolerated (a trailing `\r` is stripped per line).
 *  - Within a frame, `event:` sets the event name (last one wins; default
 *    `message`), `data:` lines are collected and joined with `\n`, and a single
 *    optional leading space after the colon is removed.
 *  - Lines starting with `:` are comments/heartbeats and ignored.
 *  - A frame with NO data line is dropped (e.g. a heartbeat-only block).
 *
 * `parseSseFrames` is incremental: it returns the complete frames found in
 * `buffer` plus the leftover `rest` (an unterminated trailing frame) so the
 * caller can append the next network chunk and call again without losing data.
 */
export interface SseFrame {
  event: string;
  data: string;
}

export interface SseParseResult {
  frames: SseFrame[];
  /** Unterminated trailing text to prepend to the next chunk. */
  rest: string;
}

/** Parse one complete frame block (already split on the blank-line boundary). */
function parseBlock(block: string): SseFrame | null {
  let event = 'message';
  const dataLines: string[] = [];
  let hasData = false;

  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.length === 0) continue;
    if (line.startsWith(':')) continue; // comment / heartbeat
    if (line.startsWith('event:')) {
      event = line.slice(6).replace(/^ /, '').trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
      hasData = true;
    }
    // Other field names (id:, retry:) are ignored for this app's needs.
  }

  if (!hasData) return null;
  return { event: event.length > 0 ? event : 'message', data: dataLines.join('\n') };
}

/**
 * Extract all complete SSE frames from `buffer`. Returns the parsed frames and
 * the leftover `rest` (text after the last blank-line boundary, possibly an
 * incomplete frame). Pure: same input always yields the same output.
 */
export function parseSseFrames(buffer: string): SseParseResult {
  const frames: SseFrame[] = [];
  let rest = buffer;
  let boundary: number;

  // A blank line terminates a frame; tolerate CRLF by also matching `\r\n\r\n`.
  while ((boundary = findFrameBoundary(rest)) >= 0) {
    const block = rest.slice(0, boundary);
    rest = rest.slice(boundaryEnd(rest, boundary));
    const frame = parseBlock(block);
    if (frame) frames.push(frame);
  }

  return { frames, rest };
}

/** Index of the first frame boundary (blank line), or -1 if none yet. */
function findFrameBoundary(s: string): number {
  const lf = s.indexOf('\n\n');
  const crlf = s.indexOf('\r\n\r\n');
  if (lf < 0) return crlf;
  if (crlf < 0) return lf;
  return Math.min(lf, crlf);
}

/** Length of the boundary delimiter at `idx` (2 for `\n\n`, 4 for `\r\n\r\n`). */
function boundaryEnd(s: string, idx: number): number {
  return s.startsWith('\r\n\r\n', idx) ? idx + 4 : idx + 2;
}
