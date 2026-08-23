import split2 from 'split2';
import { Readable } from 'node:stream';

/**
 * Attaches a line-by-line stream splitter to a readable stream
 * ensuring no JSON events are broken across chunk boundaries.
 */
export function createLineBuffer(stream: Readable, onLine: (line: string) => void) {
  const lineStream = stream.pipe(split2());
  lineStream.on('data', (chunk: Buffer | string) => {
    const line = chunk.toString().trim();
    if (line) {
      onLine(line);
    }
  });
  return lineStream;
}
