/**
 * The effects layer: a transparent Phaser canvas laid over the whole app.
 * It draws the atmosphere (searchlights, dock fog, dust in the lamplight) and
 * the big moments (stamp dust, fuse sparks, alarm lights, cash rain).
 *
 * Phaser is loaded lazily so the hand is usable before the engine arrives, and
 * never at all when the user asks for reduced motion. Every call here is a
 * safe no-op until (or unless) the scene is running.
 */
type Mood = 'den' | 'job';

interface Stage {
  dust(x: number, y: number, count: number): void;
  sparks(x: number, y: number, count: number): void;
  alarm(): void;
  cash(): void;
  mood(mood: Mood): void;
}

let stage: Stage | null = null;
let host: HTMLElement | null = null;
let pendingMood: Mood = 'den';
let started = false;

export const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Centre of an element in effects-canvas coordinates. */
function centre(el: Element, alongX = 0.5): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  const base = host?.getBoundingClientRect() ?? { left: 0, top: 0 };
  return { x: r.left - base.left + r.width * alongX, y: r.top - base.top + r.height / 2 };
}

export const fx = {
  start(parent: HTMLElement): void {
    if (started || reducedMotion()) return;
    started = true;
    host = parent;
    import('phaser').then((mod) => build((mod as any).default ?? mod, parent)).catch(() => {});
  },
  /** A puff of dust, e.g. under a slammed stamp. */
  dustAt(el: Element | null, count = 22): void {
    if (!el || !stage) return;
    const p = centre(el);
    stage.dust(p.x, p.y, count);
  },
  /** Sparks at a point along an element's width (0 = left edge, 1 = right edge). */
  sparksAt(el: Element | null, alongX = 0.5, count = 2): void {
    if (!el || !stage) return;
    const p = centre(el, alongX);
    stage.sparks(p.x, p.y, count);
  },
  alarm(): void {
    stage?.alarm();
  },
  cash(): void {
    stage?.cash();
  },
  mood(mood: Mood): void {
    pendingMood = mood;
    stage?.mood(mood);
  },
  /** Rattles the whole app, for stamps and slammed doors. */
  shake(hard = false): void {
    if (reducedMotion()) return;
    const app = document.getElementById('app');
    if (!app) return;
    const cls = hard ? 'shake-hard' : 'shake';
    app.classList.remove('shake', 'shake-hard');
    void app.offsetWidth;
    app.classList.add(cls);
    setTimeout(() => app.classList.remove(cls), 450);
  },
};

