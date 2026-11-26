import { MAX_NAME_LENGTH } from './protocol';

/** Tidies a display name: single spaces, trimmed, length-limited, never empty. */
export function cleanName(raw: string): string {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  return name || 'Smuggler';
}
