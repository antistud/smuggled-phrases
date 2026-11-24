/** Everything outside the hand itself: start, setup, lobby, scoreboard, win, how-to. */
import qrcode from 'qrcode-generator';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { manifestNumber, MAX_OFFLINE_PLAYERS } from '../shared/deal';
import { DEFAULT_PACK_IDS, getPack, PACKS } from '../shared/packs';
import { CODE_LENGTH, normalizeCode, randomCode } from '../shared/prng';
import { MAX_NAME_LENGTH } from '../shared/protocol';
import { randomAlias, rankFor, rapSheet, SAMPLE_PHRASES } from './flavor';
import { reducedMotion } from './fx';
import { isMuted, setMuted, sfx } from './sfx';
import { OfflineSession, SyncSession, type Session, type SessionState } from './session';
import { load, save } from './storage';
import { Badges, Icon, Sheet, TopBar } from './ui';

// ------------------------------------------------------------------- home

/** Types sample contraband onto the form, one phrase after another. */
function useTypewriter(lines: string[]): string {
  const [text, setText] = useState(lines[0]);
  useEffect(() => {
    if (reducedMotion()) return;
    let line = 0;
    let at = lines[0].length;
    let hold = 24;
    const id = setInterval(() => {
      if (hold > 0) return void hold--;
      at += 1;
      if (at > lines[line].length) {
        line = (line + 1) % lines.length;
        at = 0;
      }
      if (at === lines[line].length) hold = 26;
      setText(lines[line].slice(0, at));
    }, 65);
    return () => clearInterval(id);
  }, []);
  return text;
}

export function MuteButton() {
  const [muted, setState] = useState(isMuted());
  const toggle = () => {
    setMuted(!muted);
    setState(!muted);
    if (muted) sfx.flick();
  };
  return (
    <button class="iconbtn" onClick={toggle} aria-pressed={muted} aria-label={muted ? 'Sound off. Tap to turn on.' : 'Sound on. Tap to mute.'}>
      <Icon name={muted ? 'soundOff' : 'sound'} />
    </button>
  );
}

