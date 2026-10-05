/* Beamly UI controller, theme manager, peer selection logic */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const state = {
    myIp: null,
    queue: [],
    target: null,
    sending: false,
    config: null,
  };

  const ui = {
    connBadge: $("connBadge"),
    connText: $("connText"),
    myIp: $("myIp"),
    radar: $("radar"),
    radarHint: $("radarHint"),
    peerList: $("peerList"),
    dropzone: $("dropzone"),
    dropTitle: $("dropTitle"),
    dropSub: $("dropSub"),
    fileInput: $("fileInput"),
    queueList: $("queueList"),
    limitChip: $("limitChip"),
    sizeNote: $("sizeNote"),
    sendDock: $("sendDock"),
    dockSummary: $("dockSummary"),
    dockTarget: $("dockTarget"),
    dockSendBtn: $("dockSendBtn"),
    dockSendLabel: $("dockSendLabel"),
    toast: $("toast"),
    toastTitle: $("toastTitle"),
    toastMsg: $("toastMsg"),
    toastActions: $("toastActions"),
    toastTimerBar: $("toastTimerBar"),
    progressOverlay: $("progressOverlay"),
    progressRole: $("progressRole"),
    progressName: $("progressName"),
    progressSub: $("progressSub"),
    progressPct: $("progressPct"),
    progressEta: $("progressEta"),
    progressBytes: $("progressBytes"),
    progressSpeed: $("progressSpeed"),
    progressRing: $("progressRing"),
    progressCancelBtn: $("progressCancelBtn"),
    progressCancelAction: $("progressCancelAction"),
  };

  const fmtBytes = (bytes) => {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
  };

  const fmtSpeed = (bps) => `${fmtBytes(bps)}/s`;

  /* ---- Theme: system preference by default, manual override wins ----
     Default theme strictly matches browser preference out of the box. */
  let followSystemTheme = true;
  let themeTransitionTimer = null;

  function applyTheme(dark, animate = true) {
    const doApply = () => {
      document.documentElement.classList.toggle("dark", dark);
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", dark ? "#030712" : "#f8fafc");
    };

    if (!animate) {
      doApply();
      return;
    }

    // Silk-smooth scoped CSS transition without layout thrashing
    document.documentElement.classList.add("theme-transitioning");
    doApply();

    clearTimeout(themeTransitionTimer);
    themeTransitionTimer = setTimeout(() => {
      document.documentElement.classList.remove("theme-transitioning");
    }, 450);
  }

  function initTheme() {
    let stored = null;
    try { stored = localStorage.getItem("beamly-theme-v2"); } catch (e) { /* private mode */ }

    // Beamly signature aesthetic is Dark mode by default unless explicitly set to "light"
    const isDark = stored !== "light";
    applyTheme(isDark, false);

    const toggleBtn = $("themeToggle");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => {
        const currentlyDark = document.documentElement.classList.contains("dark");
        const nextDark = !currentlyDark;
        applyTheme(nextDark, true);
        try { localStorage.setItem("beamly-theme-v2", nextDark ? "dark" : "light"); } catch (e) { /* private mode */ }
      });
    }
  }

  /* ---- Luxury acoustic sound engine (Web Audio synthesis) & Mobile Haptics ----
     Warm acoustic filtered harmonics with soft exponential attack and
     silky decay envelopes — calm, smooth, organic (no harsh digital transients).
     Full mobile browser unlock for background / async events (Safari & Chrome). */
  let audioCtx = null;
  let isAudioUnlocked = false;
  let lastChimeTime = 0;
  let lastChimeType = "";

  function getAudioContext() {
    if (audioCtx && audioCtx.state !== "closed") {
      return audioCtx;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    } catch (e) {
      audioCtx = null;
    }
    return audioCtx;
  }

  function ensureAudio() {
    const ctx = getAudioContext();
    if (!ctx) return null;
    if (ctx.state === "suspended" || ctx.state === "interrupted") {
      ctx.resume().catch(() => {});
    }
    return ctx;
  }

  /* Robust mobile haptic vibration feedback */
  function triggerHaptic(type = "notice") {
    if (typeof navigator === "undefined" || !navigator.vibrate) return;
    try {
      switch (type) {
        case "send_start":
        case "confirm":
          navigator.vibrate([45]); // Clean crisp confirmation tap
          break;
        case "cancel":
        case "decline":
          navigator.vibrate([60, 45, 60]); // Distinct double alert pulse
          break;
        case "send_complete":
        case "success":
          navigator.vibrate([60, 40, 70, 40, 120]); // Celebratory completion rhythm
          break;
        case "incoming":
          navigator.vibrate([100, 60, 100]); // Attention double-buzz
          break;
        case "notice":
        default:
          navigator.vibrate([25]); // Light tactile tick
          break;
      }
    } catch (_) {}
  }

  /* One-time mobile audio priming: plays a silent 1-sample buffer during a user gesture
     to permanently grant audio playback privileges to the session (essential for iOS Safari). */
  function unlockAudio() {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === "suspended" || ctx.state === "interrupted") {
      ctx.resume().catch(() => {});
    }
    if (!isAudioUnlocked) {
      try {
        const buffer = ctx.createBuffer(1, 1, 22050);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.start(0);
        isAudioUnlocked = true;
      } catch (_) {}
    }
  }

  function playChime(type = "notice") {
    // Mobile tactile feedback matching the sound event
    triggerHaptic(type);

    const now = performance.now();
    if (type === lastChimeType && now - lastChimeTime < 180) {
      return; // Debounce rapid duplicate calls
    }
    lastChimeTime = now;
    lastChimeType = type;

    const ctx = ensureAudio();
    if (!ctx) return;

    const render = () => {
      try {
        const t0 = ctx.currentTime + 0.015;

        // Master acoustic filter: warm low-pass removing harsh digital transients
        const filter = ctx.createBiquadFilter();
        filter.type = "lowpass";

        const masterGain = ctx.createGain();
        filter.connect(masterGain);
        masterGain.connect(ctx.destination);

        if (type === "send_complete" || type === "success") {
          // Ultra-calm, velvety smooth luxury bloom: F3 (174Hz) -> C4 (261Hz) -> A4 (440Hz) -> C5 (523Hz) -> E5 (659Hz)
          filter.frequency.setValueAtTime(1400, t0);
          filter.Q.setValueAtTime(0.8, t0);
          masterGain.gain.setValueAtTime(0.85, t0);

          const notes = [
            { freq: 174.61, at: 0.00, dur: 1.35, peak: 0.12, type: "sine" },
            { freq: 261.63, at: 0.04, dur: 1.25, peak: 0.15, type: "sine" },
            { freq: 440.00, at: 0.10, dur: 1.15, peak: 0.14, type: "sine" },
            { freq: 523.25, at: 0.16, dur: 1.05, peak: 0.11, type: "sine" },
            { freq: 659.25, at: 0.22, dur: 0.95, peak: 0.07, type: "sine" },
          ];

          notes.forEach(({ freq, at, dur, peak, type: oscType }) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = oscType;
            osc.frequency.setValueAtTime(freq, t0 + at);
            gain.gain.setValueAtTime(0.0001, t0 + at);
            gain.gain.exponentialRampToValueAtTime(peak, t0 + at + 0.045);
            gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
            osc.connect(gain);
            gain.connect(filter);
            osc.start(t0 + at);
            osc.stop(t0 + at + dur + 0.08);
          });
        } else if (type === "send_start" || type === "confirm") {
          // Affirmative ascending chime: warm harmonic swell + crisp reassuring glass ping (C5 523Hz + G5 784Hz)
          filter.frequency.setValueAtTime(1500, t0);
          filter.Q.setValueAtTime(0.8, t0);
          masterGain.gain.setValueAtTime(0.75, t0);

          // Gentle ambient breath
          const sweepOsc = ctx.createOscillator();
          const sweepGain = ctx.createGain();
          sweepOsc.type = "sine";
          sweepOsc.frequency.setValueAtTime(320, t0);
          sweepOsc.frequency.exponentialRampToValueAtTime(520, t0 + 0.35);
          sweepGain.gain.setValueAtTime(0.0001, t0);
          sweepGain.gain.exponentialRampToValueAtTime(0.08, t0 + 0.12);
          sweepGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.40);
          sweepOsc.connect(sweepGain);
          sweepGain.connect(filter);
          sweepOsc.start(t0);
          sweepOsc.stop(t0 + 0.45);

          // Harmonic confirmation pings
          const pings = [
            { freq: 523.25, at: 0.03, dur: 0.55, peak: 0.13 },
            { freq: 783.99, at: 0.06, dur: 0.50, peak: 0.09 },
          ];
          pings.forEach(({ freq, at, dur, peak }) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = "sine";
            osc.frequency.setValueAtTime(freq, t0 + at);
            gain.gain.setValueAtTime(0.0001, t0 + at);
            gain.gain.exponentialRampToValueAtTime(peak, t0 + at + 0.025);
            gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
            osc.connect(gain);
            gain.connect(filter);
            osc.start(t0 + at);
            osc.stop(t0 + at + dur + 0.05);
          });
        } else if (type === "cancel" || type === "decline") {
          // Soft descending acoustic glass drop: E5 (659Hz) -> B4 (493Hz) -> G4 (392Hz)
          filter.frequency.setValueAtTime(1300, t0);
          filter.Q.setValueAtTime(0.9, t0);
          masterGain.gain.setValueAtTime(0.65, t0);

          const notes = [
            { freq: 659.25, at: 0.00, dur: 0.35, peak: 0.11, type: "sine" },
            { freq: 493.88, at: 0.08, dur: 0.32, peak: 0.09, type: "sine" },
            { freq: 392.00, at: 0.16, dur: 0.38, peak: 0.07, type: "sine" },
          ];
          notes.forEach(({ freq, at, dur, peak, type: oscType }) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = oscType;
            osc.frequency.setValueAtTime(freq, t0 + at);
            gain.gain.setValueAtTime(0.0001, t0 + at);
            gain.gain.exponentialRampToValueAtTime(peak, t0 + at + 0.025);
            gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
            osc.connect(gain);
            gain.connect(filter);
            osc.start(t0 + at);
            osc.stop(t0 + at + dur + 0.05);
          });
        } else if (type === "incoming") {
          // Calm soothing dual-phase glass marimba: G4 (392Hz) + D5 (587Hz) -> B4 (493Hz) + G5 (784Hz)
          filter.frequency.setValueAtTime(1500, t0);
          filter.Q.setValueAtTime(1.0, t0);
          masterGain.gain.setValueAtTime(0.85, t0);

          const notes = [
            { freq: 392.00, at: 0.00, dur: 0.85, peak: 0.15, type: "sine" },
            { freq: 587.33, at: 0.02, dur: 0.75, peak: 0.12, type: "sine" },
            { freq: 493.88, at: 0.15, dur: 0.95, peak: 0.14, type: "sine" },
            { freq: 783.99, at: 0.17, dur: 0.85, peak: 0.09, type: "sine" },
          ];
          notes.forEach(({ freq, at, dur, peak, type: oscType }) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = oscType;
            osc.frequency.setValueAtTime(freq, t0 + at);
            gain.gain.setValueAtTime(0.0001, t0 + at);
            gain.gain.exponentialRampToValueAtTime(peak, t0 + at + 0.035);
            gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
            osc.connect(gain);
            gain.connect(filter);
            osc.start(t0 + at);
            osc.stop(t0 + at + dur + 0.06);
          });
        } else {
          // Soft subtle water-droplet / acoustic glass tap
          filter.frequency.setValueAtTime(1800, t0);
          filter.Q.setValueAtTime(1.0, t0);
          masterGain.gain.setValueAtTime(0.75, t0);

          const notes = [
            { freq: 440.00, at: 0.00, dur: 0.45, peak: 0.13, type: "sine" },
            { freq: 880.00, at: 0.02, dur: 0.38, peak: 0.07, type: "sine" },
          ];
          notes.forEach(({ freq, at, dur, peak, type: oscType }) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = oscType;
            osc.frequency.setValueAtTime(freq, t0 + at);
            gain.gain.setValueAtTime(0.0001, t0 + at);
            gain.gain.exponentialRampToValueAtTime(peak, t0 + at + 0.025);
            gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
            osc.connect(gain);
            gain.connect(filter);
            osc.start(t0 + at);
            osc.stop(t0 + at + dur + 0.05);
          });
        }
      } catch (e) {
        /* Audio blocked or unavailable — silent fallback */
      }
    };

    if (ctx.state === "suspended" || ctx.state === "interrupted") {
      ctx.resume().then(render).catch(render);
    } else {
      render();
    }
  }

  function initAudioUnlock() {
    const unlockEvents = ["touchstart", "touchend", "pointerdown", "click", "keydown"];
    const handleGesture = () => {
      unlockAudio();
    };
    unlockEvents.forEach((ev) => {
      window.addEventListener(ev, handleGesture, { passive: true, capture: true });
    });

    // Re-wake audio context when browser tab is refocused
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && audioCtx && (audioCtx.state === "suspended" || audioCtx.state === "interrupted")) {
        audioCtx.resume().catch(() => {});
      }
    });
    window.addEventListener("focus", () => {
      if (audioCtx && (audioCtx.state === "suspended" || audioCtx.state === "interrupted")) {
        audioCtx.resume().catch(() => {});
      }
    });
  }

  /* ---- Server config ---- */
  function setConfig(config) {
    state.config = config || null;
    const limit = config && config.max_ram_file_size ? config.max_ram_file_size : 256 * 1024 * 1024;
    const pretty = fmtBytes(limit).replace(" ", " ");
    if (ui.limitChip) ui.limitChip.textContent = `In-RAM · ${pretty}`;
    if (ui.sizeNote) ui.sizeNote.textContent = `files up to ${pretty} stream purely in RAM, larger ones buffer on the fly — nothing is left behind.`;
    const statBuffer = $("statBuffer");
    if (statBuffer) statBuffer.textContent = pretty;
  }

  /* ---- Segmented mode tabs (Send / Receive) ---- */
  function setMode(mode, direction = null) {
    const currentMode = document.body.dataset.mode || "send";
    const m = mode === "receive" ? "receive" : "send";
    const send = m === "send";

    // Auto-detect direction if not passed
    let dir = direction;
    if (!dir && currentMode !== m) {
      dir = send ? "right" : "left";
    }

    document.body.dataset.mode = m;
    const tS = $("tabSend"), tR = $("tabReceive");
    const pS = $("panel-send"), pR = $("panel-receive");
    if (!tS || !tR || !pS || !pR) return;
    tS.setAttribute("aria-selected", String(send));
    tR.setAttribute("aria-selected", String(!send));
    const showEl = send ? pS : pR;
    const hideEl = send ? pR : pS;

    hideEl.setAttribute("hidden", "");
    hideEl.classList.remove("view-enter", "slide-left-enter", "slide-right-enter");

    showEl.removeAttribute("hidden");
    showEl.classList.remove("view-enter", "slide-left-enter", "slide-right-enter");
    void showEl.offsetWidth; // restart enter animation

    if (dir === "left") {
      showEl.classList.add("slide-left-enter");
    } else if (dir === "right") {
      showEl.classList.add("slide-right-enter");
    } else {
      showEl.classList.add("view-enter");
    }
  }

  function initTabs() {
    const tS = $("tabSend"), tR = $("tabReceive");
    if (!tS || !tR) return;
    try { localStorage.removeItem("beamly-mode"); } catch (_) {}
    tS.addEventListener("click", () => setMode("send", "right"));
    tR.addEventListener("click", () => setMode("receive", "left"));
    setMode("send");
  }

  /* ---- 1-2-3 step tracker ---- */
  function updateSteps() {
    const s1 = $("stepFiles"), s2 = $("stepDevice"), s3 = $("stepSend");
    if (!s1 || !s2 || !s3) return;
    const hasFiles = state.queue.length > 0;
    [s1, s2, s3].forEach((el) => el.classList.remove("done", "active"));
    if (state.sending) {
      s1.classList.add("done");
      s2.classList.add("done");
      s3.classList.add("active");
    } else if (state.target && hasFiles) {
      s1.classList.add("done");
      s2.classList.add("done");
      s3.classList.add("active");
    } else if (hasFiles) {
      s1.classList.add("done");
      s2.classList.add("active");
    } else {
      s1.classList.add("active");
    }
  }

  /* ---- Connection status ---- */
  function setStatus(mode) {
    ui.connBadge.classList.remove("online", "offline");
    if (mode === "online") {
      ui.connBadge.classList.add("online");
      ui.connText.textContent = "Online";
    } else if (mode === "offline") {
      ui.connBadge.classList.add("offline");
      ui.connText.textContent = "Offline";
    } else {
      ui.connText.textContent = "Connecting…";
    }
  }

  /* ---- Peer list (+ Receive-mode status) ---- */
  /* ---- Peer list (+ Receive-mode status) ---- */
  function renderPeers(peers) {
    const list = (peers || []).filter((p) => {
      const ip = typeof p === "string" ? p : p.ip;
      return ip && ip !== state.myIp;
    });

    // If currently selected target went offline, immediately deselect it and notify user
    if (state.target) {
      const selectedItem = list.find((p) => (typeof p === "string" ? p : p.ip) === state.target);
      const isStillOnline = selectedItem && (typeof selectedItem === "string" || selectedItem.status === "online");
      if (!isStillOnline) {
        const lostTarget = state.target;
        state.target = null;
        if (ui.dockTarget) {
          ui.dockTarget.value = "";
        }
        showToast(`Device ${lostTarget} went offline.`);
      }
    }

    ui.peerList.innerHTML = "";
    populateTargetOptions(list);

    const onlinePeers = list.filter((p) => typeof p === "string" || p.status === "online");
    const onlineCount = onlinePeers.length;

    const statPeers = $("statPeers");
    if (statPeers) statPeers.textContent = String(onlineCount);
    const rx = $("rxStatus");
    if (rx) {
      rx.textContent = !onlineCount
        ? "Waiting for incoming beams…"
        : `${onlineCount} device${onlineCount > 1 ? "s" : ""} in range · waiting for incoming beams…`;
    }

    if (!list.length) {
      ui.radarHint.textContent = "Scanning for devices…";
      ui.radar.classList.add("scanning");
      const empty = document.createElement("li");
      empty.className = "peer-card opacity-60 no-anim";
      empty.innerHTML = `
        <div class="peer-avatar">?</div>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-semibold">No devices found yet</p>
          <p class="text-xs opacity-50">Open Beamly on another device on same Wi-Fi</p>
        </div>
      `;
      ui.peerList.appendChild(empty);
      syncSendDock();
      return;
    }

    ui.radar.classList.remove("scanning");
    ui.radarHint.textContent = `${onlineCount} device${onlineCount !== 1 ? "s" : ""} online`;

    list.forEach((item, i) => {
      const ip = typeof item === "string" ? item : item.ip;
      const isOnline = typeof item === "string" ? true : item.status === "online";

      const li = document.createElement("li");
      li.className = `peer-card${!isOnline ? " is-offline" : ""}`;
      li.dataset.ip = ip;
      li.dataset.online = String(isOnline);
      li.setAttribute("role", "button");
      li.setAttribute("tabindex", isOnline ? "0" : "-1");
      li.setAttribute("aria-disabled", String(!isOnline));
      li.setAttribute("aria-label", `${ip} (${isOnline ? "Online" : "Offline"})`);
      li.style.setProperty("--i", i);
      const isSelected = ip === state.target && isOnline;
      if (isSelected) li.classList.add("selected");
      li.innerHTML = `
        <div class="peer-avatar">${ip.split(".").pop()}
          <span class="peer-check" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-semibold truncate">${ip}</p>
          <p class="text-xs opacity-60">${!isOnline ? "Offline" : isSelected ? "Selected — ready to beam" : "Ready to receive"}</p>
        </div>
        <span class="peer-signal ${isOnline ? "online" : "offline"}" title="${isOnline ? "Connected and discoverable" : "Offline / unreachable"}" aria-label="${isOnline ? "Online" : "Offline"}"></span>
      `;
      li.addEventListener("click", () => {
        if (!isOnline) {
          showToast(`Device ${ip} is offline and cannot be selected.`);
          return;
        }
        selectTarget(ip);
      });
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (!isOnline) {
            showToast(`Device ${ip} is offline and cannot be selected.`);
            return;
          }
          selectTarget(ip);
        }
      });
      ui.peerList.appendChild(li);
    });

    syncSendDock();
  }

  function markAllPeersOffline() {
    document.querySelectorAll(".peer-card:not(.no-anim)").forEach((el) => {
      el.classList.add("is-offline");
      el.dataset.online = "false";
      el.classList.remove("selected");
      el.setAttribute("aria-disabled", "true");
      el.setAttribute("tabindex", "-1");
      const sig = el.querySelector(".peer-signal");
      if (sig) {
        sig.className = "peer-signal offline";
        sig.title = "Offline / unreachable";
        sig.setAttribute("aria-label", "Offline");
      }
      const sub = el.querySelector(".text-xs");
      if (sub) sub.textContent = "Offline";
    });
    if (state.target) {
      state.target = null;
    }
    if (ui.dockTarget) {
      ui.dockTarget.innerHTML = '<option value="">Select device…</option>';
      ui.dockTarget.value = "";
    }
    syncSendDock();
  }

  /* Populate Send Dock target dropdown: only online devices can be selected for sending */
  function populateTargetOptions(list) {
    if (!ui.dockTarget) return;
    const norm = list.map((p) =>
      typeof p === "string" ? { ip: p, isOnline: true } : { ip: p.ip, isOnline: p.status === "online" }
    );
    const onlinePeers = norm.filter((p) => p.isOnline);
    const current = state.target && onlinePeers.some((p) => p.ip === state.target) ? state.target : "";
    if (!current && state.target) {
      state.target = null;
    }

    let optionsHtml = '<option value="">Select device…</option>';
    onlinePeers.forEach(({ ip }) => {
      const isSel = ip === current;
      optionsHtml += `<option value="${ip}" ${isSel ? "selected" : ""}>Device ${ip}</option>`;
    });

    ui.dockTarget.innerHTML = optionsHtml;
    ui.dockTarget.value = current;
  }

  /* Toggle selection: only online devices are supported for selection */
  function selectTarget(ip) {
    if (!ip) {
      deselectTarget();
      return;
    }

    // Verify peer is actually online before allowing selection
    const card = document.querySelector(`.peer-card[data-ip="${ip}"]`);
    const isOnline = card ? card.dataset.online !== "false" : true;
    if (!isOnline) {
      showToast(`Device ${ip} is offline and cannot be selected.`);
      deselectTarget();
      return;
    }

    state.target = state.target === ip ? null : ip;
    if (ui.dockTarget) {
      ui.dockTarget.value = state.target || "";
    }

    document.querySelectorAll(".peer-card:not(.no-anim)").forEach((el) => {
      const isCardOnline = el.dataset.online !== "false";
      const isSelected = el.dataset.ip === state.target && isCardOnline;
      el.classList.toggle("selected", isSelected);
      const sub = el.querySelector(".text-xs");
      if (sub) {
        sub.textContent = !isCardOnline ? "Offline" : isSelected ? "Selected — ready to beam" : "Ready to receive";
      }
    });

    syncSendDock();
    updateSteps();
  }

  /* Deselect currently selected device: returns selection to non-selected */
  function deselectTarget() {
    state.target = null;
    if (ui.dockTarget) {
      ui.dockTarget.value = "";
    }
    document.querySelectorAll(".peer-card:not(.no-anim)").forEach((el) => {
      el.classList.remove("selected");
      const sub = el.querySelector(".text-xs");
      const isOnline = el.dataset.online !== "false";
      if (sub) {
        sub.textContent = !isOnline ? "Offline" : "Ready to receive";
      }
    });
    syncSendDock();
    updateSteps();
  }

  function clearQueue() {
    state.queue = [];
    renderQueue();
  }

  /* ---- Floating send dock ---- */
  function syncSendDock() {
    const hasFiles = state.queue.length > 0;
    const total = state.queue.reduce((sum, f) => sum + f.size, 0);

    // Sync dockTarget select element to current state.target
    if (ui.dockTarget) {
      ui.dockTarget.value = state.target || "";
    }

    if (hasFiles && !state.sending) {
      const n = state.queue.length;
      if (state.target) {
        ui.dockSummary.textContent = `${n} file${n > 1 ? "s" : ""} (${fmtBytes(total)}) → ${state.target}`;
      } else {
        ui.dockSummary.textContent = `${n} file${n > 1 ? "s" : ""} (${fmtBytes(total)}) — select device`;
      }
      ui.dockSendBtn.disabled = !state.target;
      ui.dockSendLabel.textContent = state.target ? "Beam" : "Select device";
      ui.sendDock.classList.remove("hidden");
      document.body.classList.add("dock-open");
    } else {
      ui.sendDock.classList.add("hidden");
      document.body.classList.remove("dock-open");
    }
    updateSteps();
  }

  function initDock() {
    if (ui.dockTarget) {
      ui.dockTarget.addEventListener("change", () => {
        const value = ui.dockTarget.value;
        if (value) {
          selectTarget(value);
        } else {
          deselectTarget();
        }
      });
    }
    if (ui.dockSendBtn) {
      ui.dockSendBtn.addEventListener("click", () => {
        if (!state.target) {
          showToast("Please select a nearby online device to beam to.");
          return;
        }
        // Double-check target is still online before beaming
        const peerCards = document.querySelectorAll(".peer-card");
        let isTargetOnline = true;
        peerCards.forEach((c) => {
          if (c.dataset.ip === state.target && c.dataset.online === "false") {
            isTargetOnline = false;
          }
        });
        if (!isTargetOnline) {
          showToast(`Device ${state.target} is offline. Please select an online device.`);
          deselectTarget();
          return;
        }
        if (!state.queue || state.queue.length === 0) {
          showToast("Please select or drop files to beam.");
          return;
        }
        if (window.Beamly.net && window.Beamly.net.sendAll) {
          window.Beamly.net.sendAll(state.target);
        }
      });
    }
  }

  /* ---- File queue ---- */
  function addFiles(fileList) {
    for (const file of fileList) {
      state.queue.push(file);
    }
    renderQueue();
  }

  function renderQueue() {
    ui.queueList.innerHTML = "";
    const hasFiles = state.queue.length > 0;

    // Minimize dropzone to "Add more files" when at least 1 file is queued
    if (ui.dropzone) {
      ui.dropzone.classList.toggle("compact", hasFiles);
    }
    if (ui.dropTitle) {
      ui.dropTitle.textContent = hasFiles ? "Add more files" : "Drop files here";
    }
    if (ui.dropSub) {
      ui.dropSub.textContent = hasFiles ? "" : "or tap to browse";
    }

    if (!hasFiles) {
      syncSendDock();
      return;
    }
    state.queue.forEach((file, idx) => {
      const li = document.createElement("li");
      li.className = "queue-item";
      li.style.setProperty("--i", idx);
      li.innerHTML = `
        <span class="file-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>
        <span class="fname truncate">${file.name}</span>
        <span class="fsize">${fmtBytes(file.size)}</span>
        <button class="remove" data-idx="${idx}" title="Remove" aria-label="Remove ${file.name}">✕</button>
      `;
      li.querySelector(".remove").addEventListener("click", () => {
        state.queue.splice(idx, 1);
        renderQueue();
      });
      ui.queueList.appendChild(li);
    });
    syncSendDock();
  }

  function initDropzone() {
    const drop = ui.dropzone;
    ["dragenter", "dragover"].forEach((ev) =>
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("dragover"); })
    );
    ["dragleave", "drop"].forEach((ev) =>
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("dragover"); })
    );
    drop.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
    drop.addEventListener("click", () => ui.fileInput.click());
    drop.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); ui.fileInput.click(); }
    });
    ui.fileInput.addEventListener("change", () => {
      addFiles(ui.fileInput.files);
      ui.fileInput.value = "";
    });
  }

  /* ---- Toast: interactive request pill or auto-dismissing notice ----
     showToast(msg, onAccept, onDecline, timeoutMs)
     - With callbacks: Accept/Decline pill, default 60s then auto-decline.
     - Without: info notice, actions hidden, default 4.5s then slides out. */
  let toastTimer = null;
  let toastExitTimer = null;
  const TOAST_EXIT_MS = 240;

  function clearToastTimers() {
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    if (toastExitTimer) { clearTimeout(toastExitTimer); toastExitTimer = null; }
  }

  function startToastCountdown(timeoutMs) {
    const bar = ui.toastTimerBar;
    if (!bar) return;
    bar.style.transition = "none";
    bar.style.width = "100%";
    void bar.offsetWidth; // reflow so the transition restarts
    bar.style.transition = `width ${timeoutMs}ms linear`;
    bar.style.width = "0%";
  }

  function showToast(msg, onAccept, onDecline, timeoutMs) {
    const interactive = typeof onAccept === "function" || typeof onDecline === "function";
    const timeout = typeof timeoutMs === "number"
      ? timeoutMs
      : interactive ? 60000 : 4500;

    clearToastTimers();
    ui.toast.classList.remove("leaving", "hidden");
    ui.toastTitle.textContent = interactive ? "Incoming transfer" : "Beamly";
    ui.toastMsg.textContent = msg;
    ui.toastActions.style.display = interactive ? "" : "none";

    const accept = () => {
      playChime("confirm");
      hideToast();
      if (onAccept) onAccept();
    };
    const decline = () => {
      playChime("cancel");
      hideToast();
      if (onDecline) onDecline();
    };
    $("acceptBtn").onclick = interactive ? accept : null;
    $("declineBtn").onclick = interactive ? decline : null;

    startToastCountdown(timeout);
    // Premium sound when any notification/request appears
    playChime(interactive ? "incoming" : "notice");
    // Auto-dismiss: info notices just slide out; unanswered requests decline.
    toastTimer = setTimeout(() => { decline(); }, timeout);
  }

  function hideToast(immediate = false) {
    if (!ui.toast) return;
    clearToastTimers();
    // Immediately invalidate actions so no click can accept after cancellation
    const acceptBtn = $("acceptBtn");
    const declineBtn = $("declineBtn");
    if (acceptBtn) acceptBtn.onclick = null;
    if (declineBtn) declineBtn.onclick = null;
    if (ui.toastActions) ui.toastActions.style.display = "none";

    if (immediate) {
      ui.toast.classList.remove("leaving");
      ui.toast.classList.add("hidden");
      if (toastExitTimer) {
        clearTimeout(toastExitTimer);
        toastExitTimer = null;
      }
      return;
    }

    if (ui.toast.classList.contains("hidden") && !ui.toast.classList.contains("leaving")) return;
    ui.toast.classList.add("leaving");
    toastExitTimer = setTimeout(() => {
      ui.toast.classList.add("hidden");
      ui.toast.classList.remove("leaving");
      toastExitTimer = null;
    }, TOAST_EXIT_MS);
  }

  /* ---- Progress overlay ---- */
  const RING_CIRCUMFERENCE = 326.73;
  let onCancelTransferCallback = null;

  function setOnCancelTransfer(fn) {
    onCancelTransferCallback = fn;
  }

  function cancelCurrentTransfer() {
    hideToast(true);
    playChime("cancel");
    if (typeof onCancelTransferCallback === "function") {
      try { onCancelTransferCallback(); } catch (_) {}
    }
    hideProgress();
  }

  let smoothedEta = null;
  let lastEtaTimestamp = 0;

  function showProgress(role, name, subText = "Beam in progress…") {
    smoothedEta = null;
    lastEtaTimestamp = 0;
    if (ui.progressRole) ui.progressRole.textContent = role;
    if (ui.progressName) {
      ui.progressName.textContent = name;
      ui.progressName.title = name;
    }
    if (ui.progressSub) ui.progressSub.textContent = subText;
    setProgress(0, 0, 0, 0, null);
    if (ui.progressOverlay) {
      ui.progressOverlay.classList.remove("hidden");
      ui.progressOverlay.style.display = "grid";
    }
    document.body.classList.add("modal-open");
  }

  function setProgress(pct, speedBytesPerSec, loadedBytes = 0, totalBytes = 0, etaSec = null) {
    const pctClamped = Math.max(0, Math.min(100, pct));
    const now = performance.now();
    if (ui.progressPct) {
      ui.progressPct.textContent = `${Math.round(pctClamped)}%`;
    }
    if (ui.progressRing) {
      ui.progressRing.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - pctClamped / 100));
    }
    if (ui.progressSpeed) {
      ui.progressSpeed.textContent = speedBytesPerSec && speedBytesPerSec > 0 ? `⚡ ${fmtSpeed(speedBytesPerSec)}` : "—";
    }
    if (ui.progressBytes) {
      if (totalBytes > 0) {
        ui.progressBytes.textContent = `${fmtBytes(loadedBytes)} / ${fmtBytes(totalBytes)}`;
      } else if (loadedBytes > 0) {
        ui.progressBytes.textContent = fmtBytes(loadedBytes);
      } else {
        ui.progressBytes.textContent = "0 B / 0 B";
      }
    }
    if (ui.progressEta) {
      if (etaSec != null && Number.isFinite(etaSec) && etaSec >= 0 && pctClamped < 100) {
        if (smoothedEta === null || !lastEtaTimestamp) {
          smoothedEta = etaSec;
        } else {
          const dt = (now - lastEtaTimestamp) / 1000;
          const predicted = Math.max(0, smoothedEta - dt);
          // Stabilize: 80% weight on steady tick-down, 20% on new instant speed reading
          smoothedEta = predicted * 0.8 + etaSec * 0.2;
        }
        lastEtaTimestamp = now;

        const displayEta = Math.max(1, Math.round(smoothedEta));
        if (displayEta < 60) {
          ui.progressEta.textContent = `${displayEta}s left`;
        } else {
          const m = Math.floor(displayEta / 60);
          const s = displayEta % 60;
          ui.progressEta.textContent = s > 0 ? `${m}m ${s}s left` : `${m}m left`;
        }
      } else {
        smoothedEta = null;
        lastEtaTimestamp = 0;
        const isComplete = ui.progressRole && ui.progressRole.textContent === "Complete";
        ui.progressEta.textContent = pctClamped >= 100 ? (isComplete ? "Done" : "Finishing…") : "—";
      }
    }
  }

  function hideProgress() {
    smoothedEta = null;
    lastEtaTimestamp = 0;
    if (ui.progressOverlay) {
      ui.progressOverlay.classList.add("hidden");
      ui.progressOverlay.style.display = "none";
    }
    document.body.classList.remove("modal-open");
  }

  function initProgressOverlay() {
    if (ui.progressCancelBtn) {
      ui.progressCancelBtn.addEventListener("click", cancelCurrentTransfer);
    }
    if (ui.progressCancelAction) {
      ui.progressCancelAction.addEventListener("click", cancelCurrentTransfer);
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && ui.progressOverlay && !ui.progressOverlay.classList.contains("hidden")) {
        cancelCurrentTransfer();
      }
    });
  }

  /* ---- Public API ---- */
  window.Beamly = {
    ui,
    state,
    fmtBytes,
    fmtSpeed,
    playChime,
    triggerHaptic,
    deselectTarget,
    setOnCancelTransfer,
    cancelCurrentTransfer,
    init() {
      initTheme();
      initAudioUnlock();
      initDock();
      initDropzone();
      initTabs();
      initProgressOverlay();
      setStatus("connecting");
      updateSteps();
      const rescan = $("rescanBtn");
      if (rescan) {
        rescan.addEventListener("click", () => {
          rescan.classList.add("scanning");
          setTimeout(() => rescan.classList.remove("scanning"), 750);
          if (window.Beamly.net && window.Beamly.net.refreshNow) {
            window.Beamly.net.refreshNow();
          }
        });
      }
    },
    setStatus,
    setConfig,
    setMode,
    renderPeers,
    setMyIp(ip) {
      state.myIp = ip;
      ui.myIp.textContent = ip;
    },
    showToast,
    hideToast,
    showProgress,
    setProgress,
    hideProgress,
    setSending(on) {
      state.sending = on;
      ui.dockSendBtn.disabled = on;
      syncSendDock();
    },
    syncSendDock,
    clearQueue,
    markAllPeersOffline,
    renderQueue,
  };
})();