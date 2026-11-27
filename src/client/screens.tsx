/** Everything outside the hand itself: start, setup, lobby, scoreboard, win, how-to. */
import qrcode from 'qrcode-generator';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { manifestNumber, MAX_OFFLINE_PLAYERS } from '../shared/deal';
import { buildDeck, deckSize, DEFAULT_PACK_IDS, getPack, PACKS, packSize, TIERS } from '../shared/packs';
import { DEFAULT_SETTINGS, MAX_HAND_SIZE, MIN_HAND_SIZE, SPICE_LEVELS, spiceLevel, type GameSettings } from '../shared/settings';
import { CODE_LENGTH, normalizeCode, randomCode } from '../shared/prng';
import { MAX_NAME_LENGTH } from '../shared/protocol';
import { account, errorText } from './account';
import { currentRecord, randomAlias, rankFor, SAMPLE_PHRASES } from './flavor';
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

/** One line on where a game stands, for the list on the home screen. */
function gameStatus(state: SessionState): string {
  if (state.fatal) return 'Closed';
  if (state.phase === 'over') return state.mode === 'offline' ? 'Finished' : `${state.winner?.name ?? 'Someone'} won`;
  const left = `${state.you.hand.length} to smuggle`;
  if (state.mode === 'offline') return `Offline · Player ${state.playerNumber} · ${left}`;
  if (state.phase === 'lobby') return `In the hideout · ${state.players.length} aboard`;
  return `${left} · ${state.players.length} smugglers`;
}

/** Re-renders when the signed-in account changes. */
export function useAccount() {
  const [me, setMe] = useState(account.current);
  useEffect(() => account.subscribe(() => setMe(account.current)), []);
  return me;
}

export function Home(props: {
  games: { id: string; state: SessionState; flagged: boolean }[];
  onOpen: (id: string) => void;
  onCreate: () => void;
  onJoin: () => void;
  onHowTo: () => void;
  onAccount: () => void;
}) {
  const typed = useTypewriter(SAMPLE_PHRASES);
  const me = useAccount();
  useEffect(() => {
    void account.refresh();
  }, []);
  const sheet = currentRecord();
  const [copied, setCopied] = useState(false);
  /** Tell friends about the game itself: no room needed. */
  const share = () => {
    const url = `${location.origin}/`;
    const data = { title: 'Smuggled Phrases', text: 'Smuggled Phrases: a party game of sneaking silly phrases into conversation.', url };
    if (navigator.share) {
      navigator.share(data).catch(() => {});
      return;
    }
    navigator.clipboard
      ?.writeText(url)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2200);
      })
      .catch(() => {});
  };
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
        {props.games.length > 0 && <p class="label" style="text-align:left">{props.games.length === 1 ? 'Your game' : 'Your games'}</p>}
        {props.games.map((g) => (
          <button key={g.id} class="gamerow" onClick={() => props.onOpen(g.id)} aria-label={`Open game ${g.state.code}. ${gameStatus(g.state)}`}>
            <span class="stencil">{g.state.code}</span>
            <span>
              {g.state.mode === 'sync' ? g.state.you.name : 'Offline game'}
              <small>{gameStatus(g.state)}</small>
            </span>
            {g.flagged && <span class="flag" aria-hidden="true" />}
          </button>
        ))}
        <button class="btn" onClick={props.onCreate}>{props.games.length > 0 ? 'Start another game' : 'Start a game'}</button>
        <button class="btn ghost" onClick={props.onJoin}>{props.games.length > 0 ? 'Join another game' : 'Join a game'}</button>
        <div class="row" style="justify-content:center;gap:14px">
          <button class="link" style="white-space:nowrap" onClick={props.onHowTo}>How to play</button>
          <button class="btn small ghost" style="white-space:nowrap;flex:none" onClick={share}>
            <Icon name="share" /> {copied ? 'Link copied!' : 'Share with friends'}
          </button>
        </div>
        <div class="row" style="justify-content:center">
          <button class="link" onClick={props.onAccount}>{me ? `Signed in: ${me.name || me.email}` : 'Sign in to save progress'}</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- account

