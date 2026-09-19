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
        playChime("notice");
      });
    }
  }

  /* ---- Luxury acoustic sound engine (Web Audio synthesis) ----
     Warm acoustic filtered harmonics with soft exponential attack and
     silky decay envelopes — calm, smooth, organic (no harsh treble buzzing). */
  let audioCtx = null;

  function ensureAudio() {
    if (audioCtx) {
      if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
      return audioCtx;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
      if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    } catch (e) {
      audioCtx = null;
    }
    return audioCtx;
  }

  function playChime(type = "notice") {
    const ctx = ensureAudio();
    if (!ctx) return;
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
      } else if (type === "send_start") {
        // Gentle ambient swell: peaceful ascending breath
        filter.frequency.setValueAtTime(1100, t0);
        filter.Q.setValueAtTime(0.7, t0);
        masterGain.gain.setValueAtTime(0.65, t0);

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(320, t0);
        osc.frequency.exponentialRampToValueAtTime(480, t0 + 0.45);
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.07, t0 + 0.18);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.55);
        osc.connect(gain);
        gain.connect(filter);
        osc.start(t0);
        osc.stop(t0 + 0.60);
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
  }

  function initAudioUnlock() {
    ["pointerdown", "keydown", "touchend"].forEach((ev) =>
      document.addEventListener(ev, ensureAudio, { passive: true })
    );
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
  function renderPeers(peers) {
    const list = peers.filter((ip) => ip !== state.myIp);
    ui.peerList.innerHTML = "";
    populateTargetOptions(list);
    const statPeers = $("statPeers");
    if (statPeers) statPeers.textContent = String(list.length);
    const rx = $("rxStatus");
    if (rx) {
      rx.textContent = !list.length
        ? "Waiting for incoming beams…"
        : `${list.length} device${list.length > 1 ? "s" : ""} in range · waiting for incoming beams…`;
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
    const onlineCount = list.filter((p) => typeof p === "string" || p.status === "online").length;
    ui.radarHint.textContent = `${onlineCount} device${onlineCount !== 1 ? "s" : ""} online`;

    populateTargetOptions(list);

    list.forEach((item, i) => {
      const ip = typeof item === "string" ? item : item.ip;
      const isOnline = typeof item === "string" ? true : item.status === "online";

      const li = document.createElement("li");
      li.className = `peer-card${!isOnline ? " is-offline" : ""}`;
      li.dataset.ip = ip;
      li.dataset.online = String(isOnline);
      li.setAttribute("role", "button");
      li.setAttribute("tabindex", isOnline ? "0" : "-1");
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
          showToast(`Device ${ip} is offline.`);
          return;
        }
        selectTarget(ip);
      });
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (!isOnline) {
            showToast(`Device ${ip} is offline.`);
            return;
          }
          selectTarget(ip);
        }
      });
      ui.peerList.appendChild(li);
    });

    // If currently selected target went offline, deselect it
    if (state.target) {
      const selectedItem = list.find((p) => (typeof p === "string" ? p : p.ip) === state.target);
      const isStillOnline = selectedItem && (typeof selectedItem === "string" || selectedItem.status === "online");
      if (!isStillOnline) {
        state.target = null;
      }
    }
    syncSendDock();
  }

  function markAllPeersOffline() {
    document.querySelectorAll(".peer-card").forEach((el) => {
      el.classList.add("is-offline");
      el.dataset.online = "false";
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
      syncSendDock();
    }
  }

  function populateTargetOptions(list) {
    if (!ui.dockTarget) return;
    const norm = list.map((p) =>
      typeof p === "string" ? { ip: p, isOnline: true } : { ip: p.ip, isOnline: p.status === "online" }
    );
    const current = state.target && norm.some((p) => p.ip === state.target && p.isOnline) ? state.target : "";
    ui.dockTarget.innerHTML =
      '<option value="">Select device…</option>' +
      norm
        .map(
          ({ ip, isOnline }) =>
            `<option value="${ip}" ${!isOnline ? "disabled" : ""} ${ip === current ? "selected" : ""}>${ip}${!isOnline ? " (Offline)" : ""}</option>`
        )
        .join("");
  }

  /* Toggle selection: clicking a selected device deselects it */
  function selectTarget(ip) {
    state.target = state.target === ip ? null : ip;
    if (ui.dockTarget) {
      ui.dockTarget.value = state.target || "";
    }

    document.querySelectorAll(".peer-card:not(.no-anim)").forEach((el) => {
      const isSelected = el.dataset.ip === state.target;
      el.classList.toggle("selected", isSelected);
      const sub = el.querySelector(".text-xs");
      const isOnline = el.dataset.online !== "false";
      if (sub) {
        sub.textContent = !isOnline ? "Offline" : isSelected ? "Selected — ready to beam" : "Ready to receive";
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
    document.querySelectorAll(".peer-card").forEach((el) => {
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

    // Sync dockTarget select element to current state.target (do NOT wipe state.target!)
    if (ui.dockTarget && state.target) {
      ui.dockTarget.value = state.target;
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
          showToast("Please select a nearby device to beam to.");
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

    const accept = () => { hideToast(); if (onAccept) onAccept(); };
    const decline = () => { hideToast(); if (onDecline) onDecline(); };
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