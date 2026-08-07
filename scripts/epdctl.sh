#!/usr/bin/env bash
# Moulin-EPDServer Linux 原生一键后台管理（不依赖 Docker）
# 用法: ./scripts/epdctl.sh {start|stop|restart|status|logs|update}

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="$ROOT_DIR/.env"
ENV_EXAMPLE="$ROOT_DIR/.env.example"
RUN_DIR="$ROOT_DIR/run"
LOG_DIR="$ROOT_DIR/logs"
DATA_DIR="$ROOT_DIR/data"
PID_FILE="$RUN_DIR/epdserver.pid"
LOG_FILE="$LOG_DIR/epdserver.log"
FRONTEND_DIST="$ROOT_DIR/frontend/dist"
SERVER_DIR="$ROOT_DIR/server"
FRONTEND_DIR="$ROOT_DIR/frontend"

die() {
  echo "错误: $*" >&2
  exit 1
}

info() {
  echo "=> $*"
}

NVM_VERSION="v0.40.6"
NODE_MAJOR_MIN=22
# 国内镜像（EPD_NPM_MIRROR=0 可关闭）
NPM_REGISTRY_CN="${NPM_REGISTRY_CN:-https://registry.npmmirror.com}"
NODE_DIST_MIRROR_CN="${NODE_DIST_MIRROR_CN:-https://npmmirror.com/mirrors/node}"
PLAYWRIGHT_MIRROR_CN="${PLAYWRIGHT_MIRROR_CN:-https://npmmirror.com/mirrors/playwright}"

require_linux() {
  case "$(uname -s)" in
    Linux) ;;
    *) die "此脚本面向 Linux。当前系统: $(uname -s)" ;;
  esac
}

run_privileged() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    return 1
  fi
}

configure_cn_mirrors() {
  # 默认启用国内源；导出为当前进程环境，不改用户全局 npm config
  if [[ "${EPD_NPM_MIRROR:-1}" == "0" ]]; then
    info "已跳过国内 npm 镜像（EPD_NPM_MIRROR=0）"
    return 0
  fi
  export npm_config_registry="${npm_config_registry:-$NPM_REGISTRY_CN}"
  export npm_config_disturl="${npm_config_disturl:-$NODE_DIST_MIRROR_CN}"
  export npm_config_node_mirror="${npm_config_node_mirror:-$NODE_DIST_MIRROR_CN}"
  export NVM_NODEJS_ORG_MIRROR="${NVM_NODEJS_ORG_MIRROR:-$NODE_DIST_MIRROR_CN}"
  export PLAYWRIGHT_DOWNLOAD_HOST="${PLAYWRIGHT_DOWNLOAD_HOST:-$PLAYWRIGHT_MIRROR_CN}"
  info "使用国内镜像: npm=${npm_config_registry}"
}

load_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh"
    return 0
  fi
  return 1
}

install_nvm() {
  command -v curl >/dev/null 2>&1 || die "未找到 curl，无法自动安装 nvm（需要 Node.js ${NODE_MAJOR_MIN}+）"
  info "未检测到可用 Node.js，正在安装 nvm ${NVM_VERSION} ..."
  curl -o- "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash
  load_nvm || die "nvm 已安装但仍无法加载（NVM_DIR=${NVM_DIR}），请重新打开终端后重试"
}

node_major() {
  node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo "0"
}

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  command -v npm >/dev/null 2>&1 || return 1
  local major
  major="$(node_major)"
  [[ "$major" -ge "$NODE_MAJOR_MIN" ]]
}

require_node() {
  configure_cn_mirrors

  # 当前 PATH 已有合格 Node 则直接使用
  if node_ok; then
    return 0
  fi

  # 尝试加载已安装的 nvm（新开 shell 时 node 可能不在 PATH）
  if load_nvm && node_ok; then
    info "已从 nvm 加载 Node.js $(node -v)"
    return 0
  fi

  # 无 nvm 则按官方脚本安装
  if ! load_nvm; then
    install_nvm
  fi

  info "通过 nvm 安装 Node.js ${NODE_MAJOR_MIN} ..."
  nvm install "$NODE_MAJOR_MIN"
  nvm use "$NODE_MAJOR_MIN"
  # 方便后续新开 shell（若用户已配置 nvm）默认落到可用版本
  nvm alias default "$NODE_MAJOR_MIN" >/dev/null 2>&1 || true

  node_ok || die "需要 Node.js ${NODE_MAJOR_MIN}+，当前: $(command -v node >/dev/null 2>&1 && node -v || echo '未安装')"
  info "Node.js $(node -v) / npm $(npm -v) 就绪"
}

