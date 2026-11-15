// VLESS + WebSocket node launcher for infrlo.
// infrlo only exposes HTTPS/TCP on a fixed port (5000) via a subdomain,
// so this runs Xray-core with a VLESS+WS inbound on that port.
// Required env var: UUID (set it in the infrlo app's Settings, never commit it).
// Optional env vars: PORT (default 5000), WS_PATH (default /ws),
// ARGO_TOKEN (Cloudflare Tunnel token; when set, cloudflared is also started
// so the node is reachable through the tunnel's public hostname, which must
// point to http://localhost:5000 in the Cloudflare dashboard).

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT || '5000', 10);
const UUID = process.env.UUID;
const WS_PATH = process.env.WS_PATH || '/ws';
const ARGO_TOKEN = process.env.ARGO_TOKEN || '';
const XRAY_VERSION = 'v1.8.24';
const XRAY_DIR = path.join(__dirname, '.xray');
const XRAY_BIN = path.join(XRAY_DIR, 'xray');
const ZIP_PATH = path.join(__dirname, 'xray-download.zip');
const ZIP_URL =
  'https://github.com/XTLS/Xray-core/releases/download/' +
  XRAY_VERSION +
  '/Xray-linux-64.zip';
const CF_DIR = path.join(__dirname, '.cloudflared');
const CF_BIN = path.join(CF_DIR, 'cloudflared');
const CF_URL =
  'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';

if (!UUID) {
  console.error('ERROR: UUID environment variable is not set. Set it in the app Settings and restart.');
  process.exit(1);
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          download(res.headers.location, dest).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error('Download failed, HTTP ' + res.statusCode + ' for ' + url));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

async function ensureXray() {
  if (fs.existsSync(XRAY_BIN)) return;
  fs.mkdirSync(XRAY_DIR, { recursive: true });
  console.log('Downloading Xray-core ' + XRAY_VERSION + ' ...');
  await download(ZIP_URL, ZIP_PATH);
  const AdmZip = require('adm-zip');
  new AdmZip(ZIP_PATH).extractAllTo(XRAY_DIR, true);
  fs.chmodSync(XRAY_BIN, 0o755);
  fs.unlinkSync(ZIP_PATH);
  console.log('Xray-core ready.');
}

async function ensureCloudflared() {
  if (fs.existsSync(CF_BIN)) return;
  fs.mkdirSync(CF_DIR, { recursive: true });
  console.log('Downloading cloudflared ...');
  await download(CF_URL, CF_BIN);
  fs.chmodSync(CF_BIN, 0o755);
  console.log('cloudflared ready.');
}

function writeConfig() {
  const cfg = {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        listen: '0.0.0.0',
        port: PORT,
        protocol: 'vless',
        settings: {
          clients: [{ id: UUID }],
          decryption: 'none',
        },
        streamSettings: {
          network: 'ws',
          security: 'none',
          wsSettings: { path: WS_PATH },
        },
        sniffing: { enabled: true, destOverride: ['http', 'tls'] },
      },
    ],
    outbounds: [
      { protocol: 'freedom', tag: 'direct' },
      { protocol: 'blackhole', tag: 'blocked' },
    ],
  };
  const cfgPath = path.join(__dirname, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return cfgPath;
}

function startCloudflared() {
  console.log('Starting cloudflared tunnel ...');
  // Force HTTP/2 (TCP) transport: on infrlo the QUIC (UDP) connections were
  // dropped every ~2-3 minutes with "timeout: no recent network activity".
  const cf = spawn(
    CF_BIN,
    ['tunnel', '--no-autoupdate', '--protocol', 'http2', 'run', '--token', ARGO_TOKEN],
    { stdio: 'inherit' }
  );
  cf.on('exit', (code) => {
    console.log('cloudflared exited with code ' + code + ', restarting in 5s ...');
    setTimeout(startCloudflared, 5000);
  });
  return cf;
}

(async () => {
  await ensureXray();
  const cfgPath = writeConfig();
  console.log('Starting Xray: VLESS+WS on port ' + PORT + ', path ' + WS_PATH);
  const child = spawn(XRAY_BIN, ['run', '-config', cfgPath], { stdio: 'inherit' });
  child.on('exit', (code) => {
    console.log('Xray exited with code ' + code);
    process.exit(code == null ? 1 : code);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => child.kill(sig));
  }

  if (ARGO_TOKEN) {
    try {
      await ensureCloudflared();
      startCloudflared();
    } catch (err) {
      console.error('cloudflared setup failed (Xray keeps running):', err.message);
    }
  } else {
    console.log('ARGO_TOKEN not set; Cloudflare tunnel disabled.');
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
