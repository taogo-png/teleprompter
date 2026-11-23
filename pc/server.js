// Servidor do controle no PC. Roda com: npm run dev
// Abre o painel em http://localhost:3333 e conversa com o app no iPhone pelo Wi-Fi.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3333;
const FILE = path.join(__dirname, 'roteiro.txt');
const PAGE = path.join(__dirname, 'control.html');

let text = '';
try { text = fs.readFileSync(FILE, 'utf8'); } catch (e) {}

const state = { rev: 1, text, playing: false, speed: 4, size: 32, cmdSeq: 0, cmd: '', follow: { on: false, word: 0 } };
const phone = { lastSeen: 0, progress: 0, recording: false };

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); } });
  });
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function snapshot(withText = true) {
  const out = { ...state, phone: { online: Date.now() - phone.lastSeen < 2500, progress: phone.progress, recording: phone.recording } };
  if (!withText) delete out.text;
  return out;
}

function apply(b) {
  let changed = false;
  if (typeof b.text === 'string' && b.text !== state.text) {
    state.text = b.text.slice(0, 500000);
    fs.writeFile(FILE, state.text, () => {});
    changed = true;
  }
  if (typeof b.playing === 'boolean') { state.playing = b.playing; changed = true; }
  if (b.speed >= 1 && b.speed <= 12) { state.speed = +b.speed; changed = true; }
  if (b.size >= 18 && b.size <= 80) { state.size = +b.size; changed = true; }
  if (changed) state.rev++;
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(PAGE).pipe(res);
  }
  if (req.method === 'GET' && url === '/state') return send(res, 200, snapshot());
  if (req.method === 'POST' && url === '/state') {
    apply(await readBody(req));
    return send(res, 200, snapshot(false));
  }
  if (req.method === 'POST' && url === '/cmd') {
    const b = await readBody(req);
    if (['top', 'back', 'fwd', 'rec'].includes(b.c)) {
      state.cmdSeq++;
      state.cmd = b.c;
      if (b.c === 'top') { state.playing = false; state.rev++; }
    }
    return send(res, 200, snapshot(false));
  }
  if (req.method === 'POST' && url === '/follow') {
    const b = await readBody(req);
    if (typeof b.on === 'boolean') state.follow.on = b.on;
    if (Number.isInteger(b.word) && b.word >= 0) state.follow.word = b.word;
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url === '/phone') {
    const b = await readBody(req);
    phone.lastSeen = Date.now();
    if (typeof b.progress === 'number') phone.progress = Math.max(0, Math.min(1, b.progress));
    phone.recording = !!b.recording;
    return send(res, 200, snapshot(b.rev !== state.rev));
  }
  send(res, 404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log('\n  Teleprompter · controle');
  console.log(`  Painel:  http://localhost:${PORT}`);
  ips.forEach((ip) => console.log(`  IP do PC na rede: ${ip}`));
  console.log('');
  if (process.argv.includes('--expo') || process.argv.includes('--open')) {
    // abre o painel no navegador
    const opener = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    setTimeout(() => spawn(`${opener} http://localhost:${PORT}`, { shell: true, stdio: 'ignore' }), 1500);
  }
  if (process.argv.includes('--expo')) {
    const child = spawn('npx', ['expo', 'start'], { stdio: 'inherit', shell: true });
    child.on('exit', (code) => process.exit(code || 0));
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`A porta ${PORT} já está em uso. Feche o outro terminal do teleprompter.`);
  else console.error(e);
  process.exit(1);
});
