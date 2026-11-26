/** The main play screen: your stash of declaration forms, the dock, and every call flow. */
import { useEffect, useRef, useState } from 'preact/hooks';
import { clockFor, isCleared, isLive, remainingMs, TIMER_MS, type Card } from '../shared/rules';
import { gloatFor, grimeFor, nervesFor, recordProgress } from './flavor';
import { fx } from './fx';
import type { Session, SessionState } from './session';
import { sfx } from './sfx';
import { load, save } from './storage';
import { Badges, buzz, Icon, Sheet, useClock } from './ui';

/** How long the rubber stamp sits on a card before the card leaves. */
const STAMP_MS = 780;

function CardView(props: { card: Card; index: number; clock: number; paused: boolean; offline: boolean; session: Session; onCaught: (card: Card) => void; catchCount?: number }) {
  const { card, clock, session } = props;
  /** The catchphrase card: it never leaves, it just counts. */
  const isCatchphrase = props.catchCount !== undefined;
  const [stamp, setStamp] = useState<'cleared' | 'seized' | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const overlay = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // Slam the rubber stamp, let it land, then commit the action.
  const stampThen = (kind: 'cleared' | 'seized', commit: () => void) => {
    if (stamp) return;
    setStamp(kind);
    timers.current.push(
      setTimeout(() => {
        sfx.thud();
        buzz(40);
        fx.shake(kind === 'seized');
        fx.dustAt(overlay.current);
      }, 170),
      setTimeout(() => {
        commit();
        // A catchphrase stays in place, so clear the stamp for the next go.
        if (isCatchphrase) setStamp(null);
      }, STAMP_MS),
    );
  };

  const live = isLive(card, clock);
  const done = isCleared(card, clock);
  const left = remainingMs(card, clock);
  const secs = Math.ceil(left / 1000);
  const burning = live && !props.paused;

  // The fuse spits sparks as it burns down.
  useEffect(() => {
    if (burning) fx.sparksAt(bar.current, left / TIMER_MS, secs <= 5 ? 3 : 1);
  }, [burning, left]);

  const style = { ...grimeFor(card.id), animationDelay: `${Math.min(props.index, 6) * 70}ms` };
  const state = stamp ? (isCatchphrase ? 'stamped' : `leaving-${stamp}`) : live ? 'live' : done ? 'done' : '';

  return (
    <div class={`paper card ${isCatchphrase ? 'catchphrase' : ''} ${state}`} style={style}>
      <div class="paper-head">
        <span>
          {isCatchphrase ? (
            <>Your catchphrase · <b class="tally" key={props.catchCount}>×{props.catchCount}</b></>
          ) : (
            <>
              Item {String(props.index + 1).padStart(2, '0')}
              {card.heat ? <span class="heat" role="img" aria-label={['', 'Easy', 'Medium', 'Hard'][card.heat]}> {'🌶️'.repeat(card.heat)}</span> : null}
            </>
          )}
        </span>
        <span>{done ? (isCatchphrase ? 'Got away with it' : 'Cleared: shout “Smuggled!”') : live ? (props.paused ? 'Clock stopped' : 'Under inspection') : isCatchphrase ? 'Say it as often as you dare' : 'Goods to declare'}</span>
      </div>
      <div class="body">
        <div class={`phrase ${card.text.length > 34 ? 'long' : ''}`}>{card.text}</div>
        {live && <div class="hint">{props.paused ? 'Hold very still.' : nervesFor(card.id)}</div>}
        {done && <div class="hint">{isCatchphrase ? 'Nobody noticed. Count it and go again.' : `${gloatFor(card.id)} Show it, then stamp it.`}</div>}
      </div>
      {!live && !done && (
        <button
          class="act"
          onClick={() => {
            sfx.flick();
            buzz(15);
            session.declare(card.id);
          }}
          aria-label={`I said: ${card.text}`}
        >
          I said it
        </button>
      )}
      {live && (
        <div class={`clock ${secs <= 5 && burning ? 'tense' : ''}`} role="timer" aria-label={`${secs} seconds left`}>
          <span>
            {secs}
            <small>SECONDS</small>
          </span>
        </div>
      )}
      {done && (
        <button class="act" onClick={() => stampThen('cleared', () => session.smuggle(card.id))}>
          {isCatchphrase ? 'Count it' : 'Stamp it'}
        </button>
      )}
      {live && (
        <div class="bar" ref={bar} aria-hidden="true">
          <i style={{ transform: `scaleX(${left / TIMER_MS})` }} />
          {burning && <b style={{ left: `${(left / TIMER_MS) * 100}%` }} />}
        </div>
      )}
      {(live || done) && !props.paused && !stamp && (
        <div class="extras">
          {live && <button onClick={() => session.undeclare(card.id)}>Undo: I didn’t say it</button>}
          {/* Offline it is seized on the spot; in a synced room you first say who caught you. */}
          <button class="danger" onClick={() => (props.offline ? stampThen('seized', () => session.caught(card.id)) : props.onCaught(card))}>
            {live ? 'I got caught' : 'I was caught in time'}
          </button>
        </div>
      )}
      {stamp && (
        <div class="overlay" ref={overlay}>
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
  /** Synced: the phrase you are admitting was caught, while you pick who caught it. */
  const [owningUp, setOwningUp] = useState<Card | null>(null);
  const [splash, setSplash] = useState<string | null>(null);

  /** Everything that can be on the clock: the catchphrase and the hand. */
  const inPlay = you.catchphrase ? [you.catchphrase, ...you.hand] : you.hand;
  const anyDeclared = inPlay.some((c) => c.saidAt !== null);
  const now = useClock(session, anyDeclared);
  const clock = clockFor(state, you.id, now);
  const accusation = state.accusation;
  const accused = accusation?.accusedId === you.id;
  const nameOf = (id: string) => state.players.find((p) => p.id === id)?.name ?? 'Someone';
  const isHost = state.hostId === you.id;

  useEffect(() => {
    fx.mood('job');
    return () => fx.mood('den');
  }, []);

  const toggleCover = (value: boolean) => {
    setCovered(value);
    save('cover', value);
    if (value) {
      setTimeout(() => {
        sfx.clang();
        fx.shake();
        buzz(30);
      }, 240);
    }
  };

  /** Sirens, lights, the lot. */
  const raid = (subtitle: string) => {
    setSplash(subtitle);
    fx.alarm();
    fx.shake(true);
    sfx.siren();
    setTimeout(() => setSplash(null), 1500);
  };

  // Every phone in the room gets the raid when a call goes up.
  const callKey = accusation ? `${accusation.callerId}>${accusation.accusedId}@${accusation.at}` : '';
  const seenCall = useRef(callKey);
  useEffect(() => {
    if (callKey && callKey !== seenCall.current && accusation) {
      raid(accused ? `${nameOf(accusation.callerId)} is onto you!` : `${nameOf(accusation.callerId)} is searching ${nameOf(accusation.accusedId)}`);
      if (accused) buzz([120, 60, 120, 60, 240]);
    }
    seenCall.current = callKey;
  }, [callKey]);

  // Buzz once when each countdown completes (including ones that finished while locked).
  const notified = useRef(new Set<string>());
  useEffect(() => {
    for (const card of inPlay) {
      const key = `${card.id}@${card.saidAt}`;
      if (isCleared(card, clock) && !notified.current.has(key)) {
        notified.current.add(key);
        buzz([220, 90, 220, 90, 420]);
      }
    }
  });

  // Keep the screen awake while a countdown runs so the buzz is not missed.
  const anyLive = inPlay.some((c) => isLive(c, clock));
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

  // Lifetime rap sheet: count what happens while this screen is open.
  const tally = useRef({ smuggled: you.smuggled.length, seized: you.seized });
  useEffect(() => {
    const smuggled = you.smuggled.length - tally.current.smuggled;
    const seized = you.seized - tally.current.seized;
    if (smuggled > 0 || seized > 0) recordProgress(state.mode, { smuggled: Math.max(0, smuggled), seized: Math.max(0, seized) });
    tally.current = { smuggled: you.smuggled.length, seized: you.seized };
  }, [you.smuggled.length, you.seized]);

  const liveCards = inPlay.filter((c) => isLive(c, clock));
  const doneCount = inPlay.filter((c) => isCleared(c, clock)).length;
  const soonest = liveCards.length ? Math.min(...liveCards.map((c) => remainingMs(c, clock))) : 0;
  const canCall = you.badges > 0 && !accusation;

  return (
    <div class="game">
      <div class="hud">
        <button class="row" style="gap:8px;min-height:48px" onClick={props.onScores} aria-label="Open scoreboard">
          <span class="count pop" key={you.hand.length}>{you.hand.length}</span>
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
          {!covered && you.catchphrase && (
            <CardView key={you.catchphrase.id} card={you.catchphrase} index={0} clock={clock} paused={accused} offline={offline} session={session} onCaught={setOwningUp} catchCount={you.catchCount} />
          )}
          {!covered && you.hand.map((card, i) => (
            <CardView key={card.id} card={card} index={i} clock={clock} paused={accused} offline={offline} session={session} onCaught={setOwningUp} />
          ))}
        </div>
        {covered && (
          <button class="cover" onClick={() => toggleCover(false)} aria-label="Phrases covered. Tap to reveal.">
            <span class="door l" />
            <span class="door r" />
            <span class="tape">NOTHING TO DECLARE · NOTHING TO DECLARE · NOTHING TO DECLARE</span>
            {doneCount > 0 ? (
              <span class="big go stencil">Cleared! Open up and stamp it</span>
            ) : liveCards.length > 0 ? (
              <span class="big" role="timer">{fmt(soonest)}</span>
            ) : (
              <span class="lock" aria-hidden="true">🔒</span>
            )}
            <span class="scrawl">{liveCards.length > 0 ? 'keep talking…' : 'tap to crack it open'}</span>
          </button>
        )}
      </div>

      <div class="dock">
        <button class="side" aria-pressed={covered} onClick={() => toggleCover(!covered)}>
          <Icon name={covered ? 'eye' : 'eyeOff'} />
          {covered ? 'Reveal' : 'Cover'}
        </button>
        <button class="btn red" disabled={!canCall} onClick={() => { sfx.flick(); setCalling(true); }}>
          {you.badges > 0 ? 'Contraband!' : 'No badges'}
        </button>
        <button class="side" onClick={props.onScores}>
          <Icon name="list" />
          Scores
        </button>
      </div>

      {splash !== null && (
        <div class="splash" aria-hidden="true">
          <span>
            Contraband!
            <small>{splash}</small>
          </span>
        </div>
      )}

      {calling && offline && (
        <Sheet title="You called Contraband!" onClose={() => setCalling(false)}>
          <p class="muted">You must have said the phrase you suspected, out loud, inside their 30 seconds. Did they admit it?</p>
          <button class="btn green" onClick={() => { session.caughtSomeone(); recordProgress('offline', { busts: 1 }); setCalling(false); raid('Busted. Nice nose.'); }}>Yes, I caught them</button>
          <button class="btn red" onClick={() => { session.wrongCall(); recordProgress('offline', { wrongCalls: 1 }); setCalling(false); sfx.buzzer(); fx.shake(true); buzz(120); }}>
            No, wrong call
          </button>
          <p class="muted" style="font-size:.88rem">A wrong call costs a badge and adds a phrase to your stash.</p>
          <button class="btn ghost" onClick={() => setCalling(false)}>Never mind</button>
        </Sheet>
      )}

      {owningUp && !offline && !accusation && inPlay.some((c) => c.id === owningUp.id) && (
        <Sheet title="Who caught you?" onClose={() => setOwningUp(null)}>
          <p>
            <em style="font-family:var(--typed);font-style:normal">“{owningUp.text}”</em>{' '}
            {owningUp.id === you.catchphrase?.id ? 'is your catchphrase, so you keep it, but this one does not count.' : 'will be seized and replaced with a new phrase.'} Whoever caught you earns a swap.
          </p>
          {state.players.filter((p) => p.id !== you.id).map((p) => (
            <button key={p.id} class="pick" onClick={() => { sfx.thud(); session.caught(owningUp.id, p.id); setOwningUp(null); }}>
              <span class="who">{p.name}</span>
              <span class="stamp" style="font-size:.7rem;border-width:3px;padding:2px 6px">Caught me</span>
            </button>
          ))}
          <button class="btn ghost" onClick={() => setOwningUp(null)}>Never mind</button>
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
          {(() => {
            // Phrases on the clock come first; ones not yet tapped can be caught too.
            // Only a phrase whose 30 seconds had already run out is safe.
            const counting = inPlay.filter((c) => isLive(c, accusation.at));
            const untapped = inPlay.filter((c) => c.saidAt === null);
            const pick = (c: Card) => (
              <button key={c.id} class="pick" onClick={() => { sfx.thud(); session.resolve(c.id); }}>
                <span style="flex:1">
                  {c.text}
                  {c.id === you.catchphrase?.id && <small style="display:block">your catchphrase: you keep it</small>}
                </span>
                <span class="stamp" style="font-size:.7rem;border-width:3px;padding:2px 6px">{c.id === you.catchphrase?.id ? 'Caught' : 'Seized'}</span>
              </button>
            );
            return (
              <>
                {(counting.length > 0 || untapped.length > 0) && <p class="label">Yes, I was caught. Tap the phrase:</p>}
                {counting.map(pick)}
                {counting.length > 0 && untapped.length > 0 && <p class="label">Said it but had not tapped it yet?</p>}
                {untapped.map(pick)}
              </>
            );
          })()}
          <button class="btn green" onClick={() => session.resolve(null)}>No: wrong call</button>
          <p class="muted" style="font-size:.88rem">Your countdown is paused while you answer. Be honest: a caught phrase is replaced with a new one (your catchphrase stays).</p>
        </Sheet>
      )}

      {!accused && you.swapCredits > 0 && !splash && (
        <Sheet title="Good catch! Swap a phrase?">
          <p class="muted">Trade one phrase you are stuck with for a fresh one, or keep your stash.</p>
          {you.hand.map((c) => (
            <button key={c.id} class="pick" disabled={c.saidAt !== null || state.pileCount === 0} onClick={() => { sfx.flick(); session.swap(c.id); }}>
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
