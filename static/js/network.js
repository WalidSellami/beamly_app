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
  const pendingDeliveries = new Map(); // transfer_id -> { resolve, timer }
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
    if (WS.socket && (WS.socket.readyState === WebSocket.OPEN || WS.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/${app().state.myIp}`);
    WS.socket = ws;

    ws.onopen = () => {
      if (ws !== WS.socket) return;
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
      if (ws !== WS.socket) return;
      WS.socket = null;
      app().setStatus("offline");
      if (app().markAllPeersOffline) app().markAllPeersOffline();
      setTimeout(connectWS, WS.retryDelay);
      WS.retryDelay = Math.min(WS.retryDelay * 1.5, 15000);
    };

    ws.onerror = () => {
      try { ws.close(); } catch (_) {}
    };
  }

  function handleMessage(msg) {
    if (msg.type === "PING") {
      if (WS.socket && WS.socket.readyState === WebSocket.OPEN) {
        try { WS.socket.send("PONG"); } catch (_) {}
      }
      return;
    }
    if (msg.type === "PONG") {
      return;
    }
    if (msg.type === "PEER_STATUS") {
      refreshNow();
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
    if (msg.type === "TRANSFER_PROGRESS") {
      onTransferProgress(msg);
      return;
    }
    if (msg.type === "TRANSFER_READY") {
      onTransferReady(msg);
      return;
    }
    if (msg.type === "TRANSFER_UPLOADED") {
      return;
    }
    if (msg.type === "TRANSFER_DELIVERED") {
      lastEvents.set(`delivered_${msg.transfer_id}`, true);
      resolveDelivery(msg.transfer_id);
      if (activeReceiveBatch) {
        const isLast = (activeReceiveBatch.completed || 0) >= (activeReceiveBatch.total_files || 1);
        if (isLast) {
          finishReceiverComplete(msg.file_name);
        }
      }
      return;
    }
    if (msg.type === "TRANSFER_CANCELLED") {
      if (receiverCompleteTimer) {
        clearTimeout(receiverCompleteTimer);
        receiverCompleteTimer = null;
      }
      if (receiverSafetyTimer) {
        clearTimeout(receiverSafetyTimer);
        receiverSafetyTimer = null;
      }
      activeReceiveBatch = null;
      app().playChime("cancel");
      app().hideToast(true);
      app().hideProgress();
      if (msg.batch_id) resolveBatchPending(msg.batch_id, false);
      if (msg.transfer_id) {
        resolvePending(msg.transfer_id, false);
        resolveDelivery(msg.transfer_id);
      }
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

  function resolveDelivery(transferId) {
    const pending = pendingDeliveries.get(transferId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingDeliveries.delete(transferId);
      pending.resolve();
    }
  }

  function waitForDelivery(transferId, timeoutMs = 4500) {
    if (lastEvents.has(`delivered_${transferId}`)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingDeliveries.delete(transferId);
        resolve(); // Safety fallback so UI never hangs
      }, timeoutMs);
      pendingDeliveries.set(transferId, { resolve, timer });
    });
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
    let resolveFn;
    const promise = new Promise((resolve) => {
      resolveFn = resolve;
    });
    const timer = setTimeout(() => {
      pendingTransfers.delete(transferId);
      resolveFn(false);
    }, timeoutMs);
    pendingTransfers.set(transferId, { resolve: resolveFn, timer, promise });
    return promise;
  }

  function waitForBatchAcceptance(batchId, timeoutMs = 90000) {
    if (pendingBatches.has(batchId)) {
      return pendingBatches.get(batchId).promise;
    }
    const last = lastEvents.get(batchId);
    if (last && (last.type === "BATCH_TRANSFER_ACCEPTED" || last.type === "BATCH_TRANSFER_DECLINED")) {
      return Promise.resolve(last.type === "BATCH_TRANSFER_ACCEPTED");
    }
    let resolveFn;
    const promise = new Promise((resolve) => {
      resolveFn = resolve;
    });
    const timer = setTimeout(() => {
      pendingBatches.delete(batchId);
      resolveFn(false);
    }, timeoutMs);
    pendingBatches.set(batchId, { resolve: resolveFn, timer, promise });
    return promise;
  }

  /* ---- Peer discovery ---- */
  let lastPeersKey = null;

  async function refreshPeers() {
    // Avoid competing HTTP requests on Wi-Fi during active file beaming
    if (app().state && (app().state.sending || activeReceiveBatch)) return;
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

  /* High-precision rolling window speed tracker for stable, flexible speed & ETA display */
  function createSpeedTracker(windowMs = 1200) {
    let samples = []; // array of { t: DOMHighResTimeStamp, bytes: number }
    let smoothedSpeed = 0;

    return {
      reset() {
        samples = [];
        smoothedSpeed = 0;
      },
      update(bytes, now = performance.now()) {
        samples.push({ t: now, bytes });
        const cutoff = now - windowMs;
        while (samples.length > 2 && samples[0].t < cutoff) {
          samples.shift();
        }
        if (samples.length < 2) return smoothedSpeed;

        const first = samples[0];
        const dt = (now - first.t) / 1000;
        if (dt >= 0.2) {
          const dBytes = Math.max(0, bytes - first.bytes);
          const rawSpeed = dBytes / dt;
          smoothedSpeed = smoothedSpeed === 0 ? rawSpeed : (smoothedSpeed * 0.75 + rawSpeed * 0.25);
        }
        return smoothedSpeed;
      },
    };
  }

  /* ---- Receiver state & live progress tracking ---- */
  let activeReceiveBatch = null;
  const receiveSpeedTracker = createSpeedTracker(1200);

  function onTransferProgress(msg) {
    if (!activeReceiveBatch) {
      activeReceiveBatch = {
        transfer_id: msg.transfer_id,
        sender_ip: "Peer",
        files: [{ file_name: msg.file_name, file_size: msg.total }],
        total_files: 1,
        total_size: msg.total || 0,
        current_index: 0,
        completed: 0,
      };
      receiveSpeedTracker.reset();
      app().showProgress("Receiving", conciseFileName(msg.file_name || "File", 22), "Incoming beam…");
    }

    const currentFileLoaded = msg.loaded || 0;
    const totalFile = msg.total || 1;
    const speed = receiveSpeedTracker.update(currentFileLoaded);

    const pct = Math.min(99, (currentFileLoaded / totalFile) * 100);
    const remainingBytes = Math.max(0, totalFile - currentFileLoaded);
    const eta = speed > 0 ? remainingBytes / speed : null;

    const currIdx = activeReceiveBatch.current_index || 0;
    const totalCount = activeReceiveBatch.total_files || 1;
    const role = totalCount > 1 ? `Receiving (${currIdx + 1}/${totalCount})` : "Receiving";
    const fname = msg.file_name || (activeReceiveBatch.files && activeReceiveBatch.files[currIdx] ? activeReceiveBatch.files[currIdx].name || activeReceiveBatch.files[currIdx].file_name : "");
    if (fname && app().ui.progressName) {
      app().ui.progressName.textContent = conciseFileName(fname, 22);
    }
    app().setProgress(pct, speed, currentFileLoaded, totalFile, eta);
  }

  let lastIncomingBatchRequest = null;
  let lastIncomingSingleRequest = null;

  /* ---- Incoming batch request (single toast for all files) ---- */
  function onBatchTransferRequest(msg) {
    lastIncomingBatchRequest = msg;
    if (app().setMode) app().setMode("receive");
    const totalBytes = app().fmtBytes(msg.total_size);
    const count = msg.total_files;
    const firstFile = msg.files && msg.files[0] ? (msg.files[0].file_name || msg.files[0].name) : "files";

    let summaryText;
    if (count === 1) {
      summaryText = `wants to send "${firstFile}" (${totalBytes}).`;
    } else {
      summaryText = `wants to send ${count} files (${totalBytes}): "${firstFile}" + ${count - 1} more.`;
    }

    app().showToast(
      `Device ${msg.sender_ip} ${summaryText}`,
      () => respondBatch(msg.batch_id, true, msg),
      () => respondBatch(msg.batch_id, false, msg)
    );
  }

  async function respondBatch(batchId, accept, metaMsg) {
    const meta = metaMsg || lastIncomingBatchRequest || {};
    if (accept) {
      app().playChime("confirm");
      activeReceiveBatch = {
        batch_id: batchId,
        sender_ip: meta.sender_ip || "Peer",
        files: meta.files || [],
        total_files: meta.total_files || (meta.files ? meta.files.length : 1),
        total_size: meta.total_size || 0,
        current_index: 0,
        completed: 0,
      };
      receiveSpeedTracker.reset();

      const totalCount = activeReceiveBatch.total_files;
      const role = totalCount > 1 ? `Receiving (1/${totalCount})` : "Receiving";
      const firstFileName = (meta.files && meta.files[0]) ? (meta.files[0].file_name || meta.files[0].name) : "Files";
      app().showProgress(role, conciseFileName(firstFileName, 22), meta.sender_ip ? `Beaming from Device ${meta.sender_ip}…` : "Beaming from peer…");
      app().setProgress(0, 0, 0, activeReceiveBatch.total_size, null);

      app().setOnCancelTransfer(() => {
        app().playChime("cancel");
        if (receiverCompleteTimer) {
          clearTimeout(receiverCompleteTimer);
          receiverCompleteTimer = null;
        }
        if (receiverSafetyTimer) {
          clearTimeout(receiverSafetyTimer);
          receiverSafetyTimer = null;
        }
        if (activeReceiveBatch) {
          fetch("/api/transfer/cancel", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              batch_id: activeReceiveBatch.batch_id,
              target_ip: app().state.myIp,
              sender_ip: activeReceiveBatch.sender_ip,
            }),
          }).catch(() => {});
          activeReceiveBatch = null;
        }
        app().hideProgress();
      });
    } else {
      app().playChime("cancel");
    }

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
    lastIncomingSingleRequest = msg;
    const size = app().fmtBytes(msg.file_size);
    if (app().setMode) app().setMode("receive");
    const shortName = conciseFileName(msg.file_name, 20);
    app().showToast(
      `Device ${msg.sender_ip} wants to send "${shortName}" (${size}).`,
      () => respond(msg.transfer_id, true, msg),
      () => respond(msg.transfer_id, false, msg)
    );
  }

  async function respond(transferId, accept, metaMsg) {
    const meta = metaMsg || lastIncomingSingleRequest || {};
    if (accept) {
      app().playChime("confirm");
      activeReceiveBatch = {
        transfer_id: transferId,
        sender_ip: meta.sender_ip || "Peer",
        files: [{ transfer_id: transferId, file_name: meta.file_name, file_size: meta.file_size }],
        total_files: 1,
        total_size: meta.file_size || 0,
        current_index: 0,
        completed: 0,
      };
      receiveSpeedTracker.reset();

      app().showProgress("Receiving", conciseFileName(meta.file_name || "File", 22), meta.sender_ip ? `Beaming from Device ${meta.sender_ip}…` : "Beaming from peer…");
      app().setProgress(0, 0, 0, meta.file_size || 0, null);

      app().setOnCancelTransfer(() => {
        app().playChime("cancel");
        if (receiverCompleteTimer) {
          clearTimeout(receiverCompleteTimer);
          receiverCompleteTimer = null;
        }
        if (receiverSafetyTimer) {
          clearTimeout(receiverSafetyTimer);
          receiverSafetyTimer = null;
        }
        if (activeReceiveBatch) {
          fetch("/api/transfer/cancel", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              transfer_id: activeReceiveBatch.transfer_id,
              target_ip: app().state.myIp,
              sender_ip: activeReceiveBatch.sender_ip,
            }),
          }).catch(() => {});
          activeReceiveBatch = null;
        }
        app().hideProgress();
      });
    } else {
      app().playChime("cancel");
    }

    try {
      await fetch("/api/transfer/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transfer_id: transferId, accept }),
      });
    } catch { /* best effort */ }
  }

  /* ---- Receiver completion & auto-download with exact progress synchrony ---- */
  let receiverCompleteTimer = null;
  let receiverSafetyTimer = null;

  function finishReceiverComplete(fileName) {
    if (receiverSafetyTimer) {
      clearTimeout(receiverSafetyTimer);
      receiverSafetyTimer = null;
    }
    if (receiverCompleteTimer) return;

    const displayName = fileName || (activeReceiveBatch && activeReceiveBatch.files && activeReceiveBatch.files[0] ? (activeReceiveBatch.files[0].name || activeReceiveBatch.files[0].file_name) : "File");
    app().showProgress("Complete", conciseFileName(displayName, 22), "All files received successfully!");
    app().setProgress(100, 0, 1, 1, 0);
    app().playChime("send_complete");
    app().showToast("All files received successfully!");

    receiverCompleteTimer = setTimeout(() => {
      app().hideProgress();
      activeReceiveBatch = null;
      receiverCompleteTimer = null;
    }, 1200);
  }

  function onTransferReady(msg) {
    const a = document.createElement("a");
    a.href = `/api/transfer/download/${msg.transfer_id}`;
    a.download = msg.file_name;
    document.body.appendChild(a);
    a.click();
    a.remove();

    if (activeReceiveBatch) {
      activeReceiveBatch.completed = (activeReceiveBatch.completed || 0) + 1;
      const completed = activeReceiveBatch.completed;
      const total = activeReceiveBatch.total_files || 1;

      if (completed < total) {
        activeReceiveBatch.current_index = completed;
        receiveSpeedTracker.reset();
        const nextFile = activeReceiveBatch.files[completed];
        const nextName = nextFile ? nextFile.name || nextFile.file_name : "file";
        app().showProgress(
          `Receiving (${completed + 1}/${total})`,
          conciseFileName(nextName, 22),
          `Beaming file ${completed + 1} of ${total}…`
        );
        app().setProgress(0, 0, 0, nextFile ? nextFile.size || nextFile.file_size : 0, null);
        return;
      }
    }

    // Final file reached: set overlay to Finalizing while browser saves stream to disk
    app().showProgress("Finalizing", conciseFileName(msg.file_name, 22), "Saving file to device…");
    app().setProgress(100, 0, 1, 1, 0);

    // If TRANSFER_DELIVERED already arrived before onTransferReady reached here:
    if (lastEvents.has(`delivered_${msg.transfer_id}`)) {
      finishReceiverComplete(msg.file_name);
      return;
    }

    // Safety fallback: if TRANSFER_DELIVERED is delayed or dropped, auto-complete after 4.5s
    if (receiverSafetyTimer) clearTimeout(receiverSafetyTimer);
    receiverSafetyTimer = setTimeout(() => {
      receiverSafetyTimer = null;
      finishReceiverComplete(msg.file_name);
    }, 4500);
  }

  /* ---- High-speed direct binary stream upload (sender side) ---- */
  let activeXhr = null;
  let isTransferCancelled = false;
  let activeBatchId = null;
  let activeTargetIp = null;

  function cancelActiveTransfer() {
    isTransferCancelled = true;
    app().playChime("cancel");
    if (receiverCompleteTimer) {
      clearTimeout(receiverCompleteTimer);
      receiverCompleteTimer = null;
    }
    if (receiverSafetyTimer) {
      clearTimeout(receiverSafetyTimer);
      receiverSafetyTimer = null;
    }
    if (app().hideToast) app().hideToast(true);
    if (activeXhr) {
      try { activeXhr.abort(); } catch (_) {}
      activeXhr = null;
    }
    const bId = activeBatchId;
    const tIp = activeTargetIp;
    if (bId) {
      resolveBatchPending(bId, false);
    }
    if (bId || tIp) {
      fetch("/api/transfer/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batch_id: bId || undefined,
          target_ip: tIp || undefined,
          sender_ip: app().state.myIp,
        }),
      }).catch(() => {});
    }
    app().hideProgress();
  }

  function uploadFile(transferId, file, fileIndex = 0, totalFiles = 1) {
    return new Promise((resolve, reject) => {
      if (isTransferCancelled) {
        return reject(new Error("Transfer cancelled"));
      }

      const xhr = new XMLHttpRequest();
      activeXhr = xhr;

      const uploadSpeedTracker = createSpeedTracker(1200);

      xhr.upload.onprogress = (e) => {
        if (isTransferCancelled) {
          xhr.abort();
          return;
        }
        if (!e.lengthComputable) return;

        const speed = uploadSpeedTracker.update(e.loaded);
        const pct = (e.loaded / e.total) * 100;
        const eta = speed > 0 ? (e.total - e.loaded) / speed : null;
        app().setProgress(pct, speed, e.loaded, e.total, eta);
      };

      xhr.onload = () => {
        activeXhr = null;
        if (xhr.status === 200) {
          resolve();
        } else {
          reject(new Error(`Upload failed (status ${xhr.status})`));
        }
      };

      xhr.onerror = () => {
        activeXhr = null;
        if (isTransferCancelled) {
          reject(new Error("Transfer cancelled"));
        } else {
          reject(new Error("Network upload error"));
        }
      };

      xhr.onabort = () => {
        activeXhr = null;
        reject(new Error("Transfer cancelled"));
      };

      xhr.open("POST", `/api/transfer/upload/${transferId}`);
      // Direct raw binary stream for maximum throughput — zero multipart boundary overhead
      const contentType = file.type || "application/octet-stream";
      xhr.setRequestHeader("Content-Type", contentType);
      xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
      xhr.send(file);
    });
  }

  /* ---- Send all queued files via single batch request ---- */
  async function sendAll(targetIp) {
    if (app().state.sending || !targetIp) return;
    const { state } = app();
    if (!state.queue || state.queue.length === 0) return;

    app().setSending(true);
    isTransferCancelled = false;
    activeTargetIp = targetIp;
    activeBatchId = null;
    const files = state.queue.slice();
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);

    // Register cancel listener on Beamly app
    app().setOnCancelTransfer(cancelActiveTransfer);

    try {
      app().playChime("send_start");
      app().showProgress("Requesting", `Waiting for ${targetIp} to accept…`, `Total payload: ${app().fmtBytes(totalSize)}`);

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
      activeBatchId = batch_id;
      const accepted = await waitForBatchAcceptance(batch_id);

      if (isTransferCancelled) {
        app().hideToast(true);
        return;
      }

      if (!accepted) {
        app().playChime("cancel");
        app().showToast(`Transfer was declined by ${targetIp}.`);
        return;
      }

      // If accepted, upload all files sequentially with direct streaming
      for (let i = 0; i < files.length; i++) {
        if (isTransferCancelled) break;
        const file = files[i];
        const tId = transfer_ids[i];
        const progressRole = files.length > 1 ? `Beaming (${i + 1}/${files.length})` : "Beaming";
        const progressSub = files.length > 1 ? `File ${i + 1} of ${files.length} · ${app().fmtBytes(file.size)}` : app().fmtBytes(file.size);
        app().showProgress(progressRole, conciseFileName(file.name, 22), progressSub);
        await uploadFile(tId, file, i, files.length);

        if (!isTransferCancelled) {
          const isLastFile = i === files.length - 1;
          app().showProgress(
            isLastFile ? "Finalizing" : `Beaming (${i + 1}/${files.length})`,
            conciseFileName(file.name, 22),
            isLastFile ? `Delivering to Device ${targetIp}…` : `Delivering file ${i + 1} of ${files.length}…`
          );
          app().setProgress(100, 0, file.size, file.size, 0);
          await waitForDelivery(tId, 5000);
        }
      }

      if (isTransferCancelled) {
        app().hideToast(true);
      } else {
        const lastFile = files[files.length - 1];
        app().showProgress("Complete", conciseFileName(lastFile ? lastFile.name : "Files", 22), "All files delivered successfully!");
        app().setProgress(100, 0, 1, 1, 0);
        app().playChime("send_complete");
        app().showToast(`All ${files.length} file${files.length > 1 ? "s" : ""} sent successfully!`);
        // Hold completion overlay for exactly 1200ms — in exact synchrony with receiver's 1200ms hold!
        await new Promise((r) => setTimeout(r, 1200));
      }
    } catch (err) {
      if (isTransferCancelled) {
        app().hideToast(true);
      } else {
        app().playChime("cancel");
        app().showToast(`Transfer failed: ${err.message}`);
      }
    } finally {
      const wasCancelled = isTransferCancelled;
      activeXhr = null;
      activeBatchId = null;
      activeTargetIp = null;
      isTransferCancelled = false;
      app().hideProgress();
      if (!wasCancelled) {
        app().clearQueue();
        app().deselectTarget();
      }
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

    // Keepalive pulse every 8s prevents idle timeouts across desktop & mobile browsers
    setInterval(() => {
      if (WS.socket && WS.socket.readyState === WebSocket.OPEN) {
        try { WS.socket.send("PONG"); } catch (_) {}
      }
    }, 8000);

    // Auto-recover immediately when tab is refocused or device wakes up
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        if (!WS.socket || WS.socket.readyState !== WebSocket.OPEN) {
          connectWS();
        } else {
          try { WS.socket.send("PONG"); } catch (_) {}
          refreshNow();
        }
      }
    });

    window.addEventListener("online", () => {
      connectWS();
      refreshNow();
    });
  }

  window.Beamly.net = { sendAll, refreshNow };
  document.addEventListener("DOMContentLoaded", boot);
})();
