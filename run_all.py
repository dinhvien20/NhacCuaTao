import os
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend" / "app.py"
FRONTEND = ROOT / "frontend"

backend_process = None
frontend_process = None


def start_backend():
    global backend_process
    backend_process = subprocess.Popen(
        [sys.executable, str(BACKEND)],
        cwd=str(ROOT),
        env={**os.environ, "PORT": "5000"},
    )


def start_frontend():
    global frontend_process
    frontend_process = subprocess.Popen(
        [sys.executable, "-m", "http.server", "8080", "--bind", "0.0.0.0"],
        cwd=str(FRONTEND),
    )


def shutdown(signum=None, frame=None):
    if frontend_process:
        frontend_process.terminate()
    if backend_process:
        backend_process.terminate()
    raise SystemExit(0)


if __name__ == "__main__":
    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    start_backend()
    time.sleep(0.5)
    start_frontend()
    print("Backend: http://localhost:5000 (bound to 0.0.0.0)")
    print("Frontend: http://localhost:8080 (bound to 0.0.0.0)")
    print("Press Ctrl+C to stop both services.")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        shutdown()
