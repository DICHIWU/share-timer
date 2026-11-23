/* 小組分享計時 — app logic (no dependencies) */
'use strict';

(function () {
  // ---------- Constants ----------
  const STORAGE_KEY = 'shareTimer.v1';
  const DEFAULT_DURATION = 60;           // seconds (fallback when nothing valid is saved)
  const MIN_DURATION = 5;
  const MAX_DURATION = 59 * 60 + 55;     // 59:55 (stepper moves in 5 s steps)
  const WARN_SECONDS = 20;               // red at <= 20 s remaining
  const OVERTIME_FULL_SECONDS = 30;      // blue overtime wedge fills the circle at +00:30 (silent)
  const LATE_BELL_LIMIT_MS = 5000;       // skip a bell / voice cue this late (e.g. after background)
  const WARN_VOICE_VOLUME = 0.6;         // 「剩下 20 秒」
  const TICK_MS = 200;
  const MAX_NAME_LEN = 30;

  // v10 seating: every person sits on a side; labels auto-number per side (前1, 前2, …).
  // v11 drawing (TaiChi): 前 = top (left→right), 右 = right (top→bottom),
  // 後 = bottom (left→right, 後1 leftmost), 左 = left (top→bottom, 左1 topmost).
  const SIDES = ['前', '右', '後', '左'];
  const SIDE_CLASS = { 前: 'top', 右: 'right', 後: 'bottom', 左: 'left' };
  const isSide = (s) => SIDES.includes(s);
  const sideRank = (s) => SIDES.indexOf(s);

  // ---------- Small helpers ----------
  const $ = (id) => document.getElementById(id);
  const now = () => Date.now(); // wall clock keeps advancing while the page is suspended

  let idSeq = 0;
  function uid() {
    return Date.now().toString(36) + '-' + (idSeq++).toString(36) + '-' +
      Math.random().toString(36).slice(2, 7);
  }

  function clampDuration(sec) {
    if (!Number.isFinite(sec)) return DEFAULT_DURATION;
    return Math.min(MAX_DURATION, Math.max(MIN_DURATION, Math.round(sec)));
  }

  function fmt(totalSec) {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function fmtShort(totalSec) {
    return Math.floor(totalSec / 60) + ':' + String(totalSec % 60).padStart(2, '0');
  }

  function cleanName(name) {
    return String(name).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LEN);
  }

  // ---------- Storage (robust to unavailable / corrupted localStorage) ----------
  const storage = (function () {
    try {
      const k = '__share_timer_test__';
      window.localStorage.setItem(k, k);
      window.localStorage.removeItem(k);
      return window.localStorage;
    } catch (e) {
      return null;
    }
  })();

  // ---------- Sides (data model helpers) ----------
  function sideCounts(list) {
    const c = { 前: 0, 右: 0, 後: 0, 左: 0 };
    list.forEach((p) => { if (isSide(p.side)) c[p.side]++; });
    return c;
  }

  // Side with the fewest people; ties → the earliest in 前, 右, 後, 左.
  function fewestSide(list) {
    const c = sideCounts(list);
    let best = SIDES[0];
    SIDES.forEach((s) => { if (c[s] < c[best]) best = s; });
    return best;
  }

  // Stable sort into chart order: all 前, then 右, 後, 左 (order within a side kept).
  function sortBySide(list) {
    return list
      .map((p, i) => ({ p, i }))
      .sort((a, b) => sideRank(a.p.side) - sideRank(b.p.side) || a.i - b.i)
      .map((x) => x.p);
  }

  // v9 / unsided data: in list order, 3 per side (前, 右, 後, 左) for the first 12,
  // then everyone left goes to the side that currently has the fewest people.
  // Mixed data (some already sided): only the unsided get the fewest-side rule.
  function assignMissingSides(list) {
    if (!list.some((p) => isSide(p.side))) {
      list.forEach((p, i) => { if (i < 12) p.side = SIDES[Math.floor(i / 3)]; });
    }
    list.forEach((p) => { if (!isSide(p.side)) p.side = fewestSide(list); });
    return sortBySide(list);
  }

  // Seat label per person id: 前1, 前2, …, 右1, … (list must be in side order).
  function seatLabels(list) {
    const n = { 前: 0, 右: 0, 後: 0, 左: 0 };
    const out = new Map();
    list.forEach((p) => { out.set(p.id, p.side + (++n[p.side])); });
    return out;
  }

  function defaultPeople() {
    return assignMissingSides(
      Array.from({ length: 12 }, (_, i) => ({ id: uid(), name: '成員 ' + (i + 1), done: false })));
  }

  function loadState() {
    const fallback = { people: defaultPeople(), duration: DEFAULT_DURATION, showSeats: true };
    if (!storage) return fallback;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return fallback;
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return fallback;

      let people = fallback.people;
      if (Array.isArray(data.people)) {
        const seen = new Set();
        const list = data.people
          .filter((p) => p && typeof p === 'object' && typeof p.name === 'string')
          .map((p, i) => {
            let id = typeof p.id === 'string' && p.id ? p.id : uid();
            if (seen.has(id)) id = uid();
            seen.add(id);
            const side = isSide(p.side) ? p.side : null;
            const seat = Number.isFinite(p.seat) ? p.seat : Infinity;
            return { person: { id, name: cleanName(p.name) || '成員', done: p.done === true, side }, seat, i };
          });
        // v10 saves: side + seat (1-based order within the side). Sided people keep their
        // saved order; anyone unsided (v9 saves) is appended and migrated.
        list.sort((a, b) =>
          (!a.person.side - !b.person.side) ||
          (a.person.side && b.person.side ? sideRank(a.person.side) - sideRank(b.person.side) : 0) ||
          (a.person.side && b.person.side ? a.seat - b.seat : 0) ||
          a.i - b.i);
        people = assignMissingSides(list.map((x) => x.person));
      }
      // showSeats (v9): missing in v8 saves → default ON
      const showSeats = typeof data.showSeats === 'boolean' ? data.showSeats : true;
      return { people, duration: clampDuration(Number(data.duration)), showSeats };
    } catch (e) {
      return fallback;
    }
  }

  function saveState() {
    if (!storage) return;
    try {
      const n = { 前: 0, 右: 0, 後: 0, 左: 0 };
      storage.setItem(STORAGE_KEY, JSON.stringify({
        version: 1,
        duration: state.duration,
        showSeats: state.showSeats,
        // side + seat (order within the side, 1-based); the array itself is also in seat order
        people: state.people.map((p) => ({ id: p.id, name: p.name, done: p.done, side: p.side, seat: ++n[p.side] })),
      }));
    } catch (e) { /* quota / private mode: ignore */ }
  }

  // ---------- State ----------
  const loaded = loadState();
  const state = {
    people: loaded.people,
    duration: loaded.duration,
    showSeats: loaded.showSeats,   // 座位圖 preference (the chart may still auto-hide on small screens)
    editing: false,
    selectedId: null,              // edit mode: row ⇄ seat highlighted in yellow
  };

  // The current speaker's timer. Not persisted: a reload stops any countdown.
  const timer = {
    personId: null,
    running: false,
    accumulated: 0,   // ms elapsed before the current run segment
    runStart: 0,      // wall-clock ms when the current run segment started
    spoke20: false,
    rang0: false,
    intervalId: null,
  };

  function findPerson(id) { return state.people.find((p) => p.id === id) || null; }
  function currentPerson() { return timer.personId ? findPerson(timer.personId) : null; }
  function isActive() { return timer.personId !== null; }

  function elapsedMs() {
    return timer.accumulated + (timer.running ? now() - timer.runStart : 0);
  }

  // ---------- Audio (Web Audio bell, no files) ----------
  const Bell = {
    ctx: null,
    out: null,
    primed: false,

    ensureCtx() {
      if (this.ctx) return this.ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try {
        this.ctx = new AC();
        const comp = this.ctx.createDynamicsCompressor();
        const master = this.ctx.createGain();
        master.gain.value = 1.0;
        master.connect(comp);
        comp.connect(this.ctx.destination);
        this.out = master;
      } catch (e) {
        this.ctx = null;
      }
      return this.ctx;
    },

    // Must be called from a user gesture (iOS requirement). Safe to call repeatedly.
    unlock() {
      // Safari 17+: play through the ring/silent switch like a media app
      try {
        if (navigator.audioSession && navigator.audioSession.type !== 'playback') {
          navigator.audioSession.type = 'playback';
        }
      } catch (e) { /* ignore */ }

      const ctx = this.ensureCtx();
      if (!ctx) return;
      try {
        if (ctx.state !== 'running') ctx.resume().catch(() => {});
        if (!this.primed) {
          // Play a silent buffer inside the gesture; older iOS needs this to unlock output.
          const buf = ctx.createBuffer(1, 1, 22050);
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(ctx.destination);
          src.start(0);
          this.primed = true;
        }
      } catch (e) { /* ignore */ }
    },

    // Plays the 叮咚 chime. `level` 0–1 (1.0 = full volume).
    // Resolves once the chime has been scheduled (true) or failed (false); never rejects.
    ring(level = 1.0) {
      try {
        const ctx = this.ensureCtx();
        if (!ctx) return Promise.resolve(false);
        if (ctx.state === 'running') {
          this.chime(ctx, level);
          return Promise.resolve(true);
        }
        return ctx.resume()
          .then(() => { this.chime(ctx, level); return true; })
          .catch(() => false);
      } catch (e) { /* audio failures must never break the timer */
        return Promise.resolve(false);
      }
    },

    // Two-note bell ("ding-dong") built from inharmonic partials with exponential decay.
    chime(ctx, level) {
      const t0 = ctx.currentTime + 0.03;
      this.strike(ctx, 1046.5, t0, level);               // C6 叮
      this.strike(ctx, 784.0, t0 + 0.42, level * 0.95);  // G5 咚
    },

    strike(ctx, freq, t, level) {
      const partials = [
        // [ratio, gain, decay seconds]
        [1.0, 0.55, 2.2],
        [2.0, 0.22, 1.4],
        [2.76, 0.14, 0.9],
        [5.40, 0.06, 0.5],
        [0.5, 0.10, 1.8],
      ];
      partials.forEach(([ratio, gain, decay]) => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq * ratio, t);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(gain * level, t + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
        osc.connect(g);
        g.connect(this.out);
        osc.start(t);
        osc.stop(t + decay + 0.05);
      });
    },
  };

  // ---------- Voice (Web Speech API) ----------
  // Every call is wrapped so a missing / broken speechSynthesis never affects the timer.
  const Voice = {
    synth: null,
    voice: null,
    primed: false,
    pendingId: null,

    init() {
      try {
        if (!('speechSynthesis' in window) || typeof window.SpeechSynthesisUtterance !== 'function') return;
        this.synth = window.speechSynthesis;
        this.pickVoice();
        // Voices often load asynchronously (Chrome, iOS)
        if (typeof this.synth.addEventListener === 'function') {
          this.synth.addEventListener('voiceschanged', () => this.pickVoice());
        } else {
          this.synth.onvoiceschanged = () => this.pickVoice();
        }
      } catch (e) { this.synth = null; }
    },

    pickVoice() {
      try {
        const voices = this.synth ? this.synth.getVoices() || [] : [];
        const norm = (v) => String(v.lang || '').replace('_', '-').toLowerCase();
        this.voice =
          voices.find((v) => norm(v) === 'zh-tw') ||
          voices.find((v) => norm(v).startsWith('zh-hant')) ||
          voices.find((v) => norm(v).startsWith('zh')) ||
          null;
      } catch (e) { this.voice = null; }
    },

    makeUtterance(text, volume) {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-TW';
      if (this.voice) u.voice = this.voice;
      u.volume = volume;
      u.rate = 1.3;
      u.pitch = 1;
      return u;
    },

    // Must run inside a user gesture (iOS): speak a silent utterance once.
    unlock() {
      if (!this.synth || this.primed) return;
      try {
        this.synth.speak(this.makeUtterance(' ', 0));
        this.primed = true;
      } catch (e) { /* ignore */ }
    },

    // Returns the utterance (so callers can listen for onend), or null if speech is unavailable.
    speak(text, volume) {
      if (!this.synth) return null;
      try {
        if (this.synth.speaking || this.synth.pending) this.synth.cancel();
        if (this.synth.paused) this.synth.resume(); // Chrome can get stuck paused
        const u = this.makeUtterance(text, volume);
        this.synth.speak(u);
        return u;
      } catch (e) { return null; }
    },

    // Speak after a delay (e.g. after the chime). Replaces any earlier pending one.
    speakLater(text, volume, delayMs) {
      this.cancelPending();
      this.pendingId = setTimeout(() => {
        this.pendingId = null;
        this.speak(text, volume);
      }, delayMs);
    },

    cancelPending() {
      if (this.pendingId !== null) {
        clearTimeout(this.pendingId);
        this.pendingId = null;
      }
    },

    // Stop everything (used when the speaker changes / timer is cleared).
    stop() {
      this.cancelPending();
      if (!this.synth) return;
      try { if (this.synth.speaking || this.synth.pending) this.synth.cancel(); } catch (e) { /* ignore */ }
    },
  };
  Voice.init();

  // 0:00 cue: full-volume 叮咚, then 「時間到」 once the chime has played its two notes.
  const TIME_UP_SPEECH_DELAY_MS = 800; // after the chime starts (second note is at +0.42s)
  function timeUpCue() {
    Bell.ring(1.0).then(() => {
      Voice.speakLater('時間到', 1.0, TIME_UP_SPEECH_DELAY_MS);
    });
  }

  // 試音量大小 preview: every timer sound in real order / volume / rate:
  // 「剩下 20 秒」(0.6) → short pause → 叮咚 (1.0) → 「時間到」(1.0).
  // Pressing again cancels the previous preview so nothing overlaps.
  const PREVIEW_PAUSE_MS = 700;          // gap after 「剩下 20 秒」 finishes
  const PREVIEW_WARN_FALLBACK_MS = 3500; // if onend never fires (some iOS / Chrome builds)
  const preview = { token: 0, timerId: null };

  function cancelPreview() {
    preview.token++;
    if (preview.timerId !== null) {
      clearTimeout(preview.timerId);
      preview.timerId = null;
    }
    Voice.stop();
  }

  function previewSounds() {
    cancelPreview();
    const token = preview.token;
    const live = () => token === preview.token;
    const schedule = (fn, ms) => {
      if (preview.timerId !== null) clearTimeout(preview.timerId);
      preview.timerId = setTimeout(() => { preview.timerId = null; if (live()) fn(); }, ms);
    };

    let advanced = false;
    const playTimeUp = () => {
      Bell.ring(1.0).then(() => {
        if (live()) Voice.speakLater('時間到', 1.0, TIME_UP_SPEECH_DELAY_MS);
      });
    };
    const afterWarn = () => {
      if (advanced || !live()) return;
      advanced = true;
      schedule(playTimeUp, PREVIEW_PAUSE_MS);
    };

    const u = Voice.speak('剩下 20 秒', WARN_VOICE_VOLUME);
    if (u) {
      u.onend = afterWarn;
      u.onerror = afterWarn;
      schedule(afterWarn, PREVIEW_WARN_FALLBACK_MS);
    } else {
      afterWarn(); // no speech support: still preview the chime
    }
  }

  // Unlock audio + speech on the first (and any later) user interaction.
  ['touchend', 'pointerdown', 'click', 'keydown'].forEach((type) => {
    document.addEventListener(type, () => {
      Bell.unlock();
      // pointerdown is not a user-activation event in Safari, so prime speech on the others
      if (type !== 'pointerdown') Voice.unlock();
    }, { capture: true, passive: true });
  });

  // ---------- Screen Wake Lock ----------
  const Wake = {
    sentinel: null,
    pending: false,

    wanted() { return timer.running && document.visibilityState === 'visible'; },

    async sync() {
      if (!('wakeLock' in navigator)) return;
      if (this.wanted()) {
        if (this.sentinel || this.pending) return;
        this.pending = true;
        try {
          const s = await navigator.wakeLock.request('screen');
          s.addEventListener('release', () => { if (this.sentinel === s) this.sentinel = null; });
          this.sentinel = s;
          if (!this.wanted()) this.release(); // state changed while we waited
        } catch (e) {
          /* not allowed / unsupported: ignore */
        } finally {
          this.pending = false;
        }
      } else {
        this.release();
      }
    },

    release() {
      const s = this.sentinel;
      this.sentinel = null;
      if (s) s.release().catch(() => {});
    },
  };

  // ---------- DOM ----------
  const el = {
    app: $('app'),
    clockPanel: $('clockPanel'),
    dialPie: $('dialPie'),
    speakerName: $('speakerName'),
    status: $('status'),
    clock: $('clock'),
    pausedBadge: $('pausedBadge'),
    pauseBtn: $('pauseBtn'),
    pauseIcon: $('pauseIcon'),
    pauseText: $('pauseText'),
    endBtn: $('endBtn'),
    resetBtn: $('resetBtn'),
    progress: $('progress'),
    editBtn: $('editBtn'),
    listHint: $('listHint'),
    people: $('people'),
    emptyMsg: $('emptyMsg'),
    addForm: $('addForm'),
    addInput: $('addInput'),
    clearMembersBtn: $('clearMembersBtn'),
    listHead: $('listHead'),
    listActions: $('listActions'),
    editHead: $('editHead'),
    doneBtn: $('doneBtn'),
    editFoot: $('editFoot'),
    clearDialog: $('clearDialog'),
    clearYes: $('clearYes'),
    clearNo: $('clearNo'),
    picker: $('sidePicker'),
    pickerBackdrop: $('sidePickerBackdrop'),
    pickerTitle: $('sidePickerTitle'),
    pickerSides: $('sidePickerSides'),
    pickerCancel: $('sidePickerCancel'),
    settingsCard: $('settingsCard'),
    durationGroup: $('durationGroup'),
    durationPreview: $('durationPreview'),
    durationMin: $('durationMin'),
    durationSec: $('durationSec'),
    presets: $('presets'),
    testBellBtn: $('testBellBtn'),
    announcer: $('announcer'),
    side: $('sidePanel'),
    panelToggle: $('panelToggle'),
    panelToggleLabel: $('panelToggleLabel'),
    toggleProgress: $('toggleProgress'),
    seats: $('seats'),
    seatsToggle: $('seatsToggle'),
    logo: document.querySelector('.topbar .logo'),
  };

  // ---------- 名單／座位／設定 panel (collapsed by default; not persisted) ----------
  let panelOpen = false;

  function setPanelOpen(open) {
    open = !!open;
    if (open === panelOpen) return;
    panelOpen = open;
    // Focus must not stay inside a hidden panel; blur (rather than focusing the toggle)
    // so the desktop Space shortcut keeps pausing / resuming the timer.
    if (!open && document.activeElement && el.side.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    if (!open && state.editing) {
      // Collapsing ends 編輯名單, so seat taps go back to "tap to start".
      setEditing(false);
      return;
    }
    renderPanel();
    renderClock();
    updateSeats(); // the chart hides while the panel is open (except in 編輯名單)
  }

  function renderPanel() {
    el.app.dataset.panel = panelOpen ? 'open' : 'closed';
    el.side.hidden = !panelOpen;
    el.panelToggle.setAttribute('aria-expanded', String(panelOpen));
    el.panelToggleLabel.innerHTML = panelOpen
      ? '<span aria-hidden="true">✕</span> 收合'
      : '<span aria-hidden="true">☰</span> 名單／座位／設定';
    el.panelToggle.setAttribute('aria-label', panelOpen ? '收合名單、座位與設定' : '開啟名單、座位與設定');
  }

  function announce(msg) {
    el.announcer.textContent = '';
    // Small delay so repeated identical messages are still announced
    setTimeout(() => { el.announcer.textContent = msg; }, 50);
  }

  // ---------- Clock rendering ----------
  let lastClock = { text: '', mode: '', status: '', paused: null, pct: '' };

  const FULL_PCT = 99.5; // ≥ this (gap < 1.8°, i.e. the first moments of a run) → solid disc

  // pct = size of the colored wedge (0–100), drawn clockwise from 12 o'clock.
  function computeClock() {
    if (!isActive()) {
      return { mode: 'idle', text: fmt(state.duration), status: state.editing ? '編輯中' : '準備', pct: 100 };
    }
    const total = state.duration * 1000;
    const remaining = total - elapsedMs();
    if (remaining > 0) {
      const secs = Math.ceil(remaining / 1000);
      return {
        mode: secs <= WARN_SECONDS ? 'warn' : 'ok',
        text: fmt(secs),
        status: '剩餘',
        pct: (remaining / total) * 100,           // remaining time shrinks
      };
    }
    const overMs = -remaining;
    return {
      mode: 'over',
      text: '+' + fmt(Math.floor(overMs / 1000)),
      status: '超時',
      pct: Math.min(1, overMs / (OVERTIME_FULL_SECONDS * 1000)) * 100, // full at +00:30
    };
  }

  function renderClock() {
    const c = computeClock();
    const paused = isActive() && !timer.running;
    if (c.text !== lastClock.text) {
      el.clock.textContent = c.text;
      el.clock.setAttribute('aria-label',
        c.mode === 'idle' ? '設定時間 ' + c.text :
        c.mode === 'over' ? '超時 ' + c.text.slice(1) : '剩餘 ' + c.text);
    }
    if (c.mode !== lastClock.mode) el.app.dataset.mode = c.mode;
    if (c.status !== lastClock.status) el.status.textContent = c.status;
    const pct = c.pct.toFixed(2) + '%';
    if (pct !== lastClock.pct) {
      el.dialPie.style.setProperty('--p', pct);
      // A conic-gradient that meets itself at 0° leaves a thin dark seam from the 12 o'clock
      // tick to the center. (Essentially) full circle → plain solid fill instead.
      el.dialPie.classList.toggle('is-full', c.pct >= FULL_PCT);
    }
    if (paused !== lastClock.paused) {
      el.pausedBadge.hidden = !paused;
      el.clockPanel.classList.toggle('is-paused', paused);
    }
    lastClock = { text: c.text, mode: c.mode, status: c.status, paused, pct };
  }

  // ---------- Timer loop & bells ----------
  function checkBells() {
    if (!isActive()) return;
    const overMs = elapsedMs() - state.duration * 1000;

    // 「剩下 20 秒」 voice cue (only if the duration is longer than 20 s, so it's never wrong)
    const lateBy20 = overMs + WARN_SECONDS * 1000;
    if (!timer.spoke20 && lateBy20 >= 0) {
      timer.spoke20 = true;
      if (state.duration > WARN_SECONDS && lateBy20 < LATE_BELL_LIMIT_MS && overMs < 0) {
        Voice.speak('剩下 20 秒', WARN_VOICE_VOLUME);
        announce('剩下 20 秒');
      }
    }

    if (!timer.rang0 && overMs >= 0) {
      timer.rang0 = true;
      if (overMs < LATE_BELL_LIMIT_MS) timeUpCue();
      announce('時間到，開始計算超時');
    }
  }

  function tick() {
    checkBells();
    renderClock();
  }

  function startLoop() {
    if (timer.intervalId === null) timer.intervalId = setInterval(tick, TICK_MS);
  }
  function stopLoop() {
    if (timer.intervalId !== null) {
      clearInterval(timer.intervalId);
      timer.intervalId = null;
    }
  }

  function clearTimer() {
    stopLoop();
    timer.personId = null;
    timer.running = false;
    timer.accumulated = 0;
    timer.runStart = 0;
    timer.rang0 = false;
    timer.spoke20 = false;
    cancelPreview(); // also stops any speech (Voice.stop)
    Wake.sync();
  }

  // ---------- Actions ----------
  function startFor(person) {
    // Starting someone new finishes whoever was speaking (running or paused).
    const prev = currentPerson();
    if (prev && prev.id !== person.id) prev.done = true;

    clearTimer();
    timer.personId = person.id;
    timer.running = true;
    timer.runStart = now();
    person.done = false;

    saveState();
    startLoop();
    Wake.sync();
    render();
    announce(person.name + ' 開始分享，' + fmtShort(state.duration));
  }

  function pause() {
    if (!isActive() || !timer.running) return;
    timer.accumulated = elapsedMs();
    timer.running = false;
    stopLoop();
    Wake.sync();
    render();
    announce('已暫停');
  }

  function resume() {
    if (!isActive() || timer.running) return;
    timer.runStart = now();
    timer.running = true;
    startLoop();
    Wake.sync();
    render();
    announce('繼續計時');
  }

  function endCurrent() {
    const p = currentPerson();
    if (p) p.done = true;
    clearTimer();
    saveState();
    render();
    if (p) announce(p.name + ' 分享結束');
  }

  function resetAll() {
    const anyDone = state.people.some((p) => p.done);
    if ((anyDone || isActive()) && !window.confirm('確定要全部重設嗎？\n所有人都會恢復為「未分享」，計時也會停止。')) {
      return;
    }
    state.people.forEach((p) => { p.done = false; });
    clearTimer();
    saveState();
    render();
    announce('已全部重設');
  }

  function onPersonTap(id) {
    const p = findPerson(id);
    if (!p) return;
    if (p.id === timer.personId) return; // already speaking; use 暫停 / 結束
    if (p.done) {
      // Undo: re-enable without starting the timer
      p.done = false;
      saveState();
      render();
      announce(p.name + ' 已恢復為未分享');
      return;
    }
    startFor(p);
    // A timer just started: hide the list so the dial can grow again.
    setPanelOpen(false);
  }

  function setDuration(sec) {
    if (isActive()) return;
    state.duration = clampDuration(sec);
    saveState();
    render();
  }

  // ---------- Name editing ----------
  function addPerson(name) {
    const n = cleanName(name) || '成員 ' + (state.people.length + 1);
    // New members sit on the side with the fewest people (ties → 前), at the end of that side.
    const p = { id: uid(), name: n, done: false, side: fewestSide(state.people) };
    state.people = sortBySide(state.people.concat(p));
    if (state.editing) state.selectedId = p.id;
    saveState();
    render();
    return p;
  }

  function removePerson(id) {
    const p = findPerson(id);
    if (!p) return;
    if (p.id === timer.personId) {
      if (!window.confirm(p.name + ' 正在分享，確定要刪除嗎？')) return;
      clearTimer();
    }
    state.people = state.people.filter((x) => x.id !== id);
    if (state.selectedId === id) state.selectedId = null;
    saveState();
    render();
  }

  // ▲▼: swap with the neighbour on the SAME side only (the list is kept in side order).
  function movePerson(id, delta) {
    const arr = state.people;
    const i = arr.findIndex((p) => p.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= arr.length || arr[j].side !== arr[i].side) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    state.selectedId = id;
    saveState();
    render();
    // Keep focus on the same control after re-render (or its twin if it just got disabled)
    if (!focusRowControl(id, delta < 0 ? 'up' : 'down')) focusRowControl(id, delta < 0 ? 'down' : 'up');
  }

  // 前/右/後/左 (picked in the side picker): move to the END of the target side;
  // both sides re-number at once.
  function setSide(id, side) {
    const p = findPerson(id);
    if (!p || !isSide(side)) return;
    state.selectedId = id;
    if (p.side !== side) {
      p.side = side;
      state.people = sortBySide(state.people.filter((x) => x !== p).concat(p));
      saveState();
    }
    render();
    focusRowControl(id, 'seat');
    scrollRowIntoView(id);
  }

  function focusRowControl(id, action) {
    const sel = '[data-id="' + id + '"][data-action="' + action + '"]';
    const b = el.people.querySelector(sel);
    if (!b || b.disabled) return false;
    b.focus({ preventScroll: true });
    return true;
  }

  function rowFor(id) {
    return id ? el.people.querySelector('li.edit-row[data-id="' + id + '"]') : null;
  }

  function scrollRowIntoView(id) {
    const row = rowFor(id);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  // Edit mode: one person is "selected" — the row and the seat glow yellow.
  // Class toggles only (no re-render), so a focused name input keeps focus / IME state.
  function setSelected(id) {
    state.selectedId = id;
    el.people.querySelectorAll('li.edit-row').forEach((r) => {
      r.classList.toggle('is-selected', r.dataset.id === id);
    });
    seatEls.forEach((b) => b.classList.toggle('is-selected', state.editing && !!id && b.dataset.id === id));
  }

  function setEditing(on) {
    on = !!on;
    if (on === state.editing) return;
    state.editing = on;
    state.selectedId = null;
    closeSidePicker(false);
    if (!on) closeClearDialog(false);
    if (document.activeElement && el.side.contains(document.activeElement)) document.activeElement.blur();
    render();
  }

  // ---------- Side picker (編輯名單: tap 「前1 ▾」 → 前／右／後／左 ＋ 取消) ----------
  // One picker for the whole list. Wide screens: a popover anchored under the row's
  // seat button (flipped above it when there's no room below), clamped inside the
  // viewport. Phones / no room either way: a full-width bottom sheet.
  const PICKER_SHEET_MAX_W = 520;  // viewport narrower than this → bottom sheet
  const PICKER_MARGIN = 8;
  const picker = { id: null, anchor: null };

  function pickerOpen() { return !el.picker.hidden; }

  function openSidePicker(id, anchor) {
    const p = findPerson(id);
    if (!p || !anchor) return;
    if (pickerOpen()) closeSidePicker(false);
    picker.id = id;
    picker.anchor = anchor;
    const label = seatLabels(state.people).get(id);
    el.pickerTitle.textContent = label + ' ' + p.name + '　坐哪一邊？';
    el.pickerSides.querySelectorAll('button[data-side]').forEach((b) => {
      const on = b.dataset.side === p.side;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-label', '坐' + b.dataset.side + (on ? '（目前）' : ''));
    });
    anchor.setAttribute('aria-expanded', 'true');
    el.pickerBackdrop.hidden = false;
    el.picker.hidden = false;
    positionSidePicker();
    const current = el.pickerSides.querySelector('button.is-on') || el.pickerSides.querySelector('button');
    current.focus({ preventScroll: true });
  }

  // restoreFocus: put focus back on the row's seat button (keyboard / 取消 / Esc).
  function closeSidePicker(restoreFocus) {
    if (!pickerOpen()) return;
    el.picker.hidden = true;
    el.pickerBackdrop.hidden = true;
    el.picker.removeAttribute('data-place');
    el.pickerBackdrop.removeAttribute('data-place');
    const id = picker.id;
    if (picker.anchor) picker.anchor.setAttribute('aria-expanded', 'false');
    picker.id = null;
    picker.anchor = null;
    if (restoreFocus && id) focusRowControl(id, 'seat');
  }

  function positionSidePicker() {
    if (!pickerOpen() || !picker.anchor) return;
    const box = el.picker;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    const a = picker.anchor.getBoundingClientRect();
    let place = vw < PICKER_SHEET_MAX_W ? 'sheet' : 'below';
    box.style.left = box.style.top = '';
    box.dataset.place = place === 'sheet' ? 'sheet' : 'pop';
    if (place !== 'sheet') {
      const w = box.offsetWidth;
      const h = box.offsetHeight;
      let top = a.bottom + PICKER_MARGIN;
      if (top + h > vh - PICKER_MARGIN) {
        top = a.top - PICKER_MARGIN - h;                 // flip above the row
        place = top >= PICKER_MARGIN ? 'above' : 'sheet';
      }
      if (place !== 'sheet') {
        const left = Math.max(PICKER_MARGIN, Math.min(a.left, vw - w - PICKER_MARGIN));
        box.style.left = Math.round(left) + 'px';
        box.style.top = Math.round(top) + 'px';
      }
    }
    if (place === 'sheet') {
      box.dataset.place = 'sheet';
      box.style.left = box.style.top = '';
    }
    el.pickerBackdrop.dataset.place = box.dataset.place;
  }

  function pickSide(side) {
    const id = picker.id;
    if (!id) return;
    const p = findPerson(id);
    closeSidePicker(false);
    if (p && p.side !== side) setSide(id, side);   // re-renders, focuses 「右3 ▾」
    else focusRowControl(id, 'seat');              // current side: just close
  }

  // After a re-render the anchor button is new: re-attach (or close if the row is gone).
  function syncSidePicker() {
    if (!pickerOpen()) return;
    const b = state.editing && picker.id
      ? el.people.querySelector('[data-id="' + picker.id + '"][data-action="seat"]') : null;
    if (!b) { closeSidePicker(false); return; }
    picker.anchor = b;
    b.setAttribute('aria-expanded', 'true');
    positionSidePicker();
  }

  // ---------- 成員全部重設 confirm dialog ----------
  // Clears ALL names (and therefore all seats). Distinct from resetAll(), which only
  // clears 已分享 status and never touches the names list.
  let dialogReturnFocus = null;

  function openClearDialog() {
    if (!state.people.length || !el.clearDialog.hidden) return;
    closeSidePicker(false);
    dialogReturnFocus = document.activeElement;
    el.clearDialog.hidden = false;
    el.app.setAttribute('aria-hidden', 'true');
    if ('inert' in el.app) el.app.inert = true;
    el.clearNo.focus(); // safe default
  }

  function closeClearDialog(confirmed) {
    if (el.clearDialog.hidden) return;
    el.clearDialog.hidden = true;
    el.app.removeAttribute('aria-hidden');
    if ('inert' in el.app) el.app.inert = false;
    if (confirmed) {
      clearTimer();
      state.people = [];
      state.selectedId = null;
      saveState();
      render();
      announce('已清除全部成員');
    }
    const back = dialogReturnFocus;
    dialogReturnFocus = null;
    if (back && document.contains(back) && !back.disabled && back.offsetParent !== null) back.focus();
    else if (state.editing) el.doneBtn.focus();
  }

  // ---------- Rendering ----------
  function renderList() {
    const frag = document.createDocumentFragment();
    el.people.classList.toggle('is-editing', state.editing);
    const labels = seatLabels(state.people);

    if (state.editing) {
      // Grouped by side: 「前（4 人）」 header, then that side's rows in seat order
      const counts = sideCounts(state.people);
      SIDES.forEach((side) => {
        const head = document.createElement('li');
        head.className = 'side-head';
        head.textContent = side + '（' + counts[side] + ' 人）';
        frag.append(head);
        const members = state.people.filter((p) => p.side === side);
        members.forEach((p, k) => {
          frag.append(editRow(p, labels.get(p.id), k === 0, k === members.length - 1));
        });
      });
    } else {
      state.people.forEach((p) => {
        const li = document.createElement('li');
        const isCurrent = p.id === timer.personId;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'person' + (isCurrent ? ' is-current' : '') + (p.done ? ' is-done' : '');
        btn.dataset.id = p.id;

        const num = document.createElement('span');
        num.className = 'person-num';
        num.setAttribute('aria-hidden', 'true');
        num.textContent = labels.get(p.id);

        let tag;
        let label;
        if (isCurrent) {
          tag = timer.running ? '▶︎ 分享中' : '❚❚ 已暫停';
          label = p.name + '，' + (timer.running ? '分享中' : '已暫停');
          btn.setAttribute('aria-current', 'true');
        } else if (p.done) {
          tag = '✓ 已分享';
          label = p.name + '，已分享，點一下恢復為未分享';
        } else {
          tag = '點一下開始';
          label = p.name + '，未分享，點一下開始計時';
        }
        btn.setAttribute('aria-label', labels.get(p.id) + '，' + label);

        const body = document.createElement('span');
        body.className = 'person-body';
        const name = document.createElement('span');
        name.className = 'person-name';
        name.textContent = p.name;
        const tagEl = document.createElement('span');
        tagEl.className = 'person-tag';
        tagEl.textContent = tag;
        body.append(name, tagEl);

        btn.append(num, body);
        li.append(btn);
        frag.append(li);
      });
    }

    el.people.replaceChildren(frag);
    el.emptyMsg.hidden = state.people.length > 0 || state.editing;
    syncSidePicker();
  }

  // Edit row: [前1 ▾] [   name   ] [▲][▼][✕]
  // The seat button opens the side picker (前／右／後／左); ▲▼ reorder within the side.
  function editRow(p, label, first, last) {
    const li = document.createElement('li');
    li.className = 'edit-row' + (p.id === state.selectedId ? ' is-selected' : '');
    li.dataset.id = p.id;

    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'btn seat-pick';
    badge.dataset.id = p.id;
    badge.dataset.action = 'seat';
    badge.setAttribute('aria-label', label + '，變更座位方向');
    badge.setAttribute('aria-haspopup', 'dialog');
    badge.setAttribute('aria-expanded', 'false');
    badge.setAttribute('aria-controls', 'sidePicker');
    const badgeText = document.createElement('span');
    badgeText.className = 'seat-pick-label';
    badgeText.textContent = label;
    const caret = document.createElement('span');
    caret.className = 'seat-pick-caret';
    caret.setAttribute('aria-hidden', 'true');
    caret.textContent = '▾';
    badge.append(badgeText, caret);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text-input';
    input.value = p.name;
    input.maxLength = MAX_NAME_LEN;
    input.dataset.id = p.id;
    input.setAttribute('aria-label', '座位 ' + label + ' 姓名');
    input.setAttribute('enterkeyhint', 'done');
    input.setAttribute('autocomplete', 'off');

    const up = iconButton('▲', '上移 ' + p.name, p.id, 'up', first);
    const down = iconButton('▼', '下移 ' + p.name, p.id, 'down', last);
    const del = iconButton('✕', '刪除 ' + p.name, p.id, 'delete', false);
    del.classList.add('btn-danger');

    li.append(badge, input, up, down, del);
    return li;
  }

  function iconButton(text, label, id, action, disabled) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-secondary btn-icon-only btn-' + action;
    b.textContent = text;
    b.dataset.id = id;
    b.dataset.action = action;
    b.disabled = disabled;
    b.setAttribute('aria-label', label);
    return b;
  }

  const EDIT_HINT = '點座號選前右後左，再用 ▲▼ 排順序';

  function renderControls() {
    const active = isActive();
    const p = currentPerson();

    const allDone = state.people.length > 0 && state.people.every((x) => x.done);
    el.speakerName.textContent = p ? p.name
      : !state.people.length ? '請先新增名單'
      : allDone ? '全部分享完畢'
      : '點選名字開始';

    el.pauseBtn.disabled = !active;
    el.endBtn.disabled = !active;
    const showResume = active && !timer.running;
    el.pauseIcon.textContent = showResume ? '▶︎' : '❚❚';
    el.pauseText.textContent = showResume ? '繼續' : '暫停';
    el.pauseBtn.setAttribute('aria-label', showResume ? '繼續計時' : '暫停計時');
    el.endBtn.setAttribute('aria-label', p ? '結束 ' + p.name + ' 的分享' : '結束');

    const doneCount = state.people.filter((x) => x.done).length;
    el.progress.textContent = '已分享 ' + doneCount + '/' + state.people.length;
    el.toggleProgress.textContent = el.progress.textContent;

    // Edit mode swaps the list header: 「編輯名單（排座位）」 + ✓ 完成; 成員全部重設 below the list
    el.app.dataset.editing = String(state.editing);
    el.listHead.hidden = state.editing;
    el.listActions.hidden = state.editing;
    el.editHead.hidden = !state.editing;
    el.editFoot.hidden = !state.editing;
    el.addForm.hidden = !state.editing;
    el.clearMembersBtn.disabled = !state.people.length;

    // 座位圖 hint folded into the list hint (keeps the open panel compact)
    const seatHint = !state.showSeats ? ''
      : !seatsFitScreen() ? '（螢幕較小，座位圖自動隱藏）'
      : '收合面板後也可點座位開始。';
    el.listHint.textContent = state.editing
      ? EDIT_HINT
      : '點名字開始計時；點灰色名字可恢復為未分享。' + seatHint;

    el.seatsToggle.setAttribute('aria-checked', String(state.showSeats));
    el.seatsToggle.setAttribute('aria-label', '座位圖' +
      (state.showSeats && !seatsFitScreen() ? '（螢幕較小，自動隱藏）' : ''));
  }

  function renderDuration() {
    const m = Math.floor(state.duration / 60);
    const s = state.duration % 60;
    el.durationMin.textContent = String(m);
    el.durationSec.textContent = String(s).padStart(2, '0');
    el.durationPreview.textContent = m + ' 分 ' + s + ' 秒';

    // Settings are collapsed while someone is speaking (running, paused or overtime),
    // and while editing the list (the edit panel has no time settings).
    const locked = isActive();
    el.settingsCard.hidden = locked || state.editing;
    el.durationGroup.querySelectorAll('button[data-step]').forEach((b) => {
      const step = Number(b.dataset.step);
      b.disabled = locked ||
        (step < 0 && state.duration <= MIN_DURATION) ||
        (step > 0 && state.duration >= MAX_DURATION);
    });
    el.presets.querySelectorAll('button').forEach((b) => {
      b.disabled = locked;
      const active = Number(b.dataset.preset) === state.duration;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-pressed', String(active));
    });
  }

  function render() {
    renderPanel();
    renderControls();
    renderList();
    renderDuration();
    renderClock();
    updateSeats();
  }

  // ---------- Seating chart ----------
  // One card per person, on the person's side. Cards spread evenly along their edge and
  // shrink when a side has more people:
  //   前 top (前1 at the left) · 右 right (右1 at the top) ·
  //   後 bottom (後1 at the left) · 左 left (左1 at the top).
  // Normal mode: seats at the screen edges, the dial as large as fits in the middle.
  // 編輯名單 mode: the same chart, drawn in the area left of (or above) the edit panel.
  const seatEls = [];

  function makeSeat() {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seat';
    b.hidden = true;
    const name = document.createElement('span');
    name.className = 'seat-name';
    const num = document.createElement('span');
    num.className = 'seat-num';
    num.setAttribute('aria-hidden', 'true');
    b.append(name, num);
    el.seats.append(b);
    seatEls.push(b);
    return b;
  }

  // Phones (portrait or landscape) are too cramped: the chart auto-hides there.
  const SEAT_MIN_VIEWPORT = 560;
  const SEAT_MIN_DIAL = 300;
  const EDIT_MIN_DIAL = 150;
  function seatsFitScreen() {
    return Math.min(window.innerWidth, window.innerHeight) >= SEAT_MIN_VIEWPORT;
  }
  // Must match the CSS landscape breakpoint (clock left / panel right)
  const landscapeMQ = window.matchMedia('(orientation: landscape) and (min-width: 560px)');
  // 編輯名單 chart: tablets / laptops only (landscape ≥ 900 wide, portrait ≥ 700 wide)
  function editChartFits() {
    if (!seatsFitScreen()) return false;
    return landscapeMQ.matches ? window.innerWidth >= 900 : window.innerWidth >= 700;
  }

  // Rough text width in em: CJK ≈ 1em, Latin / digits ≈ 0.6em.
  function nameUnits(name) {
    let u = 0;
    for (const ch of name) u += /[⺀-鿿豈-﫿＀-￯]/.test(ch) ? 1 : 0.62;
    return Math.max(1, u);
  }

  function renderSeatStates() {
    const labels = seatLabels(state.people);
    while (seatEls.length < state.people.length) makeSeat();
    seatEls.forEach((b, i) => {
      const p = state.people[i];
      if (!p) {
        b.hidden = true;
        b.disabled = true;
        delete b.dataset.id;
        return;
      }
      const label = labels.get(p.id);
      const isCurrent = p.id === timer.personId;
      b.hidden = false;
      b.disabled = false;
      b.dataset.id = p.id;
      b.className = 'seat seat-' + SIDE_CLASS[p.side];
      b.classList.toggle('is-current', isCurrent);
      b.classList.toggle('is-done', p.done && !isCurrent && !state.editing);
      b.classList.toggle('is-selected', state.editing && p.id === state.selectedId);
      if (isCurrent) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
      const nameEl = b.firstChild;
      if (nameEl.dataset.name !== p.name) setSeatName(nameEl, p.name);
      const numEl = b.lastChild;
      if (numEl.dataset.label !== label) {
        numEl.dataset.label = label;
        const n = document.createElement('span');
        n.className = 'seat-n';
        n.textContent = label.slice(1);
        numEl.replaceChildren(label[0], n);
      }
      b.setAttribute('aria-label', label + '，' + p.name + '，' +
        (state.editing ? '點一下選取這一列'
          : isCurrent ? (timer.running ? '分享中' : '已暫停')
          : p.done ? '已分享，點一下恢復為未分享' : '點一下開始計時'));
    });
  }

  // Seat names: in the vertical side cards, 1–2 digit runs (「成員 12」) sit upright
  // in one cell (tate-chu-yoko); the spans have no effect in horizontal cards.
  function setSeatName(nameEl, name) {
    nameEl.dataset.name = name;
    nameEl.replaceChildren();
    name.split(/(\d+|\s+)/).forEach((part) => {
      if (!part) return;
      const digits = /^\d{1,2}$/.test(part);
      if (digits || /^\s+$/.test(part)) {
        const t = document.createElement('span');
        t.className = digits ? 'tcy' : 'sp'; // .sp: narrow gap in vertical text
        t.textContent = digits ? part : ' ';
        nameEl.append(t);
      } else {
        nameEl.append(part);
      }
    });
  }

  // n cards spread evenly over [lo, hi]: equal slots, each card centered in its slot.
  // Returns [[start, length], …] in slot order (low → high).
  function spread(n, lo, hi, maxLen, gap) {
    if (!n) return [];
    const slot = (hi - lo) / n;
    const len = Math.min(maxLen, slot - gap);
    return Array.from({ length: n }, (_, k) => [lo + slot * (k + 0.5) - len / 2, len]);
  }

  // Seat geometry inside region R = {x, y, w, h} (stage coordinates).
  // opt: { s: scale, edit: bool, bar: {lo, hi, bottom} | null (logo / ☰ obstacles, R-relative),
  //        dialCap, minDial }. Returns null when it does not fit.
  function computeSeatLayout(R, opt) {
    const W = R.w;
    const H = R.h;
    const s = opt.s;
    const c = sideCounts(state.people);
    const nT = c['前'];
    const nR = c['右'];
    const nB = c['後'];
    const nL = c['左'];

    const m = Math.max(4, 6 * s);                       // distance from the region edge
    const gapX = 10 * s;                                // between top / bottom cards
    const gapY = 14 * s;                                // between side cards
    const dGap = 6 * s;                                 // clearance around the dial
    const sideW = (opt.edit ? 86 : 110) * s;            // side card width
    const rowH = (opt.edit ? 76 : 80) * s;              // top / bottom card height
    const maxRowW = (opt.edit ? 130 : 170) * s;         // top / bottom card max width
    const maxSideH = (opt.edit ? 190 : 210) * s;        // side card max height

    // Top / bottom rows span the room between the side columns
    const hasCols = nR + nL > 0;
    const colInset = hasCols ? m + sideW + gapX : m;
    const rowLo = colInset;
    const rowHi = W - colInset;

    let topY = m;
    let tLo = rowLo;
    let tHi = rowHi;
    let clearTop = m;                                   // nothing may go above this (logo / ☰)
    const bar = opt.bar;
    if (bar) {
      clearTop = bar.bottom + 8 * s;
      // Same line as the logo / ☰ (between them, centered) if the cards stay wide enough;
      // otherwise just below the top bar.
      const half = Math.min(W / 2 - Math.max(rowLo, bar.lo), Math.min(rowHi, bar.hi) - W / 2);
      const w = nT ? Math.min(maxRowW, (2 * half) / nT - gapX) : 0;
      if (nT && half > 0 && w >= Math.min(maxRowW, 90 * s)) {
        tLo = W / 2 - half;
        tHi = W / 2 + half;
      } else {
        topY = clearTop;
      }
    }
    // Crowded row (many people on one side): use the full width, corners included —
    // the side columns only live between the two rows, so the corners are free.
    const cramped = (n, lo, hi) => n && (hi - lo) / n - gapX < 64 * s;
    if (cramped(nT, tLo, tHi)) {   // (never on the logo / ☰ line: that needs ≥ 90px cards)
      tLo = m;
      tHi = W - m;
    }
    const bLo = cramped(nB, rowLo, rowHi) ? m : rowLo;
    const top = spread(nT, tLo, tHi, maxRowW, gapX);
    const bottom = spread(nB, bLo, W - bLo, maxRowW, gapX);
    if (top.concat(bottom).some(([, w]) => w < 34)) return null;
    const bottomY = H - m - rowH;

    // Dial: the largest square between the rows and the side columns
    const bandTop = nT ? topY + rowH + dGap : clearTop;
    const bandBottom = nB ? bottomY - dGap : H - m;
    const dial = Math.floor(Math.min(
      bandBottom - bandTop,
      W - 2 * (hasCols ? m + sideW + dGap : m),
      opt.dialCap || Infinity));
    if (dial < opt.minDial) return null;
    const dialX = (W - dial) / 2;
    const dialY = (bandTop + bandBottom - dial) / 2;

    // Side columns: centered on the dial, spread over at most the band between the rows
    const cy = dialY + dial / 2;
    const colTop = Math.max(bandTop, clearTop);
    const colBottom = bandBottom;
    const column = (n) => {
      if (!n) return [];
      const half = Math.min(cy - colTop, colBottom - cy, Math.max(dial / 2, (n * (maxSideH + gapY)) / 2));
      return spread(n, cy - half, cy + half, maxSideH, gapY);
    };
    const right = column(nR);
    const left = column(nL);
    if (right.concat(left).some(([, h]) => h < 40)) return null;

    // Rects in list (= side) order, index 1 first (v11, TaiChi):
    // 前 left→right, 右 top→bottom, 後 left→right (後1 leftmost), 左 top→bottom (左1 topmost).
    const rects = [];
    top.forEach(([x, w]) => rects.push([x, topY, w, rowH]));
    right.forEach(([y, h]) => rects.push([W - m - sideW, y, sideW, h]));
    bottom.forEach(([x, w]) => rects.push([x, bottomY, w, rowH]));
    left.forEach(([y, h]) => rects.push([m, y, sideW, h]));
    return {
      s,
      edit: !!opt.edit,
      rects: rects.map(([x, y, w, h]) => [R.x + x, R.y + y, w, h]),
      dial,
      dialX: R.x + dialX,
      dialY: R.y + dialY,
    };
  }

  // Normal mode: the whole screen; the logo (top-left) and ☰ (top-right) are obstacles.
  function layoutNormal(stage) {
    const W = stage.width;
    const H = stage.height;
    if (Math.min(W, H) < SEAT_MIN_VIEWPORT) return null;
    const landscape = W >= H;
    const s = Math.min(1.6, Math.max(0.6, landscape
      ? Math.min(W / 1180, H / 820)
      : Math.min(W / 820, H / 1180)));
    const logo = el.logo.getBoundingClientRect();
    const tog = el.panelToggle.getBoundingClientRect();
    const bar = {
      lo: logo.right - stage.left + 10,
      hi: tog.left - stage.left - 10,
      bottom: Math.max(logo.bottom, tog.bottom) - stage.top,
    };
    return computeSeatLayout({ x: 0, y: 0, w: W, h: H }, { s, bar, minDial: SEAT_MIN_DIAL });
  }

  // 編輯名單 mode: landscape → the area left of the edit panel (under the logo);
  // portrait tablets → a band under the top bar, the panel is pushed below it.
  function layoutEdit(stage) {
    const W = stage.width;
    const H = stage.height;
    const logo = el.logo.getBoundingClientRect();
    const tog = el.panelToggle.getBoundingClientRect();
    const padL = Math.max(8, logo.left - stage.left);
    let R;
    if (landscapeMQ.matches) {
      const side = el.side.getBoundingClientRect();
      const y = logo.bottom - stage.top + 6;
      R = { x: padL, y, w: side.left - stage.left - padL - 12, h: H - y - 10 };
      el.app.style.removeProperty('--edit-chart-h');
    } else {
      const y = Math.max(logo.bottom, tog.bottom) - stage.top + 6;
      const h = Math.round(Math.min(H * 0.45, W * 0.66));
      R = { x: padL, y, w: W - 2 * padL, h };
      el.app.style.setProperty('--edit-chart-h', h + 'px');
    }
    if (R.w < 360 || R.h < 360) return null;
    const short = Math.min(R.w, R.h);
    const s = Math.min(1.4, Math.max(0.6, short / 560));
    // ≈290px dial at 1180×820 (left area ≈ 560 wide), centered with the seats around it
    return computeSeatLayout(R, {
      s, edit: true, bar: null, dialCap: Math.round(short * 0.52), minDial: EDIT_MIN_DIAL,
    });
  }

  function seatMode() {
    if (state.editing && panelOpen) return editChartFits() ? 'edit' : null;
    return !panelOpen && state.showSeats ? 'normal' : null;
  }

  function updateSeats() {
    renderSeatStates();
    const mode = seatMode();
    let L = null;
    if (mode) {
      // Show first: the stage (and, in edit mode, the panel position) must be measurable
      el.seats.hidden = false;
      el.app.dataset.seats = 'on';
      el.app.dataset.editchart = mode === 'edit' ? 'on' : 'off';
      const stage = el.seats.getBoundingClientRect();
      L = mode === 'edit' ? layoutEdit(stage) : layoutNormal(stage);
      if (L) {
        el.app.style.setProperty('--dial-seats', L.dial + 'px');
        el.app.style.setProperty('--dial-x', (stage.left + L.dialX) + 'px');
        el.app.style.setProperty('--dial-y', (stage.top + L.dialY) + 'px');
        state.people.forEach((p, i) => {
          const b = seatEls[i];
          const [x, y, w, h] = L.rects[i];
          b.style.left = x + 'px';
          b.style.top = y + 'px';
          b.style.width = w + 'px';
          b.style.height = h + 'px';
          // Big names, shrunk only when long; side cards are vertical (vertical-rl)
          const vertical = p.side === '右' || p.side === '左';
          const units = nameUnits(b.firstChild.dataset.name || '');
          const base = (vertical ? (L.edit ? 30 : 36) : (L.edit ? 24 : 30)) * L.s;
          const room = vertical ? h - 24 * L.s : w - 18 * L.s;
          const fit = vertical ? room / units - 4 * L.s : room / units; // vertical: letter-spacing
          b.style.setProperty('--seat-font', Math.max(13, Math.min(base, fit)).toFixed(1) + 'px');
          b.style.setProperty('--seat-num-font', Math.max(11, 14 * L.s).toFixed(1) + 'px');
        });
      }
    }
    el.app.dataset.seats = L ? 'on' : 'off';
    el.app.dataset.editchart = L && mode === 'edit' ? 'on' : 'off';
    if (!L) el.app.style.removeProperty('--edit-chart-h');
    el.seats.hidden = !L;
  }

  let seatLayoutQueued = false;
  function queueSeatLayout() {
    if (seatLayoutQueued) return;
    seatLayoutQueued = true;
    requestAnimationFrame(() => {
      seatLayoutQueued = false;
      updateSeats();
      renderControls(); // refreshes the 座位圖 hint (fits / auto-hidden)
    });
  }

  // ---------- Events ----------
  el.people.addEventListener('click', (e) => {
    const target = e.target.closest('button');
    if (!target || !el.people.contains(target)) return;
    const id = target.dataset.id;
    if (state.editing) {
      const action = target.dataset.action;
      if (action === 'delete') removePerson(id);
      else if (action === 'up') movePerson(id, -1);
      else if (action === 'down') movePerson(id, 1);
      else if (action === 'seat') {
        if (picker.id === id && pickerOpen()) closeSidePicker(true);
        else openSidePicker(id, target);
      }
    } else {
      onPersonTap(id);
    }
  });

  // Rename in place without re-rendering (keeps keyboard focus)
  el.people.addEventListener('input', (e) => {
    const input = e.target;
    if (!input.matches('input.text-input')) return;
    const p = findPerson(input.dataset.id);
    if (!p) return;
    const n = cleanName(input.value);
    if (n && n !== p.name) {
      p.name = n;
      saveState();
      if (p.id === timer.personId) el.speakerName.textContent = n;
      updateSeats(); // the chart follows the name as it is typed
    }
  });

  // Edit mode: touching / focusing a row selects it (its seat glows in the chart)
  el.people.addEventListener('focusin', (e) => {
    if (!state.editing) return;
    const row = e.target.closest('li.edit-row');
    if (row && row.dataset.id !== state.selectedId) setSelected(row.dataset.id);
  });
  el.people.addEventListener('pointerdown', (e) => {
    if (!state.editing) return;
    const row = e.target.closest('li.edit-row');
    if (row && row.dataset.id !== state.selectedId) setSelected(row.dataset.id);
  });
  el.people.addEventListener('change', (e) => {
    const input = e.target;
    if (!input.matches('input.text-input')) return;
    const p = findPerson(input.dataset.id);
    if (p) input.value = p.name; // empty input reverts to the last valid name
  });
  // IME (注音/拼音) composition tracking: the Enter that confirms a composition
  // must not blur/submit, and Safari may fire keydown/submit right after compositionend.
  const IME_SETTLE_MS = 100;
  let composing = false;
  let compositionEndedAt = 0;
  const onCompStart = () => { composing = true; };
  const onCompEnd = () => { composing = false; compositionEndedAt = Date.now(); };
  const isImeBusy = (e) =>
    composing || (e && (e.isComposing || e.keyCode === 229)) ||
    Date.now() - compositionEndedAt < IME_SETTLE_MS;
  [el.addInput, el.people].forEach((node) => {
    node.addEventListener('compositionstart', onCompStart);
    node.addEventListener('compositionend', onCompEnd);
  });

  el.people.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.matches('input.text-input')) return;
    if (isImeBusy(e)) return;
    e.target.blur();
  });

  el.addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && isImeBusy(e)) e.preventDefault(); // don't submit while composing
  });

  const DUP_ADD_MS = 500;
  let lastAdded = { name: null, at: 0 };
  el.addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (isImeBusy()) return;
    const name = cleanName(el.addInput.value);
    const t = Date.now();
    if (name === lastAdded.name && t - lastAdded.at < DUP_ADD_MS) {
      el.addInput.value = '';
      return;
    }
    lastAdded = { name, at: t };
    const p = addPerson(name);
    el.addInput.value = '';
    el.addInput.focus();
    scrollRowIntoView(p.id); // new member: end of the side with the fewest people (selected)
  });

  el.editBtn.addEventListener('click', () => {
    setEditing(true);
    el.doneBtn.focus({ preventScroll: true });
  });
  el.doneBtn.addEventListener('click', () => {
    setEditing(false);
    el.editBtn.focus({ preventScroll: true });
  });

  el.panelToggle.addEventListener('click', () => setPanelOpen(!panelOpen));

  // Tapping a seat = tapping that name in the list (works with the panel collapsed).
  // In 編輯名單 it only selects that person's row (never starts the timer).
  el.seats.addEventListener('click', (e) => {
    const b = e.target.closest('button.seat');
    if (!b || b.disabled || !b.dataset.id) return;
    if (state.editing) {
      setSelected(b.dataset.id);
      const row = rowFor(b.dataset.id);
      if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }
    onPersonTap(b.dataset.id);
    if (e.detail > 0) b.blur(); // pointer tap: keep Space = pause/resume working
  });

  // 座位圖 on/off (persisted with the list)
  el.seatsToggle.addEventListener('click', () => {
    state.showSeats = !state.showSeats;
    saveState();
    render();
    announce(state.showSeats ? '座位圖已開啟' : '座位圖已關閉');
  });

  window.addEventListener('resize', queueSeatLayout);
  window.addEventListener('orientationchange', queueSeatLayout);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', queueSeatLayout);
  if (el.logo && !el.logo.complete) el.logo.addEventListener('load', queueSeatLayout);

  el.pauseBtn.addEventListener('click', () => { timer.running ? pause() : resume(); });
  el.endBtn.addEventListener('click', endCurrent);
  el.resetBtn.addEventListener('click', resetAll);
  el.clearMembersBtn.addEventListener('click', openClearDialog);
  el.clearYes.addEventListener('click', () => closeClearDialog(true));
  el.clearNo.addEventListener('click', () => closeClearDialog(false));
  // Focus can't wander behind the dialog (fallback where `inert` is unsupported)
  document.addEventListener('focusin', (e) => {
    if (!el.clearDialog.hidden && !el.clearDialog.contains(e.target)) el.clearNo.focus();
  });
  // Tap on the dimmed backdrop = 否
  el.clearDialog.addEventListener('click', (e) => { if (e.target === el.clearDialog) closeClearDialog(false); });
  // Side picker: big 前／右／後／左, 取消, tap outside (the backdrop) = cancel.
  el.pickerSides.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-side]');
    if (b) pickSide(b.dataset.side);
  });
  el.pickerCancel.addEventListener('click', () => closeSidePicker(true));
  el.pickerBackdrop.addEventListener('click', (e) => {
    const prevId = picker.id;
    closeSidePicker(false);
    // Tapped another row's 「右2 ▾」 through the backdrop → open that one right away
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const b = under && under.closest('button.seat-pick');
    if (b && state.editing && b.dataset.id !== prevId) openSidePicker(b.dataset.id, b);
  });
  // Keep the popover attached to its row while the panel / page scrolls or resizes
  document.addEventListener('scroll', () => { if (pickerOpen()) positionSidePicker(); }, true);
  window.addEventListener('resize', () => { if (pickerOpen()) positionSidePicker(); });

  // 試音量大小: preview all timer sounds (「剩下 20 秒」 → 叮咚 → 「時間到」)
  el.testBellBtn.addEventListener('click', previewSounds);

  // Clock-style stepper (minutes ±60 s, seconds ±5 s; carry/borrow via total seconds,
  // clamped to 0:05–59:55) and presets
  el.durationGroup.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-step]');
    if (b && !b.disabled) setDuration(state.duration + Number(b.dataset.step));
  });

  el.presets.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-preset]');
    if (b) setDuration(Number(b.dataset.preset));
  });

  // Keyboard shortcuts on desktop: Space = pause/resume
  document.addEventListener('keydown', (e) => {
    // 成員全部重設 dialog: Esc = 否, Tab stays on 是 / 否, nothing else reacts
    if (!el.clearDialog.hidden) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeClearDialog(false);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        (document.activeElement === el.clearNo ? el.clearYes : el.clearNo).focus();
      }
      return;
    }
    // Side picker: Esc = 取消, Tab cycles inside it, ←→ move between 前／右／後／左
    if (pickerOpen()) {
      const items = Array.from(el.picker.querySelectorAll('button'));
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSidePicker(true);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const n = items.length;
        items[((i < 0 ? 0 : i + (e.shiftKey ? -1 : 1)) + n) % n].focus();
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && i >= 0 && i < 4) {
        e.preventDefault();
        items[(i + (e.key === 'ArrowLeft' ? 3 : 1)) % 4].focus();
      }
      return;
    }
    // Esc closes the 名單／設定 panel (but not while typing a name / composing)
    if (e.key === 'Escape' && panelOpen && !(e.target && e.target.matches('input, textarea')) && !isImeBusy(e)) {
      setPanelOpen(false);
      el.panelToggle.focus();
      return;
    }
    if (e.target && (e.target.matches('input, textarea, button'))) return;
    if (e.code === 'Space' && isActive()) {
      e.preventDefault();
      timer.running ? pause() : resume();
    }
  });

  // Visibility / lifecycle
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (Bell.ctx && Bell.ctx.state !== 'running') Bell.ctx.resume().catch(() => {});
      tick();
    }
    Wake.sync();
  });
  window.addEventListener('pagehide', () => {
    Wake.release();
    saveState();
  });
  window.addEventListener('pageshow', () => { Wake.sync(); tick(); });

  // Keep other tabs in sync if names change there (desktop)
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY || isActive()) return;
    const s = loadState();
    state.people = s.people;
    state.duration = s.duration;
    state.showSeats = s.showSeats;
    if (state.selectedId && !findPerson(state.selectedId)) state.selectedId = null;
    render();
  });

  // ---------- Service worker ----------
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js').catch(() => { /* offline support unavailable */ });
    });
  }

  render();
})();
