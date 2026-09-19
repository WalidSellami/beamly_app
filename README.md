# Beamly

> **Zero-install, instant local network file & media transfer.**  
> A browser-based, luxury peer-to-peer sharing experience inspired by Apple AirDrop and Samsung Quick Share — powered by **FastAPI**, **WebSockets**, **httptools**, and **high-speed in-memory streaming**.

---

## ✨ Features & Highlights

### 🔄 Live Transfer Progress Overlay (Sender & Receiver Synchrony)
- **Bilateral Real-Time Visibility**: Both sender and receiver see the same glowing progress overlay with dynamic percentage, transfer speed, bytes counter, and smoothed ETA.
- **Exact Millisecond Synchrony**: When the receiver's browser finishes downloading the final byte, the server dispatches a simultaneous `TRANSFER_DELIVERED` event to **both** devices. Both overlays immediately transition to `"Complete"`, chime, hold the 100% finished state for exactly **1200ms**, and dismiss in perfect unison.
- **Concentric Dial Visual**: SVG circular ring with glowing gradients and fluid CSS transitions.
- **Progressive ETA & Speed Dampening**: Built-in rolling-window speed smoothing and predictive countdown prevent erratic ETA jumping (e.g. steady countdown from `21s left` → `Finishing…` → `Done`).

### 📦 Multi-File Batch Transfers
- **Single-Prompt Batch Approval**: Queue multiple files and send them in one go. The recipient receives **one consolidated toast notification** with an intelligent file summary (e.g. `wants to send 3 files (14.2 MB): "photo1.jpg" + 2 more`).
- **One-Click Accept or Decline**: Accepting approves the entire batch and streams files sequentially; declining rejects the whole transfer without repetitive popups.
- **Smart Filename Formatting**: Long filenames are concisely formatted (e.g. `annual_financial_report_2026…pdf`) to prevent clipping or layout overflows on mobile screens.

### ⚡ Ultra-Fast High-Throughput Streaming
- **Raw Binary Stream**: Transfers bypass multipart boundary parsing overhead by streaming directly as binary octet streams.
- **Optimized Wi-Fi Airtime**: Progress broadcasts are throttled to 350ms (`BEAMLY_PROGRESS_INTERVAL`), eliminating half-duplex Wi-Fi packet contention and preserving maximum transfer bandwidth.
- **High-Speed Buffers**: 8 MB chunk streaming buffers (`BEAMLY_CHUNK_SIZE`) and C-based `httptools` parser deliver high-speed local throughput across gigabit LAN and 5GHz Wi-Fi.

### 🛑 Clean One-Click Cancellation
- **Graceful Stream Interruption**: Pressing **"Cancel Beam"** cleanly aborts active transfers without triggering `500 Internal Server Error` in the server terminal.
- **Instant Bilateral Reset**: Dispatches `TRANSFER_CANCELLED` to instantly dismiss incoming prompts on the peer device and immediately releases all allocated memory and temporary files.

### 🌐 Dynamic Peer Presence & Signal Status
- **Real-Time Heartbeat Discovery**: Active devices on the same Wi-Fi or LAN subnet automatically register and discover each other via WebSockets.
- **Dynamic Signal Indicators**:
  - **Emerald Green Dot (Pulsing)**: Active, online, and discoverable peers ready to beam.
  - **Ruby Red Dot (Pulsing)**: Unreachable or recently disconnected peers.
- **Graceful Offline Handling**: Disconnected peers transition to red and remain visible for a short grace period (45s) before pruning, preventing abrupt UI vanishing.

### 💎 Luxury Glassmorphism 2.0 Interface
- **Default Dark Glassmorphic Aesthetic**: Boots directly into Beamly's dark frosted glass mode with ambient aurora glows (`beamly-theme-v2`).
- **Pro Radar Beacon**: Ready-to-Receive mode features a beacon inspired by flagship mobile ecosystems, illuminated with the Beamly brand logo and concentric acoustic energy rings.
- **Floating High-Contrast Send Dock**: An elevated, glowing glass dock featuring a custom device selector, payload counter pill, and glowing neon action button with dedicated dock clearance.
- **Adaptive Dropzone**: Displays a spacious drag-and-drop area when empty, smoothly collapses into a compact **48px "Add more files"** bar once files are queued, and automatically resets when finished.
- **Synthesized Web Audio Chimes**: Smooth acoustic feedback for beam initiation, incoming requests, and completion.

