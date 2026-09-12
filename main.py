from __future__ import annotations

import asyncio
import io
import os
import tempfile
import time
import uuid
from typing import Dict, List, Optional

from fastapi import FastAPI, File, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from urllib.parse import quote

from pydantic import BaseModel

app = FastAPI(title="Beamly Engine", version="1.0.0")


class NoCacheHTMLMiddleware(BaseHTTPMiddleware):
    """Never let browsers cache index.html — CSS/JS carry ?v= cache busters,
    so a fresh HTML document guarantees a fresh UI."""

    async def dispatch(self, request, call_next):
        response = await call_next(request)
        if request.url.path in ("/", "/index.html"):
            response.headers["Cache-Control"] = "no-store, must-revalidate"
        return response


app.add_middleware(NoCacheHTMLMiddleware)

RAM_BUFFER_LIMIT = int(os.environ.get("BEAMLY_RAM_LIMIT", 256 * 1024 * 1024))  # 256 MB
TRANSFER_TTL_SECONDS = 300  # 5 minutes
HEARTBEAT_INTERVAL = 4
HEARTBEAT_TIMEOUT = 12
UPLOAD_CHUNK_SIZE = 1024 * 1024  # 1 MB


class TransferRequest(BaseModel):
    sender_ip: str
    target_ip: str
    file_name: str
    file_size: int
    file_type: Optional[str] = None


class TransferResponse(BaseModel):
    transfer_id: str
    accept: bool


class BatchFileItem(BaseModel):
    name: str
    size: int
    type: Optional[str] = "application/octet-stream"


class BatchTransferRequest(BaseModel):
    sender_ip: str
    target_ip: str
    files: List[BatchFileItem]
    total_size: int


class BatchTransferResponse(BaseModel):
    batch_id: str
    accept: bool


class ConnectionManager:
    def __init__(self) -> None:
        self.active_connections: Dict[str, WebSocket] = {}
        self.peer_info: Dict[str, dict] = {}

    async def connect(self, client_ip: str, websocket: WebSocket) -> None:
        await websocket.accept()
        self.active_connections[client_ip] = websocket
        now = time.time()
        self.peer_info[client_ip] = {
            "ip": client_ip,
            "online": True,
            "connected_at": now,
            "last_seen": now,
            "offline_since": None,
        }

    def disconnect(self, client_ip: str) -> None:
        self.active_connections.pop(client_ip, None)
        if client_ip in self.peer_info:
            self.peer_info[client_ip]["online"] = False
            self.peer_info[client_ip]["offline_since"] = time.time()

    def record_activity(self, client_ip: str) -> None:
        if client_ip in self.peer_info:
            self.peer_info[client_ip]["last_seen"] = time.time()
            self.peer_info[client_ip]["online"] = True

    def is_active(self, client_ip: str) -> bool:
        return client_ip in self.active_connections

    async def send(self, client_ip: str, payload: dict) -> bool:
        ws = self.active_connections.get(client_ip)
        if ws is None:
            return False
        try:
            await asyncio.wait_for(ws.send_json(payload), timeout=HEARTBEAT_TIMEOUT)
            return True
        except Exception:
            self.disconnect(client_ip)
            return False

    async def heartbeat_loop(self) -> None:
        while True:
            await asyncio.sleep(HEARTBEAT_INTERVAL)
            now = time.time()
            for ip in list(self.active_connections.keys()):
                info = self.peer_info.get(ip)
                if info and (now - info.get("last_seen", now) > HEARTBEAT_TIMEOUT):
                    self.disconnect(ip)
                    continue
                if not await self.send(ip, {"type": "PING"}):
                    self.disconnect(ip)

            # Prune peers that have been offline for more than 45 seconds
            for ip, info in list(self.peer_info.items()):
                if not info["online"]:
                    off_since = info.get("offline_since") or now
                    if (now - off_since) > 45:
                        self.peer_info.pop(ip, None)


