/** The main play screen: your hand of declaration forms, the dock, and every call flow. */
import { useEffect, useRef, useState } from 'preact/hooks';
import { clockFor, isCleared, isLive, remainingMs, TIMER_MS, type Card } from '../shared/rules';
import type { Session, SessionState } from './session';
import { load, save } from './storage';
import { Badges, buzz, Icon, Sheet, useClock } from './ui';

const STAMP_MS = 650;

function CardView(props: { card: Card; index: number; clock: number; paused: boolean; offline: boolean; session: Session }) {
  const { card, clock, session } = props;
  const [stamp, setStamp] = useState<'cleared' | 'seized' | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  // Show the rubber stamp for a beat, then commit the action.
  const stampThen = (kind: 'cleared' | 'seized', commit: () => void) => {
    if (stamp) return;
    setStamp(kind);
    timer.current = setTimeout(commit, STAMP_MS);
  };

  const live = isLive(card, clock);
  const done = isCleared(card, clock);
  const left = remainingMs(card, clock);
  const itemNo = String(props.index + 1).padStart(2, '0');

  return (
    <div class={`paper card ${live ? 'live' : ''} ${done ? 'done' : ''}`}>
      <div class="paper-head">
        <span>Item {itemNo}</span>
        <span>{done ? 'Cleared: shout “Smuggled!”' : live ? (props.paused ? 'Clock stopped' : 'Under inspection') : 'Goods to declare'}</span>
      </div>
      <div class="body">
        <div class={`phrase ${card.text.length > 34 ? 'long' : ''}`}>{card.text}</div>
        {live && <div class="hint">Act natural…</div>}
        {done && <div class="hint">Show this card, then stamp it.</div>}
      </div>
      {!live && !done && (
        <button class="act" onClick={() => session.declare(card.id)} aria-label={`I said: ${card.text}`}>
          I said it
        </button>
      )}
      {live && (
        <div class="clock" role="timer" aria-label={`${Math.ceil(left / 1000)} seconds left`}>
          <span>
            {Math.ceil(left / 1000)}
            <small>SECONDS</small>
          </span>
        </div>
      )}
      {done && (
        <button class="act" onClick={() => stampThen('cleared', () => session.smuggle(card.id))}>
          Stamp it
        </button>
      )}
      {live && (
        <div class="bar" aria-hidden="true">
          <i style={{ transform: `scaleX(${left / TIMER_MS})` }} />
        </div>
      )}
      {(live || (done && props.offline)) && !props.paused && (
        <div class="extras">
          {live && <button onClick={() => session.undeclare(card.id)}>Undo: I didn’t say it</button>}
          {props.offline && (
            <button class="danger" onClick={() => stampThen('seized', () => session.caught(card.id))}>
              {live ? 'I got caught' : 'I was caught in time'}
            </button>
          )}
        </div>
      )}
      {stamp && (
        <div class="overlay">
          <span class={`stamp thud ${stamp === 'cleared' ? 'green' : ''}`}>{stamp}</span>
        </div>
      )}
    </div>
  );
}

function fmt(ms: number): string {
  return `0:${String(Math.ceil(ms / 1000)).padStart(2, '0')}`;
}

