import { useEffect, useRef, useState } from 'preact/hooks';
import { normalizeCode } from '../shared/prng';
import type { Announcement, RoomPhase } from '../shared/protocol';
import { account, errorText } from './account';
import { recordProgress } from './flavor';
import { fx } from './fx';
import { Hand } from './hand';
import { AccountScreen, HowTo, Home, Lobby, RulesSheet, Scoreboard, Setup, useAccount, Win } from './screens';
import { rememberCurrent, restoreSessions, SyncSession, type Session, type SessionState } from './session';
import { load, save } from './storage';
import { sfx } from './sfx';
import { buzz, Toasts, useSession, type Toast } from './ui';

type Route = { name: 'home' } | { name: 'setup'; kind: 'create' | 'join'; code?: string; forceSync?: boolean } | { name: 'howto'; back: Route } | { name: 'game' } | { name: 'account' };

/** ?room=CODE from an invite link or QR code. */
function invitedRoom(): string {
  const code = normalizeCode(new URLSearchParams(location.search).get('room') ?? '');
  if (code) history.replaceState(null, '', location.pathname);
  return code;
}

function describe(a: Announcement): Omit<Toast, 'id'> {
  switch (a.kind) {
    case 'smuggled':
      return { stamp: { text: 'Cleared', green: true }, body: <>{a.name} smuggled <em>“{a.text}”</em></> };
    case 'seized':
      return { stamp: { text: 'Seized' }, body: <>{a.by ?? 'Someone'} caught {a.name}: <em>“{a.text}”</em></> };
    case 'catchphrase':
      return { stamp: { text: `×${a.count}`, green: true }, body: <>{a.name} got their catchphrase through again: <em>“{a.text}”</em></> };
    case 'catchphraseCaught':
      return { stamp: { text: 'Caught' }, body: <>{a.by ?? 'Someone'} caught {a.name}’s catchphrase: <em>“{a.text}”</em></> };
    case 'wrongCall':
      return { body: <>Wrong call! {a.name} loses a badge ({a.badgesLeft} left) and draws a phrase.</> };
    case 'cancelled':
      return { body: <>The host voided that call.</> };
    case 'joined':
      return { body: <>{a.name} joined the room.</> };
    case 'renamed':
      return { body: <>{a.from} now goes by {a.name}.</> };
    case 'left':
      return { body: <>{a.name} left the room.</> };
  }
}

/** Something in a game you are not looking at that you would want to know about. */
interface GameAlert {
  id: string;
  code: string;
  text: string;
  urgent: boolean;
  /** Changes when the alert is about a new event, so it can be announced once. */
  key: string;
}

function alertFor(session: Session, lastSeenPhase: RoomPhase | undefined): GameAlert | null {
  const st: SessionState = session.state;
  const base = { id: session.id, code: st.code };
  if (st.fatal) return { ...base, text: st.fatal, urgent: false, key: 'fatal' };
  const call = st.accusation;
  if (call && call.accusedId === st.you.id) {
    const caller = st.players.find((p) => p.id === call.callerId)?.name ?? 'Someone';
    return { ...base, text: `${caller} is searching you!`, urgent: true, key: `call@${call.at}` };
  }
  if (lastSeenPhase && lastSeenPhase !== st.phase) {
    const text = st.phase === 'playing' ? 'The game has started.' : st.phase === 'over' ? `${st.winner?.name ?? 'Someone'} got away clean. Game over.` : 'Back in the hideout.';
    return { ...base, text, urgent: false, key: st.phase };
  }
  return null;
}

/** Re-render whenever any of the games changes. */
function useSessions(sessions: Session[]): void {
  const [, tick] = useState(0);
  useEffect(() => {
    const offs = sessions.map((s) => s.subscribe(() => tick((n) => n + 1)));
    return () => offs.forEach((off) => off());
  }, [sessions]);
}

function sameGame(a: SessionState, b: SessionState): boolean {
  if (a.mode !== b.mode || a.code !== b.code) return false;
  return a.mode === 'sync' || (a.playerNumber === b.playerNumber && a.manifest === b.manifest);
}