export function Home(props: { resume: SessionState | null; onResume: () => void; onCreate: () => void; onJoin: () => void; onHowTo: () => void }) {
  const typed = useTypewriter(SAMPLE_PHRASES);
  const sheet = rapSheet();
  return (
    <div class="screen home">
      <span class="lamp" aria-hidden="true" />
      <div class="corner">
        <MuteButton />
      </div>
      <div>
        <h1 class="wordmark">
          <span class="stencil w1">Smuggled</span>
          <span class="stencil w2">Phrases</span>
        </h1>
        <p class="tagline">Nothing to declare. Plenty to say.</p>
        <div class="hero" aria-hidden="true">
          <div class="paper slip">
            <div class="paper-head">
              <span>Form SP-30</span>
              <span>Goods to declare</span>
            </div>
            <div class="phrase">{typed}</div>
            <span class="stamp green">Cleared</span>
          </div>
          <div class="crate">
            <span>
              FRAGILE
              <small>definitely just bananas</small>
            </span>
          </div>
        </div>
      </div>
      <div class="stack">
        {sheet.smuggled + sheet.seized > 0 && (
          <p class="rapsheet">
            Rap sheet: <b>{rankFor(sheet.smuggled)}</b> · {sheet.smuggled} smuggled · {sheet.seized} seized · {sheet.getaways} clean {sheet.getaways === 1 ? 'getaway' : 'getaways'}
          </p>
        )}
        {props.resume && (
          <button class="btn amber" onClick={props.onResume}>
            Resume game {props.resume.code}
          </button>
        )}
        <button class="btn" onClick={props.onCreate}>Start a game</button>
        <button class="btn ghost" onClick={props.onJoin}>Join a game</button>
        <button class="link" onClick={props.onHowTo}>How to play</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ setup

function PackPicker(props: { value: string[]; onChange: (ids: string[]) => void }) {
  const toggle = (id: string) => {
    const next = props.value.includes(id) ? props.value.filter((p) => p !== id) : [...props.value, id];
    if (next.length) props.onChange(next);
  };
  return (
    <div class="stack" style="gap:8px">
      {PACKS.map((pack) => (
        <button key={pack.id} class="pack" aria-pressed={props.value.includes(pack.id)} onClick={() => toggle(pack.id)}>
          <span class="tick">{props.value.includes(pack.id) ? '✓' : ''}</span>
          <span>
            <strong>{pack.name}</strong> · {pack.phrases.length} phrases{pack.rating === 'adult' ? ' · 18+' : ''}
            <small>{pack.description}</small>
          </span>
        </button>
      ))}
    </div>
  );
}

export function Setup(props: { kind: 'create' | 'join'; code?: string; forceSync?: boolean; onBack: () => void; onSession: (s: Session) => void }) {
  const creating = props.kind === 'create';
  const [mode, setMode] = useState<'sync' | 'offline'>(props.forceSync || navigator.onLine ? 'sync' : 'offline');
  const [name, setName] = useState(() => load<string>('name') ?? '');
  const [packs, setPacks] = useState<string[]>(DEFAULT_PACK_IDS);
  const [code, setCode] = useState(() => (creating ? randomCode() : props.code ?? ''));
  const [number, setNumber] = useState<number | null>(null);

  const validCode = normalizeCode(code);
  const ready = mode === 'sync' ? name.trim().length > 0 && (creating || !!validCode) : !!validCode && number !== null;

  const go = () => {
    if (!ready) return;
    if (mode === 'sync') {
      save('name', name.trim());
      props.onSession(creating ? SyncSession.host(name.trim(), packs) : SyncSession.join(validCode, name.trim()));
    } else {
      props.onSession(OfflineSession.create(validCode, packs, number!));
    }
  };

  return (
    <div class="screen">
      <TopBar title={creating ? 'Start a game' : 'Join a game'} onBack={props.onBack} />
      <div class="stack" style="gap:16px">
        <div class="seg" role="group" aria-label="Game type">
          <button aria-pressed={mode === 'sync'} onClick={() => setMode('sync')}>Synced room</button>
          <button aria-pressed={mode === 'offline'} onClick={() => setMode('offline')}>Offline</button>
        </div>
        <p class="muted" style="font-size:.92rem">
          {mode === 'sync'
            ? 'Needs internet. Live scoreboard, and the app settles every “Contraband!” call.'
            : 'No signal needed. Everyone types the same code and scores on the honor system.'}
        </p>

        {!creating && (
          <label class="field">
            <span class="label">Game code</span>
            <input
              class="code"
              value={code}
              maxLength={CODE_LENGTH}
              autocapitalize="characters"
              autocomplete="off"
              autocorrect="off"
              spellcheck={false}
              inputMode="text"
              placeholder="····"
              onInput={(e) => setCode((e.target as HTMLInputElement).value.toUpperCase())}
            />
          </label>
        )}

        {creating && mode === 'offline' && (
          <div class="field">
            <span class="label">Game code: read it out to everyone</span>
            <div class="codebox">
              <span class="codechip">{code}</span>
              <button class="btn small ghost" onClick={() => setCode(randomCode())}>New</button>
            </div>
          </div>
        )}

        {mode === 'sync' && (
          <label class="field">
            <span class="label">Your alias</span>
            <span class="row">
            <input value={name} maxLength={MAX_NAME_LENGTH} placeholder="e.g. Sticky Pete" autocomplete="nickname" enterkeyhint="go"
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === 'Enter' && go()} />
            <button type="button" class="btn small ghost" style="min-height:56px" onClick={(e) => { e.preventDefault(); sfx.flick(); setName(randomAlias()); }} aria-label="Give me a random alias">🎲</button>
            </span>
          </label>
        )}

        {mode === 'offline' && (
          <div class="field">
            <span class="label">Your player number: no two players may share one</span>
            <div class="numgrid" role="group" aria-label="Player number">
              {Array.from({ length: MAX_OFFLINE_PLAYERS }, (_, i) => i + 1).map((n) => (
                <button key={n} aria-pressed={number === n} onClick={() => setNumber(n)}>{n}</button>
              ))}
            </div>
          </div>
        )}

        {(creating || mode === 'offline') && (
          <div class="field">
            <span class="label">{creating ? 'Phrase packs' : 'Phrase packs: must match the host’s'}</span>
            <PackPicker value={packs} onChange={setPacks} />
          </div>
        )}

        {mode === 'offline' && validCode && (
          <p class="note">
            Manifest check <strong>#{manifestNumber(validCode, packs)}</strong>. Everyone should see the same number before you play.
          </p>
        )}

        <button class="btn amber" disabled={!ready} onClick={go}>
          {mode === 'sync' ? (creating ? 'Open the room' : 'Join the room') : 'Deal my hand'}
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ lobby

function joinUrl(code: string): string {
  return `${location.origin}/?room=${code}`;
}

function QrCode(props: { text: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(props.text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }, [props.text]);
  return <div class="qr" role="img" aria-label="QR code to join this room" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function Lobby(props: { session: Session; state: SessionState; onLeave: () => void }) {
  const { session, state } = props;
  const isHost = state.hostId === state.you.id;
  const url = joinUrl(state.code);
  const share = () => {
    const data = { title: 'Smuggled Phrases', text: `Join my Smuggled Phrases room: ${state.code}`, url };
    if (navigator.share) navigator.share(data).catch(() => {});
    else navigator.clipboard?.writeText(url).catch(() => {});
  };
  return (
    <div class="screen">
      <TopBar title="The hideout" onBack={props.onLeave} />
      <div class="stack" style="gap:14px">
        <div class="codebox">
          <span class="codechip">{state.code}</span>
        </div>
        <QrCode text={url} />
        <button class="link" onClick={share}>Share invite link</button>
        <div class="paper">
          <div class="paper-head">
            <span>The crew</span>
            <span>{state.connection === 'online' ? `${state.players.length} aboard` : 'Connecting…'}</span>
          </div>
          <ul class="manifest">
            {state.players.map((p) => (
              <li key={p.id}>
                <span class={`dot ${p.connected ? '' : 'off'}`} />
                <span style="flex:1">{p.name}</span>
                {p.id === state.hostId && <span class="tag">Host</span>}
                {p.id === state.you.id && <span class="tag you">You</span>}
              </li>
            ))}
            {state.players.length === 0 && <li>Opening the room…</li>}
          </ul>
        </div>
        <p class="muted" style="font-size:.9rem;text-align:center">
          Packs: {state.packs.map((id) => getPack(id)?.name ?? id).join(' + ') || '…'}
        </p>
        {isHost ? (
          <button class="btn amber" disabled={state.players.length < 2 || state.connection !== 'online'} onClick={() => session.start()}>
            {state.players.length < 2 ? 'Waiting for the crew…' : 'Deal the contraband'}
          </button>
        ) : (
          <p class="note">Waiting for the host to deal the contraband…</p>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------- scoreboard

const GAME_RANKS = ['Tourist', 'Pickpocket', 'Mule', 'Runner', 'Fixer', 'Kingpin'];

export function Scoreboard(props: { session: Session; state: SessionState; onClose: () => void; onHowTo: () => void; onLeave: () => void }) {
  const { session, state } = props;
  const isHost = state.mode === 'sync' && state.hostId === state.you.id;
  const [confirmLeave, setConfirmLeave] = useState(false);
  return (
    <Sheet title={state.mode === 'sync' ? 'Most wanted' : 'Your record'} onClose={props.onClose}>
      <div class="paper">
        <div class="paper-head">
          <span>Game {state.code}</span>
          <span>{state.mode === 'sync' ? `${state.pileCount} in the crate` : `Player ${state.playerNumber} · check #${state.manifest}`}</span>
        </div>
        <table class="scores">
          <thead>
            <tr>
              <th>Smuggler</th>
              <th>Left</th>
              <th>Badges</th>
              <th>Cleared</th>
            </tr>
          </thead>
          <tbody>
            {[...state.players].sort((a, b) => a.cards - b.cards).map((p, i) => (
              <tr key={p.id} class={i === 0 && state.players.length > 1 ? 'lead' : ''}>
                <td>
                  <span class="name">
                    {state.mode === 'sync' && <span class={`dot ${p.connected ? '' : 'off'}`} title={p.connected ? 'Connected' : 'Away'} />}
                    <span>
                      {p.name}
                      <span class="rank">{GAME_RANKS[Math.min(p.smuggled, GAME_RANKS.length - 1)]}</span>
                    </span>
                    {p.id === state.you.id && state.mode === 'sync' && <span class="tag you">You</span>}
                    {isHost && p.id !== state.you.id && !p.connected && (
                      <button class="kick" onClick={() => session.kick(p.id)}>Remove</button>
                    )}
                  </span>
                </td>
                <td>{p.cards}</td>
                <td><Badges left={p.badges} /></td>
                <td>{p.smuggled}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {state.mode === 'offline' && (
        <p class="muted" style="font-size:.9rem">Offline games keep score on each phone. Ask around to see who is closest to an empty hand.</p>
      )}
      <div class="row">
        <button class="btn ghost" onClick={props.onHowTo}>How to play</button>
        <MuteButton />
      </div>
      {isHost && state.phase === 'playing' && (
        <button class="btn ghost" onClick={() => { session.again(); props.onClose(); }}>Re-deal a new game</button>
      )}
      {confirmLeave ? (
        <div class="row">
          <button class="btn red" onClick={props.onLeave}>Yes, leave</button>
          <button class="btn ghost" onClick={() => setConfirmLeave(false)}>Stay</button>
        </div>
      ) : (
        <button class="btn ghost" onClick={() => setConfirmLeave(true)}>{state.mode === 'sync' ? 'Leave room' : 'End game'}</button>
      )}
      <button class="btn" onClick={props.onClose}>Back to my hand</button>
    </Sheet>
  );
}

// -------------------------------------------------------------------- win

export function Win(props: { session: Session; state: SessionState; onLeave: () => void }) {
  const { session, state } = props;
  const winner = state.winner!;
  const mine = winner.id === state.you.id;
  const isHost = state.mode === 'sync' && state.hostId === state.you.id;
  return (
    <div class="screen win">
      <div style="margin-top:3vh">
        <span class="stamp green big thud">Clean getaway</span>
      </div>
      <p class="label">{mine ? 'You walked straight through customs' : 'Walked straight through customs'}</p>
      <div class="who">{mine && state.mode === 'offline' ? 'You win!' : winner.name}</div>
      {mine && state.mode === 'offline' && <p class="muted">Empty hand! Tell the table and show them the evidence.</p>}
      <p class="label" style="margin-top:6px">Contraband smuggled</p>
      <ol>
        {winner.phrases.map((p) => (
          <li key={p.id} class="paper">
            <span>{p.text}</span>
            <span class="stamp green">Cleared</span>
          </li>
        ))}
        {winner.phrases.length === 0 && <li class="paper">Nothing on record.</li>}
      </ol>
      <div class="spacer" />
      <div class="stack" style="width:100%">
        {isHost && <button class="btn amber" onClick={() => session.again()}>Deal again</button>}
        {state.mode === 'sync' && !isHost && <p class="note">The host can deal another round.</p>}
        <button class="btn ghost" onClick={props.onLeave}>{state.mode === 'sync' ? 'Leave room' : 'Back to start'}</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ how to play

export function HowTo(props: { onBack: () => void }) {
  return (
    <div class="screen">
      <TopBar title="How to play" onBack={props.onBack} />
      <p class="tagline" style="margin:0 0 14px">Talk normal. Smuggle nonsense. Don’t get searched.</p>
      <ol class="rules">
        <li class="paper">You start with <b>5 secret phrases</b>. Keep your phone to yourself.</li>
        <li class="paper">Work a phrase into the conversation <b>out loud</b>, then tap <b>I said it</b> on that card. A private 30-second countdown starts.</li>
        <li class="paper">If nobody calls it in 30 seconds, shout <b>“Smuggled!”</b>, show the card, and clear it from your hand.</li>
        <li class="paper">Think someone just smuggled? Shout <b>“Contraband!”</b> within the 30 seconds <b>and repeat the phrase</b>. Pointing at a person is not enough.</li>
        <li class="paper">Caught: the phrase is <b>seized</b> and replaced with a new one. The catcher may swap one of their own phrases.</li>
        <li class="paper">Wrong call: the caller <b>draws an extra phrase</b> and loses one of their <b>3 inspector badges</b>. No badges, no calling. Bluffing with odd sentences to drain badges is fair play.</li>
        <li class="paper">First player with an <b>empty hand</b> wins.</li>
        <li class="paper">Phrases must be spoken aloud. A close paraphrase of a long phrase counts.</li>
      </ol>
      <p class="muted" style="margin:14px 0;font-size:.9rem">
        Your timers keep running if the phone locks. In a synced room the app tracks the scoreboard and settles calls; offline, it is all on your honor.
      </p>
      <button class="btn" onClick={props.onBack}>Got it</button>
    </div>
  );
}
