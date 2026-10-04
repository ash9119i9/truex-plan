"""A stateless, authenticated API. No SDK config, hooks, JS or storage API is exposed."""
import asyncio
import contextlib
import hmac
import json
import os
import re
import signal
import shutil
import sys
import tempfile
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

TOKEN = os.environ.get("CRAWL4AI_API_TOKEN", "")
if not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", TOKEN):
    raise RuntimeError("CRAWL4AI_API_TOKEN must contain 32-256 URL-safe characters")
PROXY = os.environ.get("EGRESS_PROXY_URL", "http://browser-egress:3128")
if PROXY != "http://browser-egress:3128":
    raise RuntimeError("EGRESS_PROXY_URL must name the isolated browser proxy")
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
active = 0
cleanups = set()
MAX_ACTIVE = 2
DEADLINE = 30

def failure(code, status):
    return JSONResponse({"code": code}, status_code=status, headers={"Cache-Control": "no-store"})

@app.middleware("http")
async def authenticate(request: Request, next_handler):
    # Middleware runs before JSON parsing; credentials never appear in logs.
    if not hmac.compare_digest(request.headers.get("authorization", ""), "Bearer " + TOKEN):
        return failure("READ_CONFIGURATION", 401)
    if request.headers.get("content-length", "").isdigit() and int(request.headers["content-length"]) > 8192:
        return failure("INVALID_ARGUMENT", 413)
    response = await next_handler(request)
    response.headers["Cache-Control"] = "no-store"
    return response

@app.get("/ready")
async def ready():
    # Every browser is fresh; readiness also requires the sole egress path to accept connections.
    try:
        _, writer = await asyncio.wait_for(asyncio.open_connection("browser-egress", 3128), 2)
        writer.close()
        await writer.wait_closed()
        return {"ok": True, "provider": "crawl4ai"}
    except Exception:
        return failure("READ_UNAVAILABLE", 503)

async def disconnected(request):
    while not await request.is_disconnected():
        await asyncio.sleep(0.1)

async def stop_process(process):
    # Kill the entire process group even when the Python worker already exited:
    # Chromium grandchildren must never survive a completed/cancelled read.
    with contextlib.suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGKILL)
    with contextlib.suppress(Exception):
        await asyncio.wait_for(process.wait(), 2)

async def output(process):
    chunks, count = [], 0
    while True:
        chunk = await process.stdout.read(65536)
        if not chunk:
            break
        count += len(chunk)
        if count > 1024 * 1024:
            raise ValueError("Worker output exceeded bound")
        chunks.append(chunk)
    await process.wait()
    return json.loads(b"".join(chunks))

@app.post("/read")
@app.post("/crawl-page")
async def read(request: Request):
    global active
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 8192:
            return failure("INVALID_ARGUMENT", 413)
    try:
        value = json.loads(raw)
        is_crawl = request.url.path == "/crawl-page"
        if not isinstance(value, dict) or set(value) != ({"url", "maxChars", "allowedHost"} if is_crawl else {"url", "maxChars"}):
            raise ValueError()
        if not isinstance(value["url"], str) or len(value["url"]) > 2048:
            raise ValueError()
        if type(value["maxChars"]) is not int or not 1 <= value["maxChars"] <= 50000:
            raise ValueError()
        from read_worker import valid_url
        parts = valid_url(value["url"])
        if is_crawl and (not isinstance(value["allowedHost"], str) or value["allowedHost"] != parts.hostname.lower().rstrip(".")):
            raise ValueError()
    except Exception:
        return failure("INVALID_ARGUMENT", 400)
    if active >= MAX_ACTIVE:
        return failure("READ_RATE_LIMITED", 429)
    active += 1
    process = None
    scratch = None
    tasks = []
    try:
        scratch = tempfile.mkdtemp(prefix="truex-read-", dir="/tmp")
        process = await asyncio.create_subprocess_exec(sys.executable, "read_worker.py", stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, start_new_session=True,
            env={**os.environ, "CRAWL4AI_API_TOKEN": "", "HOME": scratch, "TMPDIR": scratch, "CRAWL4AI_BASE_DIRECTORY": scratch,
                 "PLAYWRIGHT_BROWSERS_PATH": "/home/appuser/.cache/ms-playwright"})
        process.stdin.write(json.dumps(value).encode())
        await process.stdin.drain()
        process.stdin.close()
        result = asyncio.create_task(output(process))
        disconnect = asyncio.create_task(disconnected(request))
        tasks = [result, disconnect]
        done, _ = await asyncio.wait(tasks, timeout=DEADLINE, return_when=asyncio.FIRST_COMPLETED)
        if disconnect in done:
            return failure("READ_CANCELLED", 499)
        if result not in done:
            return failure("READ_TIMEOUT", 504)
        payload = await result
        if payload.get("code"):
            statuses = {"READ_BLOCKED": 403, "READ_NOT_FOUND": 404, "READ_UNSUPPORTED": 415,
                        "READ_EMPTY": 422, "READ_RATE_LIMITED": 429, "READ_TIMEOUT": 504}
            return failure(payload["code"] if payload["code"] in statuses else "READ_UNAVAILABLE", statuses.get(payload["code"], 503))
        return JSONResponse(payload)
    except asyncio.CancelledError:
        raise
    except Exception:
        return failure("READ_UNAVAILABLE", 503)
    finally:
        for task in tasks:
            task.cancel()
        async def cleanup():
            global active
            try:
                if process:
                    await stop_process(process)
            finally:
                try:
                    if scratch:
                        await asyncio.to_thread(shutil.rmtree, scratch, True)
                    await asyncio.gather(*tasks, return_exceptions=True)
                finally:
                    active -= 1
        cleanup_task = asyncio.create_task(cleanup())
        # Keep a strong reference and shield the WHOLE cleanup, including unlinking
        # scratch, so cancellation during kill/wait cannot skip directory removal.
        cleanups.add(cleanup_task)
        cleanup_task.add_done_callback(cleanups.discard)
        await asyncio.shield(cleanup_task)
