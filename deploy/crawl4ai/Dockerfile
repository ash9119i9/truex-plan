# Official 0.9.2 multiarchitecture image, resolved 2026-10-04.
FROM unclecode/crawl4ai@sha256:bd36741e7bdd35ddc1a05d9183e1d6d8cefb61dd640d944a25d026b76e917690
COPY --chown=appuser:appuser deploy/crawl4ai/worker_api.py deploy/crawl4ai/read_worker.py /app/truex-reader/
WORKDIR /app/truex-reader
# Replace the general-purpose API/Redis entrypoint with this narrow SDK API.
CMD ["python", "-m", "uvicorn", "worker_api:app", "--host", "0.0.0.0", "--port", "11235", "--no-access-log", "--log-level", "warning"]