export function App() {
  const [boot] = useState(() => {
    const restored = restoreSessions();
    // Games that were already over when the app opened have had their fanfare and been counted.
    for (const s of restored.sessions) if (s.state.phase === 'over') celebrated.add(s);
    const code = invitedRoom();
    const invited = code ? restored.sessions.find((s) => s.state.mode === 'sync' && s.state.code === code) : undefined;
    const currentId = invited?.id ?? restored.currentId;
    const route: Route = code && !invited ? { name: 'setup', kind: 'join', code, forceSync: true } : currentId ? { name: 'game' } : { name: 'home' };
    return { sessions: restored.sessions, currentId, route };
  });
  const [sessions, setSessions] = useState<Session[]>(boot.sessions);
  const [currentId, setCurrentId] = useState<string | null>(boot.currentId);
  const [route, setRoute] = useState<Route>(boot.route);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const fxLayer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (fxLayer.current) fx.start(fxLayer.current);
  }, []);
  useSessions(sessions);
  const me = useAccount();

  const session = sessions.find((s) => s.id === currentId) ?? null;
  /** The game on screen right now, if any. Every other game is "in the background". */
  const visibleId = route.name === 'game' && session && me ? session.id : null;

  // The phase each game was in when you last looked at it.
  const seen = useRef<Map<string, RoomPhase> | null>(null);
  if (!seen.current) seen.current = new Map(boot.sessions.map((s) => [s.id, s.state.phase]));
  if (session && visibleId) seen.current.set(session.id, session.state.phase);

  const alerts = sessions
    .filter((s) => s.id !== visibleId)
    .map((s) => alertFor(s, seen.current!.get(s.id)))
    .filter((a): a is GameAlert => a !== null);

  // Synced rooms the account is seated in that this phone is not connected to.
  const here = new Set(sessions.filter((s) => s.state.mode === 'sync' && !s.state.fatal).map((s) => s.state.code));
  const elsewhere = me ? account.rooms.map((r) => r.code).filter((code) => !here.has(code)) : [];
  // Coming back to the app is when a game from another device is most likely to be wanted.
  useEffect(() => {
    const wake = () => document.visibilityState === 'visible' && void account.refresh();
    document.addEventListener('visibilitychange', wake);
    return () => document.removeEventListener('visibilitychange', wake);
  }, []);

  const toast = (t: Omit<Toast, 'id'>) => {
    const id = nextId.current++;
    setToasts((list) => [...list.slice(-2), { ...t, id }]);
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), 4200);
  };

  // Arriving from the emailed sign-in link: /?login=<token>.
  useEffect(() => {
    const token = new URLSearchParams(location.search).get('login');
    if (token) {
      history.replaceState(null, '', location.pathname);
      void account.verify({ token }).then((result) => {
        if (result.ok) {
          sfx.thud();
          toast({ stamp: { text: 'Cleared', green: true }, body: <>Signed in as {account.current?.email}.</> });
        } else {
          toast({ stamp: { text: 'Denied' }, body: <>{errorText(result.error)}</> });
        }
      });
    } else {
      void account.refresh();
    }
  }, []);

  useEffect(() => {
    const offs = sessions.flatMap((s) => {
      const visible = s.id === visibleId;
      return [
        s.onNews((a) => {
          const t = describe(a);
          if (!visible) {
            // Quietly, and say which room it came from.
            toast({ ...t, body: <><b>{s.state.code}</b> · {t.body}</> });
            return;
          }
          toast(t);
          if (a.kind === 'wrongCall') sfx.buzzer();
          if (a.kind === 'seized' || a.kind === 'smuggled' || a.kind === 'catchphrase' || a.kind === 'catchphraseCaught') sfx.thud();
          if (a.kind === 'joined') sfx.flick();
        }),
        s.onError((message) => {
          if (visible) toast({ body: message });
        }),
      ];
    });
    return () => offs.forEach((off) => off());
  }, [sessions, visibleId]);

  // Being searched in a game you are not looking at gets the siren.
  const urgentKey = alerts.filter((a) => a.urgent).map((a) => `${a.id}:${a.key}`).join(',');
  useEffect(() => {
    if (!urgentKey) return;
    sfx.siren();
    buzz([120, 60, 120, 60, 240]);
  }, [urgentKey]);

  const open = (id: string) => {
    setCurrentId(id);
    rememberCurrent(id);
    setToasts([]);
    setRoute({ name: 'game' });
  };
  const adopt = (next: Session) => {
    if (next.state.mode === 'sync') account.rememberRoom(next.state.code);
    const twin = sessions.find((s) => s !== next && !s.state.fatal && sameGame(s.state, next.state));
    if (twin) {
      // Already in that game on this phone: a second seat would only fight the first.
      if (next.state.mode === 'sync') next.dispose();
      else next.leave();
      open(twin.id);
      toast({ body: <>You are already in {twin.state.code}. Here it is.</> });
      return;
    }
    // A dead entry for the same room is replaced by the fresh one.
    const stale = sessions.filter((s) => s.state.fatal && s.state.mode === next.state.mode && s.state.code === next.state.code);
    stale.forEach((s) => s.leave());
    setSessions((list) => [...list.filter((s) => !stale.includes(s)), next]);
    open(next.id);
  };
  const leave = () => {
    if (!session) return;
    if (session.state.mode === 'sync') account.forgetRoom(session.state.code);
    session.leave();
    seen.current!.delete(session.id);
    const rest = sessions.filter((s) => s !== session);
    setSessions(rest);
    setCurrentId(null);
    rememberCurrent(rest[0]?.id ?? null);
    setRoute({ name: 'home' });
  };
  const home = () => setRoute({ name: 'home' });

  let screen;
  if (route.name === 'howto') {
    screen = <HowTo onBack={() => setRoute(route.back)} />;
  } else if (!me) {
    // Nobody plays without signing in. The route is kept, so an invite link carries on afterwards.
    screen = <AccountScreen onHowTo={() => setRoute({ name: 'howto', back: route })} />;
  } else if (route.name === 'account') {
    screen = <AccountScreen onBack={() => setRoute({ name: 'home' })} />;
  } else if (route.name === 'setup') {
    screen = <Setup kind={route.kind} code={route.code} forceSync={route.forceSync} onBack={home} onSession={adopt} />;
  } else if (route.name === 'game' && session) {
    screen = <Game key={session.id} session={session} onLeave={leave} onHome={home} onHowTo={() => setRoute({ name: 'howto', back: { name: 'game' } })} onOver={() => setToasts([])} />;
  } else {
    screen = (
      <Home
        games={sessions.map((s) => ({ id: s.id, state: s.state, flagged: alerts.some((a) => a.id === s.id) }))}
        onOpen={open}
        elsewhere={elsewhere}
        onBring={(code) => adopt(SyncSession.join(code, me?.name || load<string>('name') || 'Smuggler'))}
        onCreate={() => setRoute({ name: 'setup', kind: 'create' })}
        onJoin={() => setRoute({ name: 'setup', kind: 'join' })}
        onHowTo={() => setRoute({ name: 'howto', back: { name: 'home' } })}
        onAccount={() => setRoute({ name: 'account' })}
      />
    );
  }

  return (
    <>
      <div class="world">
        {alerts.length > 0 && (
          <div class="alerts" role="status">
            {alerts.map((a) => (
              <button key={a.id} class={`alert ${a.urgent ? 'urgent' : ''}`} onClick={() => open(a.id)}>
                <span class="stencil">{a.code}</span>
                <span>{a.text}</span>
                <span class="go">Open</span>
              </button>
            ))}
          </div>
        )}
        {/* The alert bar already clears the notch, so the screen below must not pad for it again. */}
        <div class="stage" style={alerts.length > 0 ? '--safe-t:0px' : undefined}>
          {screen}
        </div>
        <Toasts items={toasts} />
      </div>
      <div class="fx" ref={fxLayer} aria-hidden="true" />
    </>
  );
}

