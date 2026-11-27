import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { STARTING_BADGES } from '../shared/rules';
import type { Session, SessionState } from './session';

export function useSession(session: Session): SessionState {
  const [state, setState] = useState(session.state);
  useEffect(() => {
    setState(session.state);
    return session.subscribe(() => setState(session.state));
  }, [session]);
  return state;
}

/** Re-renders a few times a second while `active`, returning the session clock. */
export function useClock(session: Session, active: boolean): number {
  const [now, setNow] = useState(() => session.now());
  useEffect(() => {
    setNow(session.now());
    if (!active) return;
    const id = setInterval(() => setNow(session.now()), 200);
    const wake = () => setNow(session.now());
    document.addEventListener('visibilitychange', wake);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [session, active]);
  return now;
}

export function buzz(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* not supported (iOS Safari) */
  }
}

export function Sheet(props: { title: string; onClose?: () => void; children: ComponentChildren }) {
  return (
    <div class="scrim" role="dialog" aria-modal="true" aria-label={props.title} onClick={(e) => e.target === e.currentTarget && props.onClose?.()}>
      <div class="sheet">
        <div class="grab" />
        <h3>{props.title}</h3>
        {props.children}
      </div>
    </div>
  );
}

export function TopBar(props: { title: string; onBack?: () => void }) {
  return (
    <div class="topbar">
      {props.onBack && (
        <button class="iconbtn" onClick={props.onBack} aria-label="Back">
          <Icon name="back" />
        </button>
      )}
      <h2>{props.title}</h2>
    </div>
  );
}

export function Badges(props: { left: number }) {
  return (
    <span class="badges" role="img" aria-label={`${props.left} of ${STARTING_BADGES} inspector badges left`}>
      {Array.from({ length: STARTING_BADGES }, (_, i) => (
        <svg key={i} class={`badge ${i < props.left ? '' : 'spent'}`} viewBox="0 0 24 28" aria-hidden="true">
          <path d="M12 1.5 21.5 5v8.5c0 6-4 10.500-9.500 13C6.500 24 2.500 19.500 2.500 13.500V5Z" stroke-linejoin="round" />
        </svg>
      ))}
    </span>
  );
}

const ICONS: Record<string, string> = {
  back: 'M15 5l-7 7 7 7',
  share: 'M12 15V4m0 0l-4 4m4-4l4 4M5 12v7h14v-7',
  eye: 'M2 12s3.600-7 10-7 10 7 10 7-3.600 7-10 7S2 12 2 12Zm10 3.200a3.200 3.200 0 1 0 0-6.400 3.200 3.200 0 0 0 0 6.400Z',
  eyeOff: 'M3 3l18 18M10.600 5.100A10.700 10.700 0 0 1 12 5c6.400 0 10 7 10 7a17 17 0 0 1-3.300 4.200M6.500 6.600A16.600 16.600 0 0 0 2 12s3.600 7 10 7c1.600 0 3-.400 4.300-1',
  list: 'M4 6h16M4 12h16M4 18h16',
  sound: 'M4 9.500v5h3.500L12 19V5L7.500 9.500H4ZM15.500 8.500a5 5 0 0 1 0 7M18 6a8.500 8.500 0 0 1 0 12',
  soundOff: 'M4 9.500v5h3.500L12 19V5L7.500 9.500H4ZM16 9.500l5 5M21 9.500l-5 5',
  help: 'M9.200 9a3 3 0 1 1 4.300 2.700c-.900.500-1.500 1.200-1.500 2.300M12 17.500v.500M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z',
};

export function Icon(props: { name: keyof typeof ICONS }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.200" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={ICONS[props.name]} />
    </svg>
  );
}

export interface Toast {
  id: number;
  stamp?: { text: string; green?: boolean };
  body: ComponentChildren;
}

export function Toasts(props: { items: Toast[] }) {
  return (
    <div class="toasts" aria-live="polite">
      {props.items.map((t) => (
        <div class="toast" key={t.id}>
          {t.stamp && <span class={`stamp ${t.stamp.green ? 'green' : ''}`}>{t.stamp.text}</span>}
          <span>{t.body}</span>
        </div>
      ))}
    </div>
  );
}
