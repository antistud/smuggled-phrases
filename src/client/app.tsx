import { useEffect, useRef, useState } from 'preact/hooks';
import { normalizeCode } from '../shared/prng';
import type { Announcement } from '../shared/protocol';
import { account, errorText } from './account';
import { recordProgress } from './flavor';
import { fx } from './fx';
import { Hand } from './hand';
import { AccountScreen, HowTo, Home, Lobby, RulesSheet, Scoreboard, Setup, Win } from './screens';
import { restoreSession, type Session } from './session';
import { load, save } from './storage';
import { sfx } from './sfx';
import { buzz, Toasts, useSession, type Toast } from './ui';

type Route = { name: 'home' } | { name: 'setup'; kind: 'create' | 'join'; code?: string; forceSync?: boolean } | { name: 'howto'; back: Route; inGame?: boolean } | { name: 'game' } | { name: 'account' };

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
      return { stamp: { text: 'Seized' }, body: a.by ? <>{a.by} caught {a.name}: <em>“{a.text}”</em></> : <>{a.name} got caught: <em>“{a.text}”</em></> };
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

export function App() {
  const [session, setSession] = useState<Session | null>(() => restoreSession());
  const [route, setRoute] = useState<Route>(() => {
    const code = invitedRoom();
    if (code && session?.state.code !== code) return { name: 'setup', kind: 'join', code, forceSync: true };
    return session ? { name: 'game' } : { name: 'home' };
  });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const fxLayer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (fxLayer.current) fx.start(fxLayer.current);
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
    if (!session) return;
    const offNews = session.onNews((a) => {
      toast(describe(a));
      if (a.kind === 'wrongCall') sfx.buzzer();
      if (a.kind === 'seized' || a.kind === 'smuggled') sfx.thud();
      if (a.kind === 'joined') sfx.flick();
    });
    const offError = session.onError((message) => toast({ body: message }));
    return () => {
      offNews();
      offError();
    };
  }, [session]);

  const adopt = (next: Session) => {
    if (session && session !== next) session.leave();
    setSession(next);
    setRoute({ name: 'game' });
  };
  const leave = () => {
    session?.leave();
    setSession(null);
    setRoute({ name: 'home' });
  };

  let screen;
  if (route.name === 'howto') {
    screen = <HowTo settings={route.inGame && session ? session.state.settings : undefined} onBack={() => setRoute(route.back)} />;
  } else if (route.name === 'account') {
    screen = <AccountScreen onBack={() => setRoute({ name: 'home' })} />;
  } else if (route.name === 'setup') {
    screen = <Setup kind={route.kind} code={route.code} forceSync={route.forceSync} onBack={() => setRoute({ name: 'home' })} onSession={adopt} />;
  } else if (route.name === 'game' && session) {
    screen = <Game session={session} onLeave={leave} onHome={() => setRoute({ name: 'home' })} onHowTo={() => setRoute({ name: 'howto', back: { name: 'game' }, inGame: true })} onOver={() => setToasts([])} />;
  } else {
    screen = (
      <Home
        resume={session && !session.state.fatal ? session.state : null}
        onResume={() => setRoute({ name: 'game' })}
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
        {screen}
        <Toasts items={toasts} />
      </div>
      <div class="fx" ref={fxLayer} aria-hidden="true" />
    </>
  );
}

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

  // Celebrate, and count the result, only when the game ends while we are watching
  // (not again every time a finished game is reopened).
  const lastPhase = useRef(state.phase);
  useEffect(() => {
    const ended = state.phase === 'over' && lastPhase.current === 'playing';
    lastPhase.current = state.phase;
    if (!ended) return;
    buzz([100, 60, 100, 60, 500]);
    fx.cash();
    sfx.fanfare();
    // The win screen says it all; don't bury it under announcements.
    props.onOver();
    recordProgress(state.mode, { games: 1, getaways: state.winner?.id === state.you.id ? 1 : 0 });
    if (state.mode === 'sync') setTimeout(() => void account.refresh(), 1500);
  }, [state.phase]);
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
  if (state.phase === 'over' && state.winner) return <Win session={session} state={state} onLeave={props.onLeave} />;
  if (state.phase === 'lobby') return <Lobby session={session} state={state} onLeave={props.onLeave} />;
  return (
    <>
      <Hand session={session} state={state} onScores={() => setScores(true)} />
      {rules && <RulesSheet settings={state.settings} onClose={closeRules} />}
      {scores && <Scoreboard session={session} state={state} onClose={() => setScores(false)} onHowTo={props.onHowTo} onLeave={props.onLeave} />}
    </>
  );
}