/** Games whose win has already had its fanfare, so switching back does not replay it. */
const celebrated = new WeakSet<Session>();

function Game(props: { session: Session; onLeave: () => void; onHome: () => void; onHowTo: () => void; onOver: () => void }) {
  const { session } = props;
  const state = useSession(session);
  const [scores, setScores] = useState(false);

  // First game on this phone: put the rules in front of the player as the hand is dealt.
  const [rules, setRules] = useState(false);
  useEffect(() => {
    if (state.phase === 'playing' && !load<boolean>('rulesSeen')) setRules(true);
  }, [state.phase]);
  const closeRules = () => {
    save('rulesSeen', true);
    setRules(false);
  };

  // Celebrate, and count the result, once per game: not again when you switch back to it.
  const won = state.phase === 'over';
  useEffect(() => {
    if (!won) {
      celebrated.delete(session);
      return;
    }
    // The win screen says it all; don't bury it under announcements.
    props.onOver();
    if (celebrated.has(session)) return;
    celebrated.add(session);
    buzz([100, 60, 100, 60, 500]);
    fx.cash();
    sfx.fanfare();
    recordProgress(state.mode, { games: 1, getaways: state.winner?.id === state.you.id ? 1 : 0 });
    if (state.mode === 'sync') setTimeout(() => void account.refresh(), 1500);
  }, [won]);
  useEffect(() => {
    if (state.phase !== 'playing') setScores(false);
  }, [state.phase]);

  if (state.fatal) {
    return (
      <div class="screen" style="justify-content:center;gap:16px;text-align:center">
        <span class="stamp big thud" style="align-self:center">Denied</span>
        <p>{state.fatal}</p>
        <button class="btn" onClick={props.onLeave}>Back to start</button>
      </div>
    );
  }
  if (state.phase === 'over' && state.winner) return <Win session={session} state={state} onLeave={props.onLeave} onHome={props.onHome} />;
  if (state.phase === 'lobby') return <Lobby session={session} state={state} onLeave={props.onLeave} onHome={props.onHome} />;
  return (
    <>
      <Hand session={session} state={state} onScores={() => setScores(true)} />
      {rules && <RulesSheet onClose={closeRules} />}
      {scores && <Scoreboard session={session} state={state} onClose={() => setScores(false)} onHowTo={props.onHowTo} onLeave={props.onLeave} onHome={props.onHome} />}
    </>
  );
}