function build(Phaser: any, parent: HTMLElement): void {
  class FxScene extends Phaser.Scene {
    beams: any[] = [];
    cops: any[] = [];
    flash: any;
    dustFx: any;
    sparkFx: any;
    cashFx: any;
    coinFx: any;

    create(this: any) {
      const g = this.make.graphics({ x: 0, y: 0 }, false);
      // Soft round blob: fog, dust, glints.
      for (let i = 8; i > 0; i--) {
        g.fillStyle(0xffffff, 0.12);
        g.fillCircle(16, 16, i * 2);
      }
      g.generateTexture('blob', 32, 32);
      g.clear();
      g.fillStyle(0xffffff, 1);
      g.fillRect(0, 0, 4, 4);
      g.generateTexture('spark', 4, 4);
      g.clear();
      // A crumpled banknote.
      g.fillStyle(0x3f7a44, 1);
      g.fillRect(0, 0, 24, 12);
      g.fillStyle(0xa9d59a, 1);
      g.fillRect(2, 2, 20, 8);
      g.fillStyle(0x3f7a44, 1);
      g.fillCircle(12, 6, 3);
      g.generateTexture('note', 24, 12);
      g.clear();
      // A searchlight cone, soft at the edges.
      for (let i = 0; i < 7; i++) {
        g.fillStyle(0xffffff, 0.16);
        g.fillTriangle(110, 0, 110 - (16 + i * 13), 600, 110 + (16 + i * 13), 600);
      }
      g.generateTexture('beam', 220, 600);
      g.destroy();

      const W = () => this.scale.width;
      const H = () => this.scale.height;
      const ADD = Phaser.BlendModes.ADD;

      // Two lazy searchlights sweeping the dock.
      [0.2, 0.8].forEach((at, i) => {
        const beam = this.add.image(W() * at, -30, 'beam').setOrigin(0.5, 0).setBlendMode(ADD).setTint(0xf2c86a).setAlpha(0.07);
        beam.at = at;
        beam.angle = i ? 24 : -24;
        this.tweens.add({ targets: beam, angle: i ? -30 : 30, duration: 7000 + i * 2300, ease: 'Sine.easeInOut', yoyo: true, repeat: -1 });
        this.beams.push(beam);
      });

      // Harbour fog rolling through.
      this.add.particles(0, 0, 'blob', {
        x: { onEmit: () => -80 + Math.random() * (W() + 80) },
        y: { onEmit: () => Math.random() * H() },
        lifespan: 11000,
        speedX: { min: 6, max: 20 },
        speedY: { min: -3, max: 3 },
        scale: { min: 4, max: 9 },
        // onEmit matters: without it a new particle is drawn at full opacity for one frame, a visible flash.
        alpha: { onEmit: () => 0, onUpdate: (_p: any, _k: string, t: number) => 0.05 * Math.sin(Math.PI * t) },
        tint: [0x9aa58c, 0x7d8a86, 0xb9a57c],
        frequency: 700,
      });
      // Dust motes catching the lamp.
      this.add.particles(0, 0, 'blob', {
        x: { onEmit: () => Math.random() * W() },
        y: { onEmit: () => Math.random() * H() },
        lifespan: 6000,
        speedY: { min: -14, max: -4 },
        speedX: { min: -6, max: 6 },
        scale: { min: 0.08, max: 0.22 },
        alpha: { onEmit: () => 0, onUpdate: (_p: any, _k: string, t: number) => 0.5 * Math.sin(Math.PI * t) },
        tint: 0xf2c86a,
        blendMode: ADD,
        frequency: 260,
      });

      this.dustFx = this.add.particles(0, 0, 'blob', {
        speed: { min: 40, max: 190 },
        angle: { min: 0, max: 360 },
        lifespan: { min: 350, max: 850 },
        scale: { start: 0.9, end: 0.15 },
        alpha: { start: 0.55, end: 0 },
        tint: [0x8a6a45, 0xc9a36b, 0x4a3a28, 0xe2d3b0],
        gravityY: 140,
        emitting: false,
      });
      this.sparkFx = this.add.particles(0, 0, 'spark', {
        speed: { min: 50, max: 230 },
        angle: { min: 200, max: 340 },
        lifespan: { min: 250, max: 600 },
        scale: { start: 1.3, end: 0 },
        tint: [0xffd27a, 0xff8a2a, 0xfff1c0],
        gravityY: 520,
        blendMode: ADD,
        emitting: false,
      });
      this.cashFx = this.add.particles(0, 0, 'note', {
        x: { onEmit: () => Math.random() * W() },
        y: -20,
        speedY: { min: 140, max: 300 },
        speedX: { min: -70, max: 70 },
        rotate: { start: 0, end: 540 },
        scaleX: { onUpdate: (_p: any, _k: string, t: number) => Math.cos(t * 14) * 1.4 },
        scaleY: 1.4,
        lifespan: 4200,
        quantity: 2,
        frequency: 45,
        emitting: false,
      });
      this.coinFx = this.add.particles(0, 0, 'blob', {
        x: { onEmit: () => Math.random() * W() },
        y: -10,
        speedY: { min: 200, max: 420 },
        scale: { min: 0.15, max: 0.35 },
        tint: [0xf2c86a, 0xffe7a0],
        blendMode: ADD,
        lifespan: 3200,
        frequency: 70,
        emitting: false,
      });

      // Alarm: a red wash and two fast patrol lights.
      this.flash = this.add.rectangle(0, 0, W(), H(), 0xff2a1a).setOrigin(0).setAlpha(0);
      [0xff3a2a, 0x3a7bff].forEach((tint, i) => {
        const cop = this.add.image(W() / 2, -30, 'beam').setOrigin(0.5, 0).setBlendMode(ADD).setTint(tint).setAlpha(0);
        cop.dir = i ? -1 : 1;
        this.cops.push(cop);
      });

      const layout = () => {
        const sy = (H() + 80) / 600;
        for (const b of [...this.beams, ...this.cops]) b.setScale(1.5, sy * 1.25);
        for (const b of this.beams) b.x = W() * b.at;
        for (const c of this.cops) c.x = W() / 2;
        this.flash.setSize(W(), H());
      };
      layout();
      this.scale.on('resize', layout);

      const scene = this;
      stage = {
        dust: (x, y, n) => scene.dustFx.explode(n, x, y),
        sparks: (x, y, n) => scene.sparkFx.explode(n, x, y),
        alarm() {
          scene.tweens.killTweensOf([scene.flash, ...scene.cops]);
          scene.flash.setAlpha(0);
          scene.tweens.add({ targets: scene.flash, alpha: 0.26, duration: 160, yoyo: true, repeat: 4 });
          for (const cop of scene.cops) {
            cop.setAlpha(0.3);
            cop.angle = -70 * cop.dir;
            scene.tweens.add({ targets: cop, angle: 70 * cop.dir, duration: 520, ease: 'Sine.easeInOut', yoyo: true, repeat: 2 });
            scene.tweens.add({ targets: cop, alpha: 0, delay: 1300, duration: 400 });
          }
        },
        cash() {
          scene.cashFx.start();
          scene.coinFx.start();
          scene.time.delayedCall(3600, () => {
            scene.cashFx.stop();
            scene.coinFx.stop();
          });
        },
        mood(mood) {
          // Keep the lights off the paperwork while a job is on.
          for (const b of scene.beams) scene.tweens.add({ targets: b, alpha: mood === 'den' ? 0.08 : 0.035, duration: 600 });
        },
      };
      stage.mood(pendingMood);
    }
  }

  new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    transparent: true,
    banner: false,
    scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
    fps: { target: 30, limit: 30 },
    audio: { noAudio: true },
    input: { mouse: false, touch: false, keyboard: false, gamepad: false },
    render: { antialias: true, powerPreference: 'low-power' },
    scene: FxScene,
  });
}
