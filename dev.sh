#!/bin/bash
# E-P2-P5（ENG 审计 2026-09-21）：dev.sh 与 Makefile 长期漂移（compose v1 假设、
# uv --system vs uv venv、并行安装流程不一致）。本脚本头注早已自承「以 Makefile 为准」，
# 现收口为薄转发，消除第二套开发入口；行为一律以 Makefile 目标为准。
# Usage: ./dev.sh [start|infra|stop|status|clean]
set -euo pipefail

case "${1:-start}" in
  start)  exec make dev ;;
  infra)  exec make infra-up ;;
  stop)   exec make infra-down ;;
  status) exec make status ;;
  clean)  exec make clean ;;
  *) echo "Usage: ./dev.sh [start|infra|stop|status|clean]" >&2; exit 1 ;;
esac