class EphemeralTransferStore:
    def __init__(self) -> None:
        self._transfers: Dict[str, dict] = {}
        self._batches: Dict[str, dict] = {}
        self._tmp_dir = tempfile.mkdtemp(prefix="beamly-")

    def create(self, transfer_id: str, filename: str, file_type: str, file_size: int) -> None:
        self._transfers[transfer_id] = {
            "transfer_id": transfer_id,
            "filename": filename,
            "content_type": file_type,
            "size": file_size,
            "sender_ip": None,
            "target_ip": None,
            "status": "requested",
            "spooled": False,
            "buffer": None,
            "tmp_path": None,
            "created_at": time.time(),
        }

    def register_batch(
        self, batch_id: str, sender_ip: str, target_ip: str, transfer_ids: List[str]
    ) -> None:
        self._batches[batch_id] = {
            "batch_id": batch_id,
            "sender_ip": sender_ip,
            "target_ip": target_ip,
            "transfer_ids": transfer_ids,
            "status": "requested",
            "created_at": time.time(),
        }

    def get_batch(self, batch_id: str) -> Optional[dict]:
        return self._batches.get(batch_id)

    def set_ips(self, transfer_id: str, sender_ip: str, target_ip: str) -> None:
        entry = self._transfers.get(transfer_id)
        if entry:
            entry["sender_ip"] = sender_ip
            entry["target_ip"] = target_ip

    def set_status(self, transfer_id: str, status: str) -> None:
        entry = self._transfers.get(transfer_id)
        if entry:
            entry["status"] = status

    def get(self, transfer_id: str) -> Optional[dict]:
        return self._transfers.get(transfer_id)

    def open_buffer(self, transfer_id: str) -> Optional[object]:
        entry = self._transfers.get(transfer_id)
        if entry is None:
            return None
        if entry["size"] > RAM_BUFFER_LIMIT:
            path = os.path.join(self._tmp_dir, f"{transfer_id}.blob")
            entry["spooled"] = True
            entry["tmp_path"] = path
            return open(path, "wb+")
        buffer = io.BytesIO()
        entry["buffer"] = buffer
        return buffer

    def _cleanup(self, entry: dict) -> None:
        if entry.get("buffer") is not None:
            try:
                entry["buffer"].close()
            except Exception:
                pass
            entry["buffer"] = None
        if entry.get("tmp_path"):
            try:
                os.remove(entry["tmp_path"])
            except OSError:
                pass
            entry["tmp_path"] = None

    def _release(self, transfer_id: str) -> None:
        entry = self._transfers.pop(transfer_id, None)
        if entry:
            self._cleanup(entry)

    def download(self, transfer_id: str) -> Optional[dict]:
        entry = self._transfers.pop(transfer_id, None)
        if entry is None:
            return None
        if entry["status"] != "ready":
            self._cleanup(entry)
            return None
        return entry

    def sweep_expired(self) -> None:
        now = time.time()
        for transfer_id, entry in list(self._transfers.items()):
            if now - entry["created_at"] > TRANSFER_TTL_SECONDS:
                self._release(transfer_id)
        for batch_id, batch in list(self._batches.items()):
            if now - batch["created_at"] > TRANSFER_TTL_SECONDS:
                self._batches.pop(batch_id, None)

    async def ttl_loop(self) -> None:
        while True:
            await asyncio.sleep(15)
            self.sweep_expired()


manager = ConnectionManager()
store = EphemeralTransferStore()


def _sanitize_filename(filename: str) -> str:
    cleaned = "".join(ch for ch in filename if ch not in ('"', "'", "\r", "\n", "\\"))
    return cleaned or "beamly-transfer.bin"


def _content_disposition(filename: str) -> str:
    return (
        "attachment; filename=\"transfer.bin\"; "
        f"filename*=UTF-8''{quote(_sanitize_filename(filename))}"
    )


async def _notify_upload_complete(transfer_id: str) -> None:
    entry = store.get(transfer_id)
    if entry is None:
        return
    await manager.send(
        entry["target_ip"],
        {
            "type": "TRANSFER_READY",
            "transfer_id": transfer_id,
            "file_name": entry["filename"],
            "file_size": entry["size"],
        },
    )
    await manager.send(
        entry["sender_ip"],
        {"type": "TRANSFER_UPLOADED", "transfer_id": transfer_id},
    )


@app.on_event("startup")
async def on_startup() -> None:
    asyncio.create_task(manager.heartbeat_loop())
    asyncio.create_task(store.ttl_loop())