export function AccountScreen(props: { onBack: () => void }) {
  const me = useAccount();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [dev, setDev] = useState<{ link: string; code: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState(me?.name ?? '');
  useEffect(() => {
    void account.refresh();
  }, []);
  useEffect(() => setName(me?.name ?? ''), [me?.name]);

  const run = async (work: () => Promise<{ ok: true } | { ok: false; error: string }>, then?: () => void) => {
    setBusy(true);
    setError('');
    const result = await work();
    setBusy(false);
    if (result.ok) then?.();
    else setError(errorText(result.error));
  };
  const send = () =>
    run(async () => {
      const result = await account.requestLink(email.trim());
      if (result.ok) {
        setDev(result.dev ?? null);
        setSentTo(email.trim());
      }
      return result;
    });
  const check = () => run(() => account.verify({ email: sentTo!, code }), () => sfx.thud());

  if (me) {
    const s = me.stats;
    return (
      <div class="screen">
        <TopBar title="Your file" onBack={props.onBack} />
        <div class="stack" style="gap:16px">
          <div class="paper" style="padding-bottom:6px">
            <div class="paper-head">
              <span>Customs file</span>
              <span>{rankFor(s.smuggled)}</span>
            </div>
            <table class="scores record">
              <tbody>
                <tr><td>Phrases smuggled</td><td>{s.smuggled}</td></tr>
                <tr><td>Phrases seized</td><td>{s.seized}</td></tr>
                <tr><td>Smugglers caught</td><td>{s.busts}</td></tr>
                <tr><td>Wrong calls</td><td>{s.wrongCalls}</td></tr>
                <tr><td>Clean getaways</td><td>{s.getaways}</td></tr>
                <tr><td>Games finished</td><td>{s.games}</td></tr>
              </tbody>
            </table>
          </div>
          <label class="field">
            <span class="label">Your alias</span>
            <span class="row">
              <input value={name} maxLength={MAX_NAME_LENGTH} placeholder="e.g. Sticky Pete" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
              <button type="button" class="btn small" style="min-height:56px" disabled={!name.trim() || name.trim() === me.name} onClick={(e) => { e.preventDefault(); save('name', name.trim()); void account.setName(name.trim()); }}>Save</button>
            </span>
          </label>
          <p class="muted" style="font-size:.9rem">Signed in as {me.email}. Synced rooms are counted by the server; offline games are added from this phone.</p>
          <button class="btn ghost" onClick={() => void account.signOut()}>Sign out</button>
        </div>
      </div>
    );
  }

  return (
    <div class="screen">
      <TopBar title="Sign in" onBack={props.onBack} />
      <div class="stack" style="gap:16px">
        <p class="muted">No password. We email you a link and a 6-digit code, and your rap sheet follows you to any phone.</p>
        {!sentTo ? (
          <>
            <label class="field">
              <span class="label">Email</span>
              <input type="email" value={email} placeholder="you@example.com" autocomplete="email" inputMode="email" autocapitalize="none" enterkeyhint="send"
                onInput={(e) => setEmail((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && send()} />
            </label>
            <button class="btn amber" disabled={busy || !email.includes('@')} onClick={send}>{busy ? 'Sending…' : 'Email me a link'}</button>
          </>
        ) : (
          <>
            <p class="note">Sent to <strong>{sentTo}</strong>. Tap the link in the email, or type the code here. Installed the app? Use the code: the link opens in your browser.</p>
            {dev && (
              <p class="note bad">
                Development mode, no email was sent. Code <strong>{dev.code}</strong> · <a href={dev.link} style="color:inherit">open link</a>
              </p>
            )}
            <label class="field">
              <span class="label">6-digit code</span>
              <input class="code" value={code} maxLength={6} inputMode="numeric" autocomplete="one-time-code" placeholder="······"
                onInput={(e) => setCode((e.target as HTMLInputElement).value.replace(/\D/g, ''))} onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && check()} />
            </label>
            <button class="btn amber" disabled={busy || code.length !== 6} onClick={check}>{busy ? 'Checking…' : 'Sign in'}</button>
            <button class="link" onClick={() => { setSentTo(null); setCode(''); setError(''); }}>Use a different email</button>
          </>
        )}
        {error && <p class="note bad" role="alert">{error}</p>}
      </div>
    </div>
  );
}

/** Change your display name mid-room. */
export function RenameSheet(props: { session: Session; current: string; onClose: () => void }) {
  const [name, setName] = useState(props.current);
  const apply = () => {
    const next = name.trim();
    if (next && next !== props.current) {
      props.session.rename(next);
      if (account.current) void account.setName(next);
    }
    props.onClose();
  };
  return (
    <Sheet title="Change your alias" onClose={props.onClose}>
      <span class="row">
        <input class="nameinput" value={name} maxLength={MAX_NAME_LENGTH} placeholder="e.g. Sticky Pete" aria-label="Your alias" enterkeyhint="done"
          onInput={(e) => setName((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && apply()} />
        <button class="btn small ghost" style="min-height:56px" onClick={() => { sfx.flick(); setName(randomAlias()); }} aria-label="Give me a random alias">🎲</button>
      </span>
      <button class="btn amber" disabled={!name.trim()} onClick={apply}>Save alias</button>
      <button class="btn ghost" onClick={props.onClose}>Never mind</button>
    </Sheet>
  );
}

// ------------------------------------------------------------------ setup

function PackPicker(props: { value: string[]; onChange: (ids: string[]) => void }) {
  const toggle = (id: string) => {
    const next = props.value.includes(id) ? props.value.filter((p) => p !== id) : [...props.value, id];
    if (next.length) props.onChange(next);
  };
  return (
    <div class="stack" style="gap:4px">
      <div class="packs" role="group" aria-label="Phrase packs. Swipe sideways for more.">
        {PACKS.map((pack) => {
          const on = props.value.includes(pack.id);
          return (
            <button key={pack.id} class="pack" aria-pressed={on} onClick={() => toggle(pack.id)}>
              <span class="tick" aria-hidden="true">{on ? '✓' : ''}</span>
              <span class="icon" aria-hidden="true">{pack.icon ?? '📦'}</span>
              <strong>{pack.name}</strong>
              <small>{packSize(pack)} phrases{pack.rating === 'adult' ? ' · 18+' : ''}</small>
              <small class="blurb">{pack.description}</small>
            </button>
          );
        })}
      </div>
      <p class="muted" style="font-size:.82rem">
        {props.value.length} of {PACKS.length} crates loaded · {deckSize(buildDeck(props.value))} phrases · swipe for more
      </p>
    </div>
  );
}

export function Chillies(props: { count: number }) {
  return (
    <span class="chillies" role="img" aria-label={`Spiciness ${props.count}`}>
      {'🌶️'.repeat(props.count)}
    </span>
  );
}

/** Hand size and spiciness, with the easy / medium / hard split drawn as a bar. */
function SettingsPicker(props: { value: GameSettings; onChange: (s: GameSettings) => void }) {
  const { handSize, spice, catchphrase } = props.value;
  const level = spiceLevel(spice);
  const set = (patch: Partial<GameSettings>) => {
    sfx.flick();
    props.onChange({ ...props.value, ...patch });
  };
  return (
    <>
      <div class="field">
        <span class="label">Phrases each</span>
        <div class="numgrid six" role="group" aria-label="Phrases each">
          {Array.from({ length: MAX_HAND_SIZE - MIN_HAND_SIZE + 1 }, (_, i) => i + MIN_HAND_SIZE).map((n) => (
            <button key={n} aria-pressed={handSize === n} onClick={() => set({ handSize: n })}>{n}</button>
          ))}
        </div>
      </div>
      <div class="field">
        <span class="label">Spiciness: {level.name}</span>
        <div class="spice" role="group" aria-label="Spiciness">
          {SPICE_LEVELS.map((s) => (
            <button key={s.level} aria-pressed={spice === s.level} aria-label={`${s.name}: ${s.mix.easy}% easy, ${s.mix.medium}% medium, ${s.mix.hard}% hard`} onClick={() => set({ spice: s.level })}>
              <span class={s.level <= spice ? 'lit' : ''}>🌶️</span>
            </button>
          ))}
        </div>
        <div class="mix" aria-hidden="true">
          {TIERS.map((tier) => (
            <i key={tier} class={tier} style={{ flexGrow: level.mix[tier] }}>
              {level.mix[tier]}%
            </i>
          ))}
        </div>
        <div class="mixkey" aria-hidden="true">
          <span>easy</span>
          <span>medium</span>
          <span>hard</span>
        </div>
        <p class="marker spiceblurb">{level.blurb}</p>
      </div>
      <div class="field">
        <span class="label">Catchphrase</span>
        <button class="toggle" role="switch" aria-checked={catchphrase} onClick={() => set({ catchphrase: !catchphrase })}>
          <span class="sw" />
          <span>
            <strong>Catchphrases {catchphrase ? 'on' : 'off'}</strong>
            <small>
              {catchphrase
                ? 'Everyone also gets one easy phrase to say again and again, counted each time it gets through.'
                : 'No catchphrase: just the phrases in your hand.'}
            </small>
          </span>
        </button>
      </div>
    </>
  );
}

function settingsSummary(s: GameSettings): string {
  const level = spiceLevel(s.spice);
  return `${s.handSize} phrases each · ${level.name} (${level.mix.easy}/${level.mix.medium}/${level.mix.hard})${s.catchphrase ? '' : ' · no catchphrase'}`;
}

export function Setup(props: { kind: 'create' | 'join'; code?: string; forceSync?: boolean; onBack: () => void; onSession: (s: Session) => void }) {
  const creating = props.kind === 'create';
  const [mode, setMode] = useState<'sync' | 'offline'>(props.forceSync || navigator.onLine ? 'sync' : 'offline');
  const [name, setName] = useState(() => account.current?.name || (load<string>('name') ?? ''));
  const [packs, setPacks] = useState<string[]>(DEFAULT_PACK_IDS);
  const [settings, setSettings] = useState<GameSettings>(() => ({ ...DEFAULT_SETTINGS, ...(load<GameSettings>('settings') ?? {}) }));
  const [code, setCode] = useState(() => (creating ? randomCode() : props.code ?? ''));
  const [number, setNumber] = useState<number | null>(null);

  const validCode = normalizeCode(code);
  const ready = mode === 'sync' ? name.trim().length > 0 && (creating || !!validCode) : !!validCode && number !== null;

  const go = () => {
    if (!ready) return;
    save('settings', settings);
    if (mode === 'sync') {
      save('name', name.trim());
      props.onSession(creating ? SyncSession.host(name.trim(), packs, settings) : SyncSession.join(validCode, name.trim()));
    } else {
      props.onSession(OfflineSession.create(validCode, packs, number!, settings));
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

        {(creating || mode === 'offline') && <SettingsPicker value={settings} onChange={setSettings} />}
        {!creating && mode === 'offline' && <p class="muted" style="font-size:.88rem">Pick the same packs, phrase count and spiciness as the host.</p>}

        {mode === 'offline' && validCode && (
          <p class="note">
            Manifest check <strong>#{manifestNumber(validCode, packs, settings)}</strong>. Everyone should see the same number before you play.
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

export function Lobby(props: { session: Session; state: SessionState; onLeave: () => void; onHome: () => void }) {
  const { session, state } = props;
  const isHost = state.hostId === state.you.id;
  const [renaming, setRenaming] = useState(false);
  const url = joinUrl(state.code);
  const share = () => {
    const data = { title: 'Smuggled Phrases', text: `Join my Smuggled Phrases room: ${state.code}`, url };
    if (navigator.share) navigator.share(data).catch(() => {});
    else navigator.clipboard?.writeText(url).catch(() => {});
  };
  return (
    <div class="screen">
      <TopBar title="The hideout" onBack={props.onHome} />
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
                {p.id === state.you.id && (
                  <button class="kick" onClick={() => setRenaming(true)}>Rename</button>
                )}
              </li>
            ))}
            {state.players.length === 0 && <li>Opening the room…</li>}
          </ul>
        </div>
        <p class="muted" style="font-size:.9rem;text-align:center">
          {state.packs.map((id) => getPack(id)?.name ?? id).join(' + ') || '…'}
          <br />
          {settingsSummary(state.settings)} <Chillies count={state.settings.spice} />
        </p>
        {isHost && (
          <details class="tune">
            <summary>Change the job</summary>
            <div class="stack" style="gap:14px;margin-top:12px">
              <SettingsPicker value={state.settings} onChange={(next) => session.configure({ packs: state.packs, ...next })} />
              <PackPicker value={state.packs} onChange={(packs) => session.configure({ packs, ...state.settings })} />
            </div>
          </details>
        )}
        {isHost ? (
          <button class="btn amber" disabled={state.players.length < 2 || state.connection !== 'online'} onClick={() => session.start()}>
            {state.players.length < 2 ? 'Waiting for the crew…' : 'Deal the contraband'}
          </button>
        ) : (
          <p class="note">Waiting for the host to deal the contraband…</p>
        )}
        <button class="link" onClick={props.onLeave}>Leave room</button>
      </div>
      {renaming && <RenameSheet session={session} current={state.you.name} onClose={() => setRenaming(false)} />}
    </div>
  );
}

// ------------------------------------------------------------- scoreboard

const GAME_RANKS = ['Tourist', 'Pickpocket', 'Mule', 'Runner', 'Fixer', 'Kingpin'];

export function Scoreboard(props: { session: Session; state: SessionState; onClose: () => void; onHowTo: () => void; onLeave: () => void; onHome: () => void }) {
  const { session, state } = props;
  const isHost = state.mode === 'sync' && state.hostId === state.you.id;
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [renaming, setRenaming] = useState(false);
  if (renaming) return <RenameSheet session={session} current={state.you.name} onClose={() => setRenaming(false)} />;
  return (
    <Sheet title={state.mode === 'sync' ? 'Most wanted' : 'Your record'} onClose={props.onClose}>
      <div class="paper">
        <div class="paper-head">
          <span>Game {state.code}</span>
          <span>{state.mode === 'sync' ? `${spiceLevel(state.settings.spice).name} · ${state.pileCount} in the crate` : `Player ${state.playerNumber} · check #${state.manifest}`}</span>
        </div>
        <table class="scores">
          <thead>
            <tr>
              <th>Smuggler</th>
              <th>Left</th>
              <th>Badges</th>
              <th>Cleared</th>
              {state.settings.catchphrase && <th title="Times their catchphrase got through uncaught">Catch</th>}
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
                    {p.id === state.you.id && state.mode === 'sync' && (
                      <button class="kick" onClick={() => setRenaming(true)}>Rename</button>
                    )}
                    {isHost && p.id !== state.you.id && !p.connected && (
                      <button class="kick" onClick={() => session.kick(p.id)}>Remove</button>
                    )}
                  </span>
                </td>
                <td>{p.cards}</td>
                <td><Badges left={p.badges} /></td>
                <td>{p.smuggled}</td>
                {state.settings.catchphrase && <td>{p.catchCount ? `×${p.catchCount}` : '–'}</td>}
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
      <button class="btn ghost" onClick={props.onHome}>My games</button>
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

export function Win(props: { session: Session; state: SessionState; onLeave: () => void; onHome: () => void }) {
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
      {(() => {
        // The catchphrase count is its own little contest.
        const best = Math.max(0, ...state.players.map((p) => p.catchCount ?? 0));
        if (best === 0) return null;
        const champs = state.players.filter((p) => (p.catchCount ?? 0) === best).map((p) => (state.mode === 'offline' ? 'You' : p.name));
        return <p class="note">Catchphrase {champs.length > 1 ? 'champions' : 'champion'}: <b>{champs.join(' & ')}</b>, ×{best} without getting caught.</p>;
      })()}
      <div class="spacer" />
      <div class="stack" style="width:100%">
        {isHost && <button class="btn amber" onClick={() => session.again()}>Deal again</button>}
        {state.mode === 'sync' && !isHost && <p class="note">The host can deal another round.</p>}
        <button class="btn ghost" onClick={props.onLeave}>{state.mode === 'sync' ? 'Leave room' : 'End game'}</button>
        <button class="link" onClick={props.onHome}>My games</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ how to play

/** The rules, written for the game being played: its hand size and whether catchphrases are on. */
export function RuleList(props: { settings?: GameSettings }) {
  const settings = props.settings ?? DEFAULT_SETTINGS;
  const fixed = !!props.settings;
  return (
    <ol class="rules">
      <li class="paper">
        You start with <b>{settings.handSize} secret phrases</b>
        {fixed ? '' : ' (the host can pick 3 to 8, and how spicy they are)'}. Keep your phone to yourself.
      </li>
      <li class="paper">Work a phrase into the conversation <b>out loud</b>, then tap <b>Said it</b> on that card. A private 30-second countdown starts.</li>
      <li class="paper">If nobody calls it in 30 seconds, shout <b>“Smuggled!”</b>, show the card, and clear it from your hand.</li>
      <li class="paper">Think someone just smuggled? Shout <b>“Contraband!”</b> within the 30 seconds <b>and repeat the phrase</b>. Pointing at a person is not enough.</li>
      <li class="paper">Caught: tap <b>Failed</b> on that card. The phrase is <b>seized</b> and replaced with a new one, and the catcher earns a <b>bounty coin</b>.</li>
      <li class="paper">Each <b>bounty coin</b> swaps one of your phrases for a fresh one, whenever you like. Coins pile up until you spend them.</li>
      <li class="paper">Wrong call: the caller <b>draws an extra phrase</b> and loses one of their <b>3 inspector badges</b>. No badges, no calling. Bluffing with odd sentences to drain badges is fair play.</li>
      {settings.catchphrase && (
        <li class="paper">You also get one <b>catchphrase</b>. Say it as often as you dare: it never leaves your hand, and every time it survives 30 seconds your count goes up. Caught? You keep it, but that one does not count.</li>
      )}
      <li class="paper">First player with an <b>empty hand</b> wins.{settings.catchphrase ? ' Your catchphrase does not need clearing.' : ''}</li>
      <li class="paper">Phrases must be spoken <b>aloud</b>.</li>
      <li class="paper"><b>Bend a phrase, never break it.</b> You may swap one or two filler words (and, but, or) and rearrange it slightly to suit how people talk where you are, but never change the important details or the spirit of the phrase. Rule of thumb: keep it <b>95% original</b>.</li>
      <li class="paper">Careful: if <b>everyone else disagrees</b> with how you bent it, you are caught.</li>
    </ol>
  );
}

/** Shown once, the first time a game starts on this phone. */
export function RulesSheet(props: { settings: GameSettings; onClose: () => void }) {
  return (
    <Sheet title="Before you smuggle">
      <p class="marker" style="font-size:1.05rem">Thirty seconds of rules. Then act natural.</p>
      <RuleList settings={props.settings} />
      <div class="stick">
        <button class="btn amber" onClick={props.onClose}>Got it, deal me in</button>
      </div>
    </Sheet>
  );
}

export function HowTo(props: { settings?: GameSettings; onBack: () => void }) {
  return (
    <div class="screen">
      <TopBar title="How to play" onBack={props.onBack} />
      <p class="tagline" style="margin:0 0 14px">Talk normal. Smuggle nonsense. Don’t get searched.</p>
      <RuleList settings={props.settings} />
      <p class="muted" style="margin:14px 0;font-size:.9rem">
        Your timers keep running if the phone locks. In a synced room the app tracks the scoreboard and settles calls; offline, it is all on your honor.
      </p>
      <a
        class="link"
        style="display:inline-flex;align-items:center;align-self:center;margin-bottom:8px"
        href="https://github.com/antistud/smuggled-phrases#how-to-play"
        target="_blank"
        rel="noopener noreferrer"
      >
        Read the full rules
      </a>
      <button class="btn" onClick={props.onBack}>Got it</button>
    </div>
  );
}