### 🛡️ Ephemeral In-Memory Architecture
- **Zero Disk Footprint**: Standard transfers stream directly through RAM (`io.BytesIO`) — nothing is permanently stored on disk.
- **Automatic Spooling**: Files exceeding the configurable RAM limit (default: 512 MB) automatically spool to a temporary disk buffer to prevent memory exhaustion.
- **Single-Use Downloads & Auto TTL**: Transfers are strictly single-use and automatically cleaned up upon download or after 5 minutes of inactivity.

---

## 🚀 Quick Start

### 1. Prerequisites
- Python 3.9+ installed on your machine.
- Devices must be connected to the same local network (Wi-Fi or LAN).

### 2. Installation

```bash
# Download the project repository then
cd beamly

# Create and activate a virtual environment
python -m venv .venv

# Windows (PowerShell / Command Prompt)
.venv\Scripts\activate

# macOS / Linux
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

### 3. Launch the Server

Start Beamly bound to all local network interfaces:

```bash
uvicorn main:app --host 0.0.0.0 --port 8000
```

### 4. Connect & Share
- On the host machine: Open `http://localhost:8000` (or `http://127.0.0.1:8000`).
- On other phones, laptops, or tablets on the same Wi-Fi: Open `http://<HOST_LAN_IP>:8000` (e.g. `http://192.168.1.27:8000`).
- *Tip: Ensure port `8000` is allowed through your host firewall.*

---

## ⚙️ Configuration

Beamly is pre-configured for optimal local transfers out of the box, but can be customized via environment variables:

| Variable | Default | Description |
|---|---|---|
| `BEAMLY_RAM_LIMIT` | `536870912` (512 MB) | Max payload size kept purely in memory; larger transfers spool to temporary disk storage. |
| `BEAMLY_CHUNK_SIZE` | `8388608` (8 MB) | Read/write stream buffer chunk size for high-speed network I/O. |
| `BEAMLY_PROGRESS_INTERVAL` | `0.35` (350 ms) | Throttle interval for progress WebSocket broadcasts to prevent Wi-Fi airtime congestion. |

---

## 🏗️ Project Structure

```text
beamly/
├── main.py                     # FastAPI server, WebSocket presence, batch & streaming endpoints
├── requirements.txt            # Python dependencies (fastapi, uvicorn, python-multipart, httptools)
├── static/
│   ├── index.html              # Responsive single-page application
│   ├── css/
│   │   └── styles.css          # Design system, glassmorphic themes, animations
│   ├── images/
│   │   └── beamly-logo.png     # Official high-resolution brand asset
│   └── js/
│       ├── app.js              # UI controller, theme physics, audio synthesis, queue state
│       └── network.js          # WebSocket client, batch transfer handshakes, chunked upload/download
└── README.md                   # Documentation
```

---

## 🔌 API Architecture

### WebSocket Handshake & Protocols
- `GET /ws/{client_ip}`: Bidirectional channel maintaining real-time peer presence, heartbeat ping/pongs, and instant transfer requests/notifications.
- **WebSocket Message Types**:
  - `PING` / `PONG`: Subnet liveness verification.
  - `BATCH_TRANSFER_REQUEST` / `BATCH_TRANSFER_ACCEPTED` / `BATCH_TRANSFER_DECLINED`: Consolidated batch handshake.
  - `TRANSFER_PROGRESS`: Real-time transfer statistics sent to receiver.
  - `TRANSFER_READY`: Alerts recipient that file upload has completed and download can begin.
  - `TRANSFER_DELIVERED`: Simultaneous broadcast to sender and receiver when the download finishes for synchronized overlay dismissal.
  - `TRANSFER_CANCELLED`: Immediate bilateral abort notification.

### REST Endpoints
- `GET /api/self`: Returns the client's detected IP address on the local subnet.
- `GET /api/peers`: Returns all discovered nearby peers along with their current status (`online` / `offline`).
- `GET /api/config`: Returns runtime configuration (RAM buffer limit, transfer TTL).
- `POST /api/transfer/batch/request`: Initiates a batch transfer session for multiple queued files.
- `POST /api/transfer/batch/respond`: Accepts or declines an entire batch transfer in a single action.
- `POST /api/transfer/upload/{transfer_id}`: Streams file data directly into the ephemeral buffer.
- `GET /api/transfer/download/{transfer_id}`: Streams file data directly to the recipient's browser and frees the buffer.
- `POST /api/transfer/cancel`: Gracefully aborts single or batch transfers and notifies peers.