@app.websocket("/ws/{client_ip}")
async def websocket_endpoint(websocket: WebSocket, client_ip: str) -> None:
    await manager.connect(client_ip, websocket)
    try:
        while True:
            try:
                message = await asyncio.wait_for(
                    websocket.receive_text(), timeout=HEARTBEAT_TIMEOUT
                )
            except asyncio.TimeoutError:
                if not await manager.send(client_ip, {"type": "PING"}):
                    break
                continue
            manager.record_activity(client_ip)
            if message == "PONG":
                continue
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        manager.disconnect(client_ip)


@app.get("/api/peers")
async def get_local_peers(request: Request) -> dict:
    caller_ip = request.client.host if request.client else None
    result = []
    for ip, info in manager.peer_info.items():
        if ip == caller_ip:
            continue
        result.append({
            "ip": ip,
            "status": "online" if info.get("online") else "offline"
        })
    return {"peers": result}


@app.get("/api/config")
async def get_config() -> dict:
    return {
        "max_ram_file_size": RAM_BUFFER_LIMIT,
        "transfer_ttl_seconds": TRANSFER_TTL_SECONDS,
    }


@app.get("/api/self")
async def get_self_ip(request: Request) -> dict:
    client = request.client.host if request.client else "0.0.0.0"
    return {"ip": client}


@app.post("/api/transfer/request")
async def request_transfer(payload: TransferRequest) -> dict:
    if payload.sender_ip == payload.target_ip:
        raise HTTPException(status_code=400, detail="Cannot send to yourself")
    if not manager.is_active(payload.sender_ip):
        raise HTTPException(status_code=404, detail="Sender not active")
    if not manager.is_active(payload.target_ip):
        raise HTTPException(status_code=404, detail="Target peer not active")
    if payload.file_size < 1:
        raise HTTPException(status_code=400, detail="Invalid file size")

    transfer_id = f"{uuid.uuid4().hex[:12]}"
    store.create(
        transfer_id,
        payload.file_name,
        payload.file_type or "application/octet-stream",
        payload.file_size,
    )
    store.set_ips(transfer_id, payload.sender_ip, payload.target_ip)

    delivered = await manager.send(
        payload.target_ip,
        {
            "type": "TRANSFER_REQUEST",
            "transfer_id": transfer_id,
            "sender_ip": payload.sender_ip,
            "file_name": payload.file_name,
            "file_size": payload.file_size,
            "file_type": payload.file_type,
        },
    )
    if not delivered:
        store._release(transfer_id)
        raise HTTPException(status_code=503, detail="Target peer unreachable")

    return {"status": "requested", "transfer_id": transfer_id}