export function Hand(props: { session: Session; state: SessionState; onScores: () => void }) {
  const { session, state } = props;
  const you = state.you;
  const offline = state.mode === 'offline';
  const [covered, setCovered] = useState(() => load<boolean>('cover') ?? false);
  const [calling, setCalling] = useState(false);

  const anyDeclared = you.hand.some((c) => c.saidAt !== null);
  const now = useClock(session, anyDeclared);
  const clock = clockFor(state, you.id, now);
  const accusation = state.accusation;
  const accused = accusation?.accusedId === you.id;
  const nameOf = (id: string) => state.players.find((p) => p.id === id)?.name ?? 'Someone';
  const isHost = state.hostId === you.id;

  const toggleCover = (value: boolean) => {
    setCovered(value);
    save('cover', value);
  };

  // Buzz once when each countdown completes (including ones that finished while locked).
  const notified = useRef(new Set<string>());
  useEffect(() => {
    for (const card of you.hand) {
      const key = `${card.id}@${card.saidAt}`;
      if (isCleared(card, clock) && !notified.current.has(key)) {
        notified.current.add(key);
        buzz([220, 90, 220, 90, 420]);
      }
    }
  });

  // Keep the screen awake while a countdown runs so the buzz is not missed.
  const anyLive = you.hand.some((c) => isLive(c, clock));
  useEffect(() => {
    if (!anyLive) return;
    let lock: { release(): Promise<void> } | null = null;
    let cancelled = false;
    (navigator as any).wakeLock?.request('screen').then(
      (l: { release(): Promise<void> }) => (cancelled ? l.release() : (lock = l)),
      () => {},
    );
    return () => {
      cancelled = true;
      lock?.release().catch(() => {});
    };
  }, [anyLive]);

  useEffect(() => {
    if (accused) buzz([120, 60, 120]);
  }, [accused]);

  const liveCards = you.hand.filter((c) => isLive(c, clock));
  const doneCount = you.hand.filter((c) => isCleared(c, clock)).length;
  const soonest = liveCards.length ? Math.min(...liveCards.map((c) => remainingMs(c, clock))) : 0;
  const canCall = you.badges > 0 && !accusation;

  return (
    <div class="game">
      <div class="hud">
        <button class="row" style="gap:8px;min-height:48px" onClick={props.onScores} aria-label="Open scoreboard">
          <span class="count">{you.hand.length}</span>
          <span style="text-align:left">
            <span class="label" style="display:block">to smuggle</span>
            <span class="code">{state.code}</span>
          </span>
        </button>
        <div class="spacer" />
        {state.mode === 'sync' && state.connection !== 'online' && <span class="conn">Reconnecting</span>}
        <div style="text-align:right">
          <Badges left={you.badges} />
          <span class="label" style="display:block">{you.badges > 0 ? 'badges' : 'no calls left'}</span>
        </div>
      </div>

      {accusation && !accused && (
        <div class="banner" role="status">
          <span class="stencil">Contraband!</span>
          <span style="flex:1">
            {accusation.callerId === you.id ? `Waiting for ${nameOf(accusation.accusedId)} to answer…` : `${nameOf(accusation.callerId)} is searching ${nameOf(accusation.accusedId)}.`}
          </span>
          {isHost && (
            <button class="btn small dark" onClick={() => session.cancelAccusation()}>Void</button>
          )}
        </div>
      )}

      <div class="handwrap">
        <div class="hand" aria-hidden={covered}>
          {!covered && you.hand.map((card, i) => (
            <CardView key={card.id} card={card} index={i} clock={clock} paused={accused} offline={offline} session={session} />
          ))}
        </div>
        {covered && (
          <button class="cover" onClick={() => toggleCover(false)} aria-label="Phrases covered. Tap to reveal.">
            <span class="tape">NOTHING TO DECLARE · NOTHING TO DECLARE · NOTHING TO DECLARE</span>
            {doneCount > 0 ? (
              <span class="big go stencil">Cleared! Open to stamp it</span>
            ) : liveCards.length > 0 ? (
              <span class="big" role="timer">{fmt(soonest)}</span>
            ) : (
              <span class="stencil" style="font-size:1.6rem">Phrases covered</span>
            )}
            <span class="muted">Tap to reveal your hand</span>
          </button>
        )}
      </div>

      <div class="dock">
        <button class="side" aria-pressed={covered} onClick={() => toggleCover(!covered)}>
          <Icon name={covered ? 'eye' : 'eyeOff'} />
          {covered ? 'Reveal' : 'Cover'}
        </button>
        <button class="btn red" disabled={!canCall} onClick={() => setCalling(true)}>
          {you.badges > 0 ? 'Contraband!' : 'No badges'}
        </button>
        <button class="side" onClick={props.onScores}>
          <Icon name="list" />
          Scores
        </button>
      </div>

      {calling && offline && (
        <Sheet title="You called Contraband!" onClose={() => setCalling(false)}>
          <p class="muted">You must have said the phrase you suspected, out loud, inside their 30 seconds. Did they admit it?</p>
          <button class="btn green" onClick={() => { session.caughtSomeone(); setCalling(false); }}>Yes, I caught them</button>
          <button class="btn red" onClick={() => { session.wrongCall(); setCalling(false); buzz(80); }}>
            No, wrong call
          </button>
          <p class="muted" style="font-size:.88rem">A wrong call costs a badge and adds a phrase to your hand.</p>
          <button class="btn ghost" onClick={() => setCalling(false)}>Never mind</button>
        </Sheet>
      )}

      {calling && !offline && (
        <Sheet title="Who are you searching?" onClose={() => setCalling(false)}>
          <p class="muted">Say “Contraband!” and repeat the phrase out loud first. If you are wrong it costs a badge and an extra phrase.</p>
          {state.players.filter((p) => p.id !== you.id).map((p) => (
            <button key={p.id} class="pick" onClick={() => { session.accuse(p.id); setCalling(false); }}>
              <span class="who">{p.name}</span>
              <small>{p.cards} left{p.connected ? '' : ' · away'}</small>
            </button>
          ))}
          <button class="btn ghost" onClick={() => setCalling(false)}>Never mind</button>
        </Sheet>
      )}

      {accused && accusation && (
        <Sheet title="You are being searched!">
          <p>
            <strong>{nameOf(accusation.callerId)}</strong> called “Contraband!”. Did they repeat a phrase you smuggled in the last 30 seconds?
          </p>
          {you.hand.filter((c) => isLive(c, accusation.at)).map((c) => (
            <button key={c.id} class="pick" onClick={() => session.resolve(c.id)}>
              <span style="flex:1">{c.text}</span>
              <span class="stamp" style="font-size:.7rem;border-width:3px;padding:2px 6px">Seized</span>
            </button>
          ))}
          <button class="btn green" onClick={() => session.resolve(null)}>No: wrong call</button>
          <p class="muted" style="font-size:.88rem">Your countdown is paused while you answer. Be honest: a caught phrase is replaced with a new one.</p>
        </Sheet>
      )}

      {!accused && you.swapCredits > 0 && (
        <Sheet title="Good catch! Swap a phrase?">
          <p class="muted">Trade one phrase you are stuck with for a fresh one, or keep your hand.</p>
          {you.hand.map((c) => (
            <button key={c.id} class="pick" disabled={c.saidAt !== null || state.pileCount === 0} onClick={() => session.swap(c.id)}>
              <span style="flex:1">{c.text}</span>
              {c.saidAt !== null && <small>in play</small>}
            </button>
          ))}
          <button class="btn ghost" onClick={() => session.swap(null)}>Keep my hand</button>
        </Sheet>
      )}
    </div>
  );
}
