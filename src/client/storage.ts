/** localStorage with a seatbelt: private mode and full disks must never break the game. */
const PREFIX = 'smuggled.';

export function load<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function save(key: string, value: unknown): void {
  try {
    if (value === null || value === undefined) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage unavailable: keep playing in memory */
  }
}

/** A random id for this device. It is the player's only credential in a room. */
export function deviceId(): string {
  let id = load<string>('device');
  if (!id) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    save('device', id);
  }
  return id;
}