@app.post("/api/transfer/respond")
async def respond_transfer(payload: TransferResponse) -> dict:
    entry = store.get(payload.transfer_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Transfer not found")
    if entry["status"] == "ready":
        return {"status": "ok"}
    if entry["status"] == "accepted":
        return {"status": "ok"}

    if payload.accept:
        entry["status"] = "accepted"
        await manager.send(
            entry["sender_ip"],
            {
                "type": "TRANSFER_ACCEPTED",
                "transfer_id": payload.transfer_id,
                "file_name": entry["filename"],
            },
        )
    else:
        await manager.send(
            entry["sender_ip"],
            {
                "type": "TRANSFER_DECLINED",
                "transfer_id": payload.transfer_id,
                "file_name": entry["filename"],
            },
        )
        store._release(payload.transfer_id)
    return {"status": "ok"}


@app.post("/api/transfer/batch/request")
async def request_batch_transfer(payload: BatchTransferRequest) -> dict:
    if payload.sender_ip == payload.target_ip:
        raise HTTPException(status_code=400, detail="Cannot send to yourself")
    if not manager.is_active(payload.sender_ip):
        raise HTTPException(status_code=404, detail="Sender not active")
    if not manager.is_active(payload.target_ip):
        raise HTTPException(status_code=404, detail="Target peer not active")
    if not payload.files:
        raise HTTPException(status_code=400, detail="No files provided")

    batch_id = f"b_{uuid.uuid4().hex[:10]}"
    file_metas = []
    transfer_ids = []
    for f in payload.files:
        t_id = f"{uuid.uuid4().hex[:12]}"
        store.create(t_id, f.name, f.type or "application/octet-stream", f.size)
        store.set_ips(t_id, payload.sender_ip, payload.target_ip)
        transfer_ids.append(t_id)
        file_metas.append({
            "transfer_id": t_id,
            "file_name": f.name,
            "file_size": f.size,
            "file_type": f.type,
        })
    store.register_batch(batch_id, payload.sender_ip, payload.target_ip, transfer_ids)

    delivered = await manager.send(
        payload.target_ip,
        {
            "type": "BATCH_TRANSFER_REQUEST",
            "batch_id": batch_id,
            "sender_ip": payload.sender_ip,
            "total_files": len(payload.files),
            "total_size": payload.total_size,
            "files": file_metas,
        },
    )
    if not delivered:
        for t_id in transfer_ids:
            store._release(t_id)
        raise HTTPException(status_code=503, detail="Target peer unreachable")

    return {"status": "requested", "batch_id": batch_id, "transfer_ids": transfer_ids}


@app.post("/api/transfer/batch/respond")
async def respond_batch_transfer(payload: BatchTransferResponse) -> dict:
    batch = store.get_batch(payload.batch_id)
    if batch is None:
        raise HTTPException(status_code=404, detail="Batch transfer not found")

    sender_ip = batch["sender_ip"]
    transfer_ids = batch["transfer_ids"]

    if payload.accept:
        batch["status"] = "accepted"
        for t_id in transfer_ids:
            store.set_status(t_id, "accepted")
        await manager.send(
            sender_ip,
            {
                "type": "BATCH_TRANSFER_ACCEPTED",
                "batch_id": payload.batch_id,
                "transfer_ids": transfer_ids,
            },
        )
    else:
        batch["status"] = "declined"
        for t_id in transfer_ids:
            store.set_status(t_id, "declined")
            store._release(t_id)
        await manager.send(
            sender_ip,
            {
                "type": "BATCH_TRANSFER_DECLINED",
                "batch_id": payload.batch_id,
            },
        )
    return {"status": "ok"}


@app.post("/api/transfer/upload/{transfer_id}")
async def upload_stream(transfer_id: str, file: UploadFile = File(...)) -> dict:
    entry = store.get(transfer_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Transfer not found or expired")
    if entry["status"] not in ("requested", "accepted"):
        raise HTTPException(status_code=409, detail="Transfer is not accepting uploads")

    buffer = store.open_buffer(transfer_id)
    if buffer is None:
        raise HTTPException(status_code=404, detail="Transfer not found")

    written = 0
    try:
        while True:
            chunk = await file.read(UPLOAD_CHUNK_SIZE)
            if not chunk:
                break
            buffer.write(chunk)
            written += len(chunk)
        buffer.seek(0)
        if written > 0:
            entry["size"] = written
            entry["content_type"] = file.content_type or entry["content_type"]
            entry["status"] = "ready"
            await _notify_upload_complete(transfer_id)
    except Exception:
        store._release(transfer_id)
        raise HTTPException(status_code=500, detail="Upload failed")
    finally:
        if entry.get("spooled"):
            buffer.close()

    return {"status": "ready", "transfer_id": transfer_id, "size": written}


@app.get("/api/transfer/download/{transfer_id}")
async def download_stream(transfer_id: str) -> StreamingResponse:
    entry = store.download(transfer_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Transfer expired or already downloaded")

    def file_iterator() -> object:
        if entry.get("spooled"):
            handle = open(entry["tmp_path"], "rb")
        else:
            handle = entry.get("buffer") or io.BytesIO()
        try:
            while True:
                chunk = handle.read(UPLOAD_CHUNK_SIZE)
                if not chunk:
                    break
                yield chunk
        finally:
            handle.close()
            store._cleanup(entry)

    return StreamingResponse(
        file_iterator(),
        media_type=entry["content_type"],
        headers={
            "Content-Disposition": _content_disposition(entry["filename"]),
            "Content-Length": str(entry["size"]),
            "Cache-Control": "no-store",
        },
    )


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    return FileResponse("static/images/beamly-logo.png", media_type="image/png")


app.mount("/", StaticFiles(directory="static", html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