missing_build_tools() {
  local missing=()
  command -v python3 >/dev/null 2>&1 || missing+=("python3")
  command -v make >/dev/null 2>&1 || missing+=("make")
  if ! command -v g++ >/dev/null 2>&1 && ! command -v c++ >/dev/null 2>&1; then
    missing+=("g++")
  fi
  if [[ ${#missing[@]} -gt 0 ]]; then
    printf '%s\n' "${missing[@]}"
  fi
}

install_build_tools() {
  info "正在安装编译工具（better-sqlite3 等原生模块需要 python3 / make / g++）..."
  if command -v apt-get >/dev/null 2>&1; then
    run_privileged apt-get update -y \
      && run_privileged apt-get install -y build-essential python3
  elif command -v dnf >/dev/null 2>&1; then
    run_privileged dnf install -y gcc-c++ make python3
  elif command -v yum >/dev/null 2>&1; then
    run_privileged yum install -y gcc-c++ make python3
  elif command -v apk >/dev/null 2>&1; then
    run_privileged apk add --no-cache build-base python3
  else
    return 1
  fi
}

require_build_tools() {
  local missing
  missing="$(missing_build_tools || true)"
  if [[ -z "${missing}" ]]; then
    return 0
  fi

  info "缺少原生编译依赖: ${missing//$'\n'/ }"
  if install_build_tools; then
    missing="$(missing_build_tools || true)"
    if [[ -z "${missing}" ]]; then
      info "编译工具已就绪"
      return 0
    fi
  fi

  die "缺少编译工具（${missing//$'\n'/ }）。better-sqlite3 需要 python3、make、g++。
Debian/Ubuntu: sudo apt-get update && sudo apt-get install -y build-essential python3
RHEL/CentOS:   sudo dnf install -y gcc-c++ make python3
Alpine:        sudo apk add --no-cache build-base python3"
}

random_secret() {
  local bytes="${1:-48}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 "$bytes" | tr -d '\n=+/_' | head -c 48
    return
  fi
  if [[ -r /dev/urandom ]]; then
    head -c "$bytes" /dev/urandom | base64 | tr -d '\n=+/_' | head -c 48
    return
  fi
  die "无法生成随机密钥（需要 openssl 或 /dev/urandom）。"
}

set_env_var() {
  local key="$1"
  local value="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    if sed --version >/dev/null 2>&1; then
      sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    else
      sed -i '' "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    fi
  else
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi
}

ensure_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    [[ -f "$ENV_EXAMPLE" ]] || die "缺少 .env.example，无法自动生成 .env"

    local master_key admin_password
    master_key="$(random_secret 48)"
    admin_password="$(random_secret 24)"
    while [[ ${#master_key} -lt 32 ]]; do
      master_key+="$(random_secret 16)"
    done

    cp "$ENV_EXAMPLE" "$ENV_FILE"
    set_env_var "EPD_MASTER_KEY" "$master_key"
    set_env_var "EPD_ADMIN_PASSWORD" "$admin_password"
    chmod 600 "$ENV_FILE" || true

    cat <<EOF

已自动创建 .env（权限 600），请妥善保存以下凭据：

  管理用户名: $(grep -E '^EPD_ADMIN_USERNAME=' "$ENV_FILE" | cut -d= -f2-)
  管理密码:   ${admin_password}
  主密钥:     已写入 .env（EPD_MASTER_KEY）

EOF
  fi

  local port
  port="$(read_web_port)"
  # 原生单进程托管前后端时，默认把 CORS 指向本机访问地址
  if ! grep -qE '^EPD_ALLOWED_ORIGINS=' "$ENV_FILE" \
    || grep -qE '^EPD_ALLOWED_ORIGINS=http://localhost:5088$' "$ENV_FILE"; then
    set_env_var "EPD_ALLOWED_ORIGINS" "http://127.0.0.1:${port},http://localhost:${port}"
  fi
}

read_web_port() {
  local port="5088"
  if [[ -f "$ENV_FILE" ]]; then
    local value
    value="$(grep -E '^EPD_WEB_PORT=' "$ENV_FILE" | head -n1 | cut -d= -f2- || true)"
    if [[ -n "${value:-}" ]]; then
      port="$value"
    fi
  fi
  echo "$port"
}

load_dotenv() {
  [[ -f "$ENV_FILE" ]] || return 0
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
}

is_running() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [[ -n "${pid:-}" ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

npm_install() {
  local dir="$1"
  if [[ -f "$dir/package-lock.json" ]]; then
    (cd "$dir" && npm ci)
  else
    (cd "$dir" && npm install)
  fi
}

install_deps() {
  info "安装 server 依赖 ..."
  npm_install "$SERVER_DIR"

  info "安装 frontend 依赖 ..."
  npm_install "$FRONTEND_DIR"

  info "安装 Playwright Chromium ..."
  if (cd "$SERVER_DIR" && npx playwright install --with-deps chromium); then
    :
  else
    info "--with-deps 失败（可能缺少 sudo），改为仅安装浏览器二进制 ..."
    (cd "$SERVER_DIR" && npx playwright install chromium) \
      || die "Playwright Chromium 安装失败。可手动执行: cd server && npx playwright install --with-deps chromium"
  fi
}

write_build_info() {
  mkdir -p "$RUN_DIR"
  local version git_sha build_time
  version="${EPD_VERSION:-}"
  if [[ -z "$version" && -f "$SERVER_DIR/package.json" ]]; then
    version="$(node -p "require('${SERVER_DIR}/package.json').version" 2>/dev/null || true)"
  fi
  git_sha="${EPD_GIT_SHA:-}"
  if [[ -z "$git_sha" ]] && command -v git >/dev/null 2>&1; then
    git_sha="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || true)"
  fi
  build_time="${EPD_BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

  cat >"$RUN_DIR/build-info.env" <<EOF
EPD_VERSION=${version}
EPD_GIT_SHA=${git_sha}
EPD_BUILD_TIME=${build_time}
EOF
  info "编译版本: ${version}${git_sha:+ · ${git_sha}} · ${build_time}"
}

load_build_info() {
  if [[ -f "$RUN_DIR/build-info.env" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$RUN_DIR/build-info.env"
    set +a
  fi
  # 若尚未写入（例如直接 restart 前未 build），运行时补齐
  if [[ -z "${EPD_VERSION:-}" && -f "$SERVER_DIR/package.json" ]]; then
    EPD_VERSION="$(node -p "require('${SERVER_DIR}/package.json').version" 2>/dev/null || true)"
  fi
  if [[ -z "${EPD_GIT_SHA:-}" ]] && command -v git >/dev/null 2>&1; then
    EPD_GIT_SHA="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || true)"
  fi
  export EPD_VERSION="${EPD_VERSION:-}"
  export EPD_GIT_SHA="${EPD_GIT_SHA:-}"
  export EPD_BUILD_TIME="${EPD_BUILD_TIME:-}"
}

build_all() {
  info "构建 backend ..."
  (cd "$SERVER_DIR" && npm run build)

  info "构建 frontend ..."
  (cd "$FRONTEND_DIR" && npm run build)

  [[ -f "$FRONTEND_DIST/index.html" ]] || die "前端构建失败：未找到 frontend/dist/index.html"
  write_build_info
}

start_process() {
  mkdir -p "$RUN_DIR" "$LOG_DIR" "$DATA_DIR/snapshots"

  if is_running; then
    die "服务已在运行（PID $(cat "$PID_FILE")）。可用: $0 status / $0 restart"
  fi

  load_dotenv
  load_build_info

  local port
  port="$(read_web_port)"

  export EPD_DEBUG="${EPD_DEBUG:-false}"
  export EPD_COOKIE_SECURE="${EPD_COOKIE_SECURE:-false}"
  export EPD_DATA_DIR="$DATA_DIR"
  export EPD_SNAPSHOT_DIR="$DATA_DIR/snapshots"
  export EPD_DATABASE_URL="${EPD_DATABASE_URL:-sqlite+aiosqlite:///${DATA_DIR}/epdserver.db}"
  export EPD_FRONTEND_DIR="$FRONTEND_DIST"
  export EPD_ALLOWED_ORIGINS="${EPD_ALLOWED_ORIGINS:-http://127.0.0.1:${port},http://localhost:${port}}"
  export HOST="${HOST:-0.0.0.0}"
  export PORT="${PORT:-$port}"
  # curl 通但 Node fetch 失败时，常见于双栈竞速；强制 IPv4 优先并关闭自动选族。
  local node_flags=(--dns-result-order=ipv4first --no-network-family-autoselection)
  if [[ -z "${NODE_OPTIONS:-}" ]]; then
    export NODE_OPTIONS="${node_flags[*]}"
  else
    for flag in "${node_flags[@]}"; do
      local key="${flag%%=*}"
      if [[ " ${NODE_OPTIONS} " != *" ${key}"* && " ${NODE_OPTIONS} " != *" ${flag} "* ]]; then
        export NODE_OPTIONS="${NODE_OPTIONS} ${flag}"
      fi
    done
  fi

  info "后台启动 Node 服务（PORT=${PORT}）..."
  # 在 server 目录启动，保证相对路径与 ts 构建产物一致
  (
    cd "$SERVER_DIR"
    nohup node dist/index.js >>"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
  )

  sleep 1
  if ! is_running; then
    rm -f "$PID_FILE"
    die "启动失败，请查看日志: $LOG_FILE"
  fi
}

print_access() {
  local port host_ip
  port="$(read_web_port)"
  host_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo
  info "已在后台运行（PID $(cat "$PID_FILE")）"
  if [[ -n "${host_ip:-}" ]]; then
    echo "  访问地址: http://${host_ip}:${port}"
  fi
  echo "  本机地址: http://127.0.0.1:${port}"
  echo "  日志文件: $LOG_FILE"
  echo "  数据目录: $DATA_DIR"
  echo "  查看状态: $0 status"
  echo "  查看日志: $0 logs -f"
  echo "  停止服务: $0 stop"
}

cmd_start() {
  require_linux
  require_node
  require_build_tools
  ensure_env
  install_deps
  build_all
  start_process
  print_access
}

cmd_stop() {
  if ! is_running; then
    info "服务未在运行"
    rm -f "$PID_FILE"
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  info "停止服务（PID ${pid}）..."
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 0.25
  done
  if kill -0 "$pid" 2>/dev/null; then
    info "进程未退出，发送 SIGKILL ..."
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  info "已停止"
}

cmd_restart() {
  require_linux
  require_node
  ensure_env
  if is_running; then
    cmd_stop
  fi
  # 重启默认不重装依赖，仅重建并启动；需要全量更新请用 update
  build_all
  start_process
  print_access
}

cmd_status() {
  if is_running; then
    local pid port
    pid="$(cat "$PID_FILE")"
    port="$(read_web_port)"
    echo "状态: 运行中"
    echo "PID:  $pid"
    echo "端口: ${PORT:-$port}"
    echo "日志: $LOG_FILE"
    if command -v curl >/dev/null 2>&1; then
      if curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
        echo "健康检查: OK"
      else
        echo "健康检查: 无响应（进程在，接口未就绪或端口不一致）"
      fi
    fi
  else
    echo "状态: 未运行"
    exit 1
  fi
}

cmd_logs() {
  mkdir -p "$LOG_DIR"
  touch "$LOG_FILE"
  if [[ "${1:-}" == "logs" ]]; then
    shift
  fi
  if [[ "${1:-}" == "-f" || "${1:-}" == "--follow" ]]; then
    tail -n 100 -f "$LOG_FILE"
  else
    if [[ $# -gt 0 ]]; then
      tail "$@" "$LOG_FILE"
    else
      tail -n 100 "$LOG_FILE"
    fi
  fi
}

cmd_update() {
  require_linux
  require_node
  require_build_tools
  ensure_env
  if is_running; then
    cmd_stop
  fi
  install_deps
  build_all
  start_process
  print_access
}

usage() {
  cat <<EOF
Moulin-EPDServer Linux 原生后台管理脚本（不依赖 Docker）

用法:
  $0 start      安装依赖、构建并后台启动（无 .env 时自动生成）
  $0 stop       停止后台进程
  $0 restart    重新构建并重启（不重装依赖）
  $0 status     查看运行状态
  $0 logs       查看日志（可加 -f）
  $0 update     重装依赖、重建并启动（代码/依赖更新后）

依赖: Node.js 22+、npm（缺失时自动装 nvm/Node 22）、curl、python3/make/g++（缺失时尝试 apt/dnf 安装）
镜像: 默认 npmmirror（EPD_NPM_MIRROR=0 关闭）
数据: ./data   日志: ./logs/epdserver.log   PID: ./run/epdserver.pid

生产环境更推荐使用 Docker Compose，见 README。
EOF
}

main() {
  local action="${1:-}"
  case "$action" in
    start) cmd_start ;;
    stop) cmd_stop ;;
    restart) cmd_restart ;;
    status) cmd_status ;;
    logs) cmd_logs "$@" ;;
    update) cmd_update ;;
    -h|--help|help|"") usage ;;
    *)
      usage
      die "未知命令: $action"
      ;;
  esac
}

main "$@"