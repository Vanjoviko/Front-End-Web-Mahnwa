#!/usr/bin/env bash
# Menjalankan lingkungan pengembangan lokal Scan Import: sumber fixture + worker Python (BE) + FE.
# Semua konten sumber adalah placeholder orisinal buatan generator. HANYA untuk pengembangan lokal (memakai SCAN_DEV_MODE=true).
#
#   scripts/dev-start.sh            # jalankan semua, Ctrl+C untuk berhenti
#   BE_DIR=/path/ke/Back-End-Web-Mahnwa scripts/dev-start.sh
#
# Variabel opsional: BE_DIR, FE_PORT(3000) WORKER_PORT(8000) FIXTURE_PORT(9100), WORKER_TOKEN(dev-token),
#   ADMIN_USER(admin) ADMIN_PASSWORD(admin-dev), FE_DATA_DIR(<FE>/.dev-data), LOG_DIR(/tmp/lembar-dev),
#   HOST_MIN_DELAY_MS(0), SKIP_INSTALL=1 (jangan membuat venv / pip install).
set -euo pipefail

FE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -z "${BE_DIR:-}" ]; then
  for cand in "$FE_DIR/../Back-End-Web-Mahnwa" "$FE_DIR/../be" "$FE_DIR/../backend"; do
    if [ -d "$cand/app/scan" ]; then BE_DIR="$(cd "$cand" && pwd)"; break; fi
  done
fi
[ -n "${BE_DIR:-}" ] && [ -d "$BE_DIR/app/scan" ] || { echo "Repo BE tidak ditemukan. Set BE_DIR=/path/ke/Back-End-Web-Mahnwa" >&2; exit 1; }
command -v node >/dev/null || { echo "Node.js 20+ diperlukan" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl diperlukan" >&2; exit 1; }

FE_PORT="${FE_PORT:-3000}"; WORKER_PORT="${WORKER_PORT:-8000}"; FIXTURE_PORT="${FIXTURE_PORT:-9100}"
TOKEN="${WORKER_TOKEN:-dev-token}"
LOG_DIR="${LOG_DIR:-/tmp/lembar-dev}"; mkdir -p "$LOG_DIR"
FE_DATA_DIR="${FE_DATA_DIR:-$FE_DIR/.dev-data}"; mkdir -p "$FE_DATA_DIR"

# Interpreter BE: pakai .venv lokal bila ada, jika tidak fallback ke python3 sistem
# (mis. WSL/box tanpa python3-venv). Venv hanya dibuat bila keduanya tidak memenuhi.
BE_DEPS='import fastapi, uvicorn, httpx, pydantic, PIL'
PY="$BE_DIR/.venv/bin/python"
if [ ! -x "$PY" ]; then
  if command -v python3 >/dev/null && python3 -c "$BE_DEPS" 2>/dev/null; then
    PY="$(command -v python3)"
    echo ">> memakai python3 sistem ($PY); dependensi runtime sudah terpasang"
  else
    [ "${SKIP_INSTALL:-0}" = "1" ] && { echo "venv BE belum ada ($BE_DIR/.venv) dan python3 sistem tidak punya dependensi; SKIP_INSTALL=1" >&2; exit 1; }
    echo ">> membuat venv BE dan memasang dependensi runtime (sekali saja)"
    if ! python3 -m venv "$BE_DIR/.venv" 2>/dev/null; then
      echo "GAGAL membuat venv (modul python3-venv/ensurepip tidak tersedia)." >&2
      echo "Pasang paket venv OS (mis. 'sudo apt install python3-venv' atau 'python3.14-venv')," >&2
      echo "atau pasang dependensi ke python3 sistem lalu jalankan ulang:" >&2
      echo "  python3 -m pip install --user fastapi 'uvicorn[standard]' httpx pydantic sqlalchemy pillow" >&2
      exit 1
    fi
    "$BE_DIR/.venv/bin/pip" install -q fastapi "uvicorn[standard]" httpx pydantic sqlalchemy pillow
    PY="$BE_DIR/.venv/bin/python"
  fi
fi
"$PY" -c "$BE_DEPS" 2>/dev/null || {
  echo "Dependensi BE belum lengkap untuk $PY. Pasang lalu jalankan ulang:" >&2
  echo "  \"$PY\" -m pip install fastapi 'uvicorn[standard]' httpx pydantic sqlalchemy pillow" >&2
  exit 1
}

PIDS=()
cleanup() { trap - EXIT INT TERM; echo; echo ">> menghentikan layanan"; for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup EXIT INT TERM

wait_http() { # url nama
  for _ in $(seq 1 60); do curl -fsS -o /dev/null "$1" 2>/dev/null && return 0; sleep 0.5; done
  echo "GAGAL: $2 tidak siap di $1 (lihat $LOG_DIR)" >&2; return 1
}

echo ">> sumber fixture (placeholder orisinal) :$FIXTURE_PORT"
( cd "$BE_DIR" && exec "$PY" -m tools.fixture_source --root .fixture-data --port "$FIXTURE_PORT" ) >"$LOG_DIR/fixture.log" 2>&1 &
PIDS+=($!)
wait_http "http://127.0.0.1:$FIXTURE_PORT/menara-biru/manifest.json" "sumber fixture"

echo ">> worker Python :$WORKER_PORT"
( cd "$BE_DIR" && SCAN_DEV_MODE=true WORKER_TOKEN="$TOKEN" WORKER_PORT="$WORKER_PORT" WORKER_BIND=127.0.0.1 \
    PUBLIC_BASE_URL="http://127.0.0.1:$WORKER_PORT" SCAN_HOST_MIN_DELAY_MS="${HOST_MIN_DELAY_MS:-0}" \
    SCAN_MIN_FREE_DISK_BYTES="${SCAN_MIN_FREE_DISK_BYTES:-1}" exec "$PY" -m app ) >"$LOG_DIR/worker.log" 2>&1 &
PIDS+=($!)
wait_http "http://127.0.0.1:$WORKER_PORT/health" "worker"

echo ">> front-end :$FE_PORT (data: $FE_DATA_DIR)"
( cd "$FE_DIR" && LEMBAR_DATA_DIR="$FE_DATA_DIR" PORT="$FE_PORT" HOST=127.0.0.1 \
    ADMIN_USER="${ADMIN_USER:-admin}" ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin-dev}" \
    SCAN_WORKER_URL="http://127.0.0.1:$WORKER_PORT" SCAN_WORKER_TOKEN="$TOKEN" SCAN_DEV_MODE=true \
    SCAN_MIN_FREE_BYTES=1000000 exec node server.js ) >"$LOG_DIR/fe.log" 2>&1 &
PIDS+=($!)
wait_http "http://127.0.0.1:$FE_PORT/api/health" "front-end"

cat <<MSG

Siap.
  FE      : http://127.0.0.1:$FE_PORT/#admin   (login ${ADMIN_USER:-admin} / ${ADMIN_PASSWORD:-admin-dev})
  Worker  : http://127.0.0.1:$WORKER_PORT/health
  Sumber  : http://127.0.0.1:$FIXTURE_PORT/menara-biru/manifest.json   (tempel di tab "Scan Import")
  Log     : $LOG_DIR/{fixture,worker,fe}.log
Ctrl+C untuk berhenti.
MSG
wait
