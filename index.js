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
    // The container's local DNS resolver intermittently times out (seen in
    // cloudflared logs), so resolve target domains through public DNS and
    // prefer IPv4, whose egress path is the reliable one here.
    dns: {
      servers: ['1.1.1.1', '8.8.8.8'],
      queryStrategy: 'UseIPv4',
    },
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
      { protocol: 'freedom', tag: 'direct', settings: { domainStrategy: 'UseIPv4' } },
      { protocol: 'blackhole', tag: 'blocked' },
    ],
  };
  const cfgPath = path.join(__dirname, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return cfgPath;
}

// --- cloudflared supervision -------------------------------------------
// On 2026-11-15 the tunnel died silently: cloudflared never logged a
// disconnect, but its attempts to refresh the container's local DNS
// resolver kept timing out ("lookup region1.v2.argotunnel.com: i/o
// timeout") and the tunnel never re-registered, leaving the public
// hostname at Cloudflare 530 while the app showed Running. Two defences:
// 1) Resolve the tunnel edge IPs ourselves through 1.1.1.1/8.8.8.8
//    (bypassing the container resolver) and pass them via --edge, so
//    cloudflared does not need the container DNS to reach the edge.
// 2) Poll cloudflared's metrics /ready endpoint; if it reports no
//    registered connections for 3 checks in a row, kill it so the
//    supervisor restarts and re-registers it.
let cfProc = null;
let cfUseEdge = true;
let cfRapidExits = 0;
let cfStartedAt = 0;
let cfBadChecks = 0;

async function resolveEdgeAddrs() {
  const { Resolver } = require('dns').promises;
  const resolver = new Resolver();
  resolver.setServers(['1.1.1.1', '8.8.8.8']);
  const ips = [];
  for (const name of ['region1.v2.argotunnel.com', 'region2.v2.argotunnel.com']) {
    try {
      const addrs = await resolver.resolve4(name);
      for (const ip of addrs.slice(0, 2)) {
        if (!ips.includes(ip)) ips.push(ip);
      }
    } catch (err) {
      console.log('edge resolve failed for ' + name + ': ' + err.message);
    }
  }
  return ips;
}

async function startCloudflared() {
  let edgeArgs = [];
  if (cfUseEdge) {
    const ips = await resolveEdgeAddrs();
    if (ips.length) {
      edgeArgs = [];
      for (const ip of ips) edgeArgs.push('--edge', ip + ':7844');
      console.log('cloudflared edge IPs (via 1.1.1.1): ' + ips.join(', '));
    } else {
      console.log('edge resolution returned nothing; falling back to default edge discovery.');
    }
  }
  console.log('Starting cloudflared tunnel ...');
  // Force HTTP/2 (TCP) transport: on infrlo the QUIC (UDP) connections were
  // dropped every ~2-3 minutes with "timeout: no recent network activity".
  cfStartedAt = Date.now();
  cfBadChecks = 0;
  const cf = spawn(
    CF_BIN,
    [
      'tunnel',
      '--no-autoupdate',
      '--protocol',
      'http2',
      '--metrics',
      '127.0.0.1:19090',
      ...edgeArgs,
      'run',
      '--token',
      ARGO_TOKEN,
    ],
    { stdio: 'inherit' }
  );
  cfProc = cf;
  cf.on('exit', (code) => {
    if (cfProc === cf) cfProc = null;
    const lived = Date.now() - cfStartedAt;
    if (edgeArgs.length && lived < 25000) {
      cfRapidExits += 1;
      if (cfRapidExits >= 2) {
        cfUseEdge = false;
        console.log('cloudflared keeps exiting quickly with --edge; disabling --edge for future starts.');
      }
    } else {
      cfRapidExits = 0;
    }
    console.log('cloudflared exited with code ' + code + ', restarting in 5s ...');
    setTimeout(() => {
      startCloudflared().catch((err) => console.error('cloudflared restart failed:', err.message));
    }, 5000);
  });
  return cf;
}

function startCfMonitor() {
  const http = require('http');
  setInterval(() => {
    if (!cfProc) return; // the exit handler is already restarting it
    let settled = false;
    const req = http.get('http://127.0.0.1:19090/ready', (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        settled = true;
        let ready = 0;
        try {
          ready = JSON.parse(body).readyConnections || 0;
        } catch (err) {
          /* keep ready = 0 */
        }
        if (res.statusCode === 200 && ready > 0) {
          cfBadChecks = 0;
          return;
        }
        cfBadChecks += 1;
        console.log(
          'cloudflared health check bad (' + cfBadChecks + '/3): HTTP ' + res.statusCode + ', readyConnections ' + ready
        );
        if (cfBadChecks >= 3 && cfProc) {
          console.log('cloudflared unhealthy 3 checks in a row; killing it so it re-registers.');
          cfBadChecks = 0;
          cfProc.kill('SIGKILL');
        }
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('health check timeout')));
    req.on('error', (err) => {
      if (settled) return;
      cfBadChecks += 1;
      console.log('cloudflared health check error (' + cfBadChecks + '/3): ' + err.message);
      if (cfBadChecks >= 3 && cfProc) {
        console.log('cloudflared unreachable 3 checks in a row; killing it so it re-registers.');
        cfBadChecks = 0;
        cfProc.kill('SIGKILL');
      }
    });
  }, 60000);
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
      await startCloudflared();
      startCfMonitor();
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
