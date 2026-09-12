/* Beamly WebSocket client, peer discovery, upload/download handler */
(function () {
  "use strict";

  const app = () => window.Beamly;

  const WS = {
    socket: null,
    retryDelay: 2000,
  };

  const pendingTransfers = new Map(); // transfer_id -> { resolve, timer }
  const pendingBatches = new Map();   // batch_id -> { resolve, timer }
  const lastEvents = new Map();       // recent events keyed by transfer_id or batch_id

  /* Helper to truncate long filenames so notifications fit cleanly on mobile */
  function conciseFileName(name, maxLen = 20) {
    if (!name || name.length <= maxLen) return name || "file";
    const dot = name.lastIndexOf(".");
    if (dot > 0 && name.length - dot <= 6) {
      const ext = name.slice(dot);
      const keep = Math.max(4, maxLen - ext.length - 2);
      return name.slice(0, keep) + "…" + ext;
    }
    return name.slice(0, maxLen - 1) + "…";
  }

  /* ---- WebSocket ---- */
  function connectWS() {
    if (!app().state.myIp) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/${app().state.myIp}`);

    ws.onopen = () => {
      WS.retryDelay = 2000;
      app().setStatus("online");
      refreshPeers();
    };

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      handleMessage(msg);
    };

    ws.onclose = () => {
      app().setStatus("offline");
      if (app().markAllPeersOffline) app().markAllPeersOffline();
      setTimeout(connectWS, WS.retryDelay);
      WS.retryDelay = Math.min(WS.retryDelay * 1.5, 15000);
    };

    ws.onerror = () => ws.close();
    WS.socket = ws;
  }

  function handleMessage(msg) {
    if (msg.type === "PING") {
      if (WS.socket && WS.socket.readyState === WebSocket.OPEN) WS.socket.send("PONG");
      return;
    }
    if (msg.type === "BATCH_TRANSFER_REQUEST") {
      onBatchTransferRequest(msg);
      return;
    }
    if (msg.type === "BATCH_TRANSFER_ACCEPTED" || msg.type === "BATCH_TRANSFER_DECLINED") {
      resolveBatchPending(msg.batch_id, msg.type === "BATCH_TRANSFER_ACCEPTED");
      return;
    }
    if (msg.type === "TRANSFER_REQUEST") {
      onTransferRequest(msg);
      return;
    }
    if (msg.type === "TRANSFER_ACCEPTED" || msg.type === "TRANSFER_DECLINED") {
      resolvePending(msg.transfer_id, msg.type === "TRANSFER_ACCEPTED");
      return;
    }
    if (msg.type === "TRANSFER_READY") {
      onTransferReady(msg);
      return;
    }
    if (msg.type === "TRANSFER_UPLOADED") {
      return;
    }
    const key = msg.batch_id || msg.transfer_id;
    if (key) {
      lastEvents.set(key, msg);
      if (lastEvents.size > 50) lastEvents.delete(lastEvents.keys().next().value);
    }
  }

  function resolvePending(transferId, accepted) {
    const pending = pendingTransfers.get(transferId);
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve(accepted);
      pendingTransfers.delete(transferId);
    } else {
      lastEvents.set(transferId, { type: accepted ? "TRANSFER_ACCEPTED" : "TRANSFER_DECLINED" });
    }
  }

  function resolveBatchPending(batchId, accepted) {
    const pending = pendingBatches.get(batchId);
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve(accepted);
      pendingBatches.delete(batchId);
    } else {
      lastEvents.set(batchId, { type: accepted ? "BATCH_TRANSFER_ACCEPTED" : "BATCH_TRANSFER_DECLINED" });
    }
  }

  function waitForAcceptance(transferId, timeoutMs = 90000) {
    if (pendingTransfers.has(transferId)) {
      return pendingTransfers.get(transferId).promise;
    }
    const last = lastEvents.get(transferId);
    if (last && (last.type === "TRANSFER_ACCEPTED" || last.type === "TRANSFER_DECLINED")) {
      return Promise.resolve(last.type === "TRANSFER_ACCEPTED");
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingTransfers.delete(transferId);
        resolve(false);
      }, timeoutMs);
      pendingTransfers.set(transferId, { resolve, timer });
    });
  }

  function waitForBatchAcceptance(batchId, timeoutMs = 90000) {
    if (pendingBatches.has(batchId)) {
      return pendingBatches.get(batchId).promise;
    }
    const last = lastEvents.get(batchId);
    if (last && (last.type === "BATCH_TRANSFER_ACCEPTED" || last.type === "BATCH_TRANSFER_DECLINED")) {
      return Promise.resolve(last.type === "BATCH_TRANSFER_ACCEPTED");
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingBatches.delete(batchId);
        resolve(false);
      }, timeoutMs);
      pendingBatches.set(batchId, { resolve, timer });
    });
  }

  /* ---- Peer discovery ---- */
  let lastPeersKey = null;

  async function refreshPeers() {
    try {
      const res = await fetch("/api/peers");
      if (!res.ok) throw new Error("Peers unreachable");
      const data = await res.json();
      const peers = data.peers || [];
      const key = JSON.stringify(peers);
      if (key !== lastPeersKey) {
        lastPeersKey = key;
        app().renderPeers(peers);
      }
    } catch {
      if (app().markAllPeersOffline) {
        app().markAllPeersOffline();
      }
    }
  }

  function refreshNow() {
    lastPeersKey = null;
    refreshPeers();
  }

  /* ---- Incoming batch request (single toast for all files) ---- */
  function onBatchTransferRequest(msg) {
    if (app().setMode) app().setMode("receive");
    const totalBytes = app().fmtBytes(msg.total_size);
    const count = msg.total_files;
    const firstFile = msg.files && msg.files[0] ? conciseFileName(msg.files[0].file_name, 18) : "files";

    let summaryText;
    if (count === 1) {
      summaryText = `wants to send "${firstFile}" (${totalBytes}).`;
    } else {
      summaryText = `wants to send ${count} files (${totalBytes}): "${firstFile}" + ${count - 1} more.`;
    }

    app().showToast(
      `Device ${msg.sender_ip} ${summaryText}`,
      () => respondBatch(msg.batch_id, true),
      () => respondBatch(msg.batch_id, false)
    );
  }

  async function respondBatch(batchId, accept) {
    try {
      await fetch("/api/transfer/batch/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batch_id: batchId, accept }),
      });
    } catch { /* best effort */ }
  }

  /* ---- Single request fallback ---- */
  function onTransferRequest(msg) {
    const size = app().fmtBytes(msg.file_size);
    if (app().setMode) app().setMode("receive");
    const shortName = conciseFileName(msg.file_name, 20);
    app().showToast(
      `Device ${msg.sender_ip} wants to send "${shortName}" (${size}).`,
      () => respond(msg.transfer_id, true),
      () => respond(msg.transfer_id, false)
    );
  }

  async function respond(transferId, accept) {
    try {
      await fetch("/api/transfer/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transfer_id: transferId, accept }),
      });
    } catch { /* best effort */ }
  }

  /* ---- Auto-download (receiver side) ---- */
  function onTransferReady(msg) {
    const a = document.createElement("a");
    a.href = `/api/transfer/download/${msg.transfer_id}`;
    a.download = msg.file_name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    app().showToast(`Received "${conciseFileName(msg.file_name, 20)}" — download started.`);
  }

  /* ---- Upload with progress (sender side) ---- */
  function uploadFile(transferId, file) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const form = new FormData();
      form.append("file", file);
      let last = 0;
      let lastStamp = performance.now();

      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = (e.loaded / e.total) * 100;
        const now = performance.now();
        const dt = (now - lastStamp) / 1000;
        if (dt > 0.3) {
          const bps = (e.loaded - last) / dt;
          app().setProgress(pct, bps);
          last = e.loaded;
          lastStamp = now;
        } else {
          app().setProgress(pct, 0);
        }
      };

      xhr.onload = () => (xhr.status === 200 ? resolve() : reject(new Error("Upload failed")));
      xhr.onerror = () => reject(new Error("Upload failed"));
      xhr.open("POST", `/api/transfer/upload/${transferId}`);
      xhr.send(form);
    });
  }

  /* ---- Send all queued files via single batch request ---- */
  async function sendAll(targetIp) {
    if (app().state.sending || !targetIp) return;
    const { state } = app();
    if (!state.queue || state.queue.length === 0) return;

    app().setSending(true);
    const files = state.queue.slice();
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);

    try {
      app().showProgress("Requesting", `Waiting for ${targetIp} to accept…`);

      const batchPayload = {
        sender_ip: state.myIp,
        target_ip: targetIp,
        files: files.map((f) => ({
          name: f.name,
          size: f.size,
          type: f.type || "application/octet-stream",
        })),
        total_size: totalSize,
      };

      const meta = await fetch("/api/transfer/batch/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batchPayload),
      });

      if (!meta.ok) {
        const err = await meta.json().catch(() => ({}));
        throw new Error(err.detail || "Request failed");
      }

      const { batch_id, transfer_ids } = await meta.json();
      const accepted = await waitForBatchAcceptance(batch_id);

      if (!accepted) {
        app().showToast(`Transfer was declined by ${targetIp}.`);
        return;
      }

      // If accepted, upload all files sequentially
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const tId = transfer_ids[i];
        const progressTitle = files.length > 1 ? `Sending (${i + 1}/${files.length})` : "Sending";
        app().showProgress(progressTitle, conciseFileName(file.name, 22));
        await uploadFile(tId, file);
      }

      app().showToast(`All ${files.length} file${files.length > 1 ? "s" : ""} sent successfully!`);
    } catch (err) {
      app().showToast(`Transfer failed: ${err.message}`);
    } finally {
      app().hideProgress();
      app().clearQueue(); // Restores dropzone to default "Drop files here" / "or tap to browse"
      app().setSending(false);
      app().syncSendDock();
    }
  }

  /* ---- Boot ---- */
  async function boot() {
    app().init();
    try {
      const [selfRes, configRes] = await Promise.all([
        fetch("/api/self"),
        fetch("/api/config"),
      ]);
      const self = await selfRes.json();
      const config = configRes.ok ? await configRes.json() : null;
      app().setMyIp(self.ip);
      app().setConfig(config);
    } catch {
      app().setMyIp(location.hostname || "unknown");
    }
    connectWS();
    setInterval(refreshPeers, 2000);
  }

  window.Beamly.net = { sendAll, refreshNow };
  document.addEventListener("DOMContentLoaded", boot);
})();
