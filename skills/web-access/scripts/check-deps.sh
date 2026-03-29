#!/usr/bin/env bash
# 环境检查 + 确保 CDP Proxy 就绪（OceanKing 适配版）

# Node.js
if command -v node &>/dev/null; then
  NODE_VER=$(node --version 2>/dev/null)
  NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 22 ] 2>/dev/null; then
    echo "node: ok ($NODE_VER)"
  else
    echo "node: warn ($NODE_VER, 建议升级到 22+)"
  fi
else
  echo "node: missing — 请安装 Node.js 22+"
  exit 1
fi

# Chrome 调试端口发现策略：
# 1) 优先读取 DevToolsActivePort
# 2) 再试经典固定端口
# 3) 最后扫描高位临时端口，但只接受能对 /devtools/browser 完成 websocket 握手的端口
if ! CHROME_PORT=$(node -e "
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

function checkPort(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, '127.0.0.1');
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 800);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}

function testBrowserWs(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, '127.0.0.1');
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 1200);
    socket.once('error', () => { clearTimeout(timer); resolve(false); });
    socket.once('connect', () => {
      socket.write([
        'GET /devtools/browser HTTP/1.1',
        'Host: 127.0.0.1:' + port,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGVzdGtleTEyMzQ1Njc4OQ==',
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'));
    });
    socket.once('data', (chunk) => {
      clearTimeout(timer);
      const text = chunk.toString('utf8');
      socket.destroy();
      resolve(text.includes('101 WebSocket'));
    });
  });
}

function activePortFiles() {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || '';
  switch (process.platform) {
    case 'darwin':
      return [
        path.join(home, 'Library/Application Support/Google/Chrome/DevToolsActivePort'),
        path.join(home, 'Library/Application Support/Google/Chrome Canary/DevToolsActivePort'),
        path.join(home, 'Library/Application Support/Chromium/DevToolsActivePort'),
      ];
    case 'linux':
      return [
        path.join(home, '.config/google-chrome/DevToolsActivePort'),
        path.join(home, '.config/chromium/DevToolsActivePort'),
      ];
    case 'win32':
      return [
        path.join(localAppData, 'Google/Chrome/User Data/DevToolsActivePort'),
        path.join(localAppData, 'Chromium/User Data/DevToolsActivePort'),
      ];
    default:
      return [];
  }
}

(async () => {
  for (const filePath of activePortFiles()) {
    try {
      const lines = fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
      const port = parseInt(lines[0], 10);
      if (port > 0 && port < 65536 && await checkPort(port) && await testBrowserWs(port)) {
        console.log(port);
        process.exit(0);
      }
    } catch (_) {}
  }

  for (const port of [9222, 9229, 9333]) {
    if (await checkPort(port) && await testBrowserWs(port)) {
      console.log(port);
      process.exit(0);
    }
  }

  for (let port = 40000; port <= 65000; port++) {
    if (await checkPort(port) && await testBrowserWs(port)) {
      console.log(port);
      process.exit(0);
    }
  }

  process.exit(1);
})();
" 2>/dev/null); then
  echo "chrome: not connected — 请打开 chrome://inspect/#remote-debugging 并勾选 Allow remote debugging"
  exit 1
fi

echo "chrome: ok (port $CHROME_PORT)"
export CDP_CHROME_PORT="$CHROME_PORT"

# CDP Proxy — 用 /targets 统一判断：返回 JSON 数组即 ready，失败则启动并重试
TARGETS=$(curl -s --connect-timeout 3 "http://127.0.0.1:3456/targets" 2>/dev/null)
if echo "$TARGETS" | grep -q '^\['; then
  echo "proxy: ready"
else
  echo "proxy: connecting..."
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  node "$SCRIPT_DIR/cdp-proxy.mjs" > /tmp/cdp-proxy.log 2>&1 &
  sleep 2
  for i in $(seq 1 15); do
    curl -s --connect-timeout 5 --max-time 8 http://127.0.0.1:3456/targets 2>/dev/null | grep -q '^\[' && echo "proxy: ready" && exit 0
    [ $i -eq 1 ] && echo "⚠️  Chrome 可能有授权弹窗，请点击「允许」后等待连接..."
  done
  echo "❌ 连接超时，请检查 Chrome 调试设置"
  exit 1
fi
