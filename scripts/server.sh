#!/usr/bin/env bash
# notebook-lm-clone — запуск локального стенда (Docker = Linux-контейнеры).
#
#   ./scripts/server.sh up         поднять api+web, дождаться готовности, открыть Chrome
#   ./scripts/server.sh down       остановить
#   ./scripts/server.sh restart    перезапустить
#   ./scripts/server.sh rebuild    пересобрать образы и поднять (после правок кода)
#   ./scripts/server.sh status     что сейчас запущено
#   ./scripts/server.sh logs [-f]  логи контейнеров
#   ./scripts/server.sh open       открыть в Chrome, ничего не поднимая
#   ./scripts/server.sh dev        dev-режим без Docker (api :4001 + vite :5173)
#
# Флаги:  --no-open  не открывать браузер;  --timeout N  сколько ждать готовности (сек).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${NB_PORT:-8085}"
URL="http://localhost:${PORT}"
READY_TIMEOUT=180
OPEN_BROWSER=1
FOLLOW=0
DEV=0

die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
info() { printf '\033[36m→ %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$*"; }

need_docker() {
  docker info >/dev/null 2>&1 || die "Docker не запущен. Открой Docker Desktop и повтори."
  docker compose version >/dev/null 2>&1 || die "Нет docker compose (v2+)."
}

port_busy() {
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | grep -q LISTEN
}

# Ждём, пока web начнёт отвечать 200 на /api/health через nginx-прокси.
wait_ready() {
  local timeout="$1" waited=0
  info "Жду готовности на ${URL} (до ${timeout}s)…"
  while [ "$waited" -lt "$timeout" ]; do
    if curl -fsS -m 3 -o /dev/null "${URL}/api/health" 2>/dev/null; then
      ok "Стенд отвечает: ${URL}/api/health"
      return 0
    fi
    # Не ждём всю тишину: если контейнер умер — падаем сразу с логом.
    if [ "$(docker compose ps --status exited --quiet 2>/dev/null | wc -l | tr -d ' ')" != "0" ]; then
      echo
      docker compose ps
      echo "--- последние строки лога api ---"
      docker compose logs --tail=40 api 2>&1 || true
      die "Контейнер api вышел с ошибкой — смотри лог выше."
    fi
    sleep 2
    waited=$((waited + 2))
    printf '\r   %ss…' "$waited"
  done
  printf '\r'
  docker compose ps || true
  docker compose logs --tail=40 2>&1 || true
  die "Не дождались готовности за ${timeout}s."
}

open_chrome() {
  info "Открываю Chrome: ${URL}"
  open -a "Google Chrome" "$URL"
}

do_up() {
  need_docker
  command -v docker >/dev/null || die "docker не найден в PATH."

  if [ ! -f apps/api/.env ]; then
    die "Нет apps/api/.env — скопируй apps/api/.env.example и заполни ключи."
  fi

  if port_busy; then
    info "Порт ${PORT} уже занят кем-то другим — проверь, не мешает ли это."
  fi

  # Первый раз образов нет — тогда up сам их соберёт.
  if docker image inspect notebook-api:latest >/dev/null 2>&1 &&
     docker image inspect notebook-web:latest >/dev/null 2>&1; then
    info "Образы уже собраны, поднимаю…"
    docker compose up -d
  else
    info "Образов нет — собираю (первый раз это долго)…"
    docker compose up -d --build
  fi

  wait_ready "$READY_TIMEOUT"
  [ "$OPEN_BROWSER" -eq 1 ] && open_chrome
  echo
  docker compose ps
}

do_rebuild() {
  need_docker
  info "Пересобираю образы…"
  docker compose up -d --build "$@"
  wait_ready "$READY_TIMEOUT"
  [ "$OPEN_BROWSER" -eq 1 ] && open_chrome
  echo
  docker compose ps
}

do_down() {
  need_docker
  info "Останавливаю стенд…"
  docker compose down
  ok "Остановлен."
}

do_restart() {
  need_docker
  info "Перезапускаю…"
  docker compose restart
  wait_ready "$READY_TIMEOUT"
  [ "$OPEN_BROWSER" -eq 1 ] && open_chrome
}

do_status() {
  need_docker
  docker compose ps
  echo
  if curl -fsS -m 3 "${URL}/api/health" 2>/dev/null; then
    echo
    ok "Стенд живой: ${URL}"
  else
    echo
    info "Стенд не отвечает. Поднять: ./scripts/server.sh up"
  fi
}

do_logs() {
  need_docker
  if [ "$FOLLOW" -eq 1 ]; then
    docker compose logs -f
  else
    docker compose logs --tail=100
  fi
}

do_dev() {
  [ -f apps/api/.env ] || die "Нет apps/api/.env"
  info "Dev-режим: api :4001, web :5173. Остановить — Ctrl+C."
  DEV=1
  pnpm dev &
  local pid=$!
  sleep 6
  open_chrome_dev
  wait "$pid"
}

open_chrome_dev() { open -a "Google Chrome" "http://localhost:5173"; }

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; }

# --- разбор аргументов ---------------------------------------------------
case "${1:-}" in
  -h|--help|help)
    usage
    exit 0 ;;
esac

CMD="${1:-up}"; shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --no-open) OPEN_BROWSER=0 ;;
    -f|--follow) FOLLOW=1 ;;
    --timeout) shift; READY_TIMEOUT="${1:?--timeout требует число}" ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Неизвестный флаг: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

case "$CMD" in
  up)      do_up ;;
  rebuild) do_rebuild ;;
  down)    do_down ;;
  stop)    do_down ;;
  restart) do_restart ;;
  status)  do_status ;;
  logs)    do_logs ;;
  open)    open_chrome ;;
  dev)     do_dev ;;
  *) die "Неизвестная команда: ${CMD}. Список: ./scripts/server.sh --help" ;;
esac