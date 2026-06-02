const { spawn } = require('child_process');

function spawnProcess(cmd, args, opts = {}) {
  const p = spawn(cmd, args, { stdio: 'inherit', env: process.env, ...opts });
  p.on('exit', (code, signal) => {
    if (signal) {
      console.log(`${cmd} terminated with signal ${signal}`);
    } else {
      console.log(`${cmd} exited with code ${code}`);
    }
  });
  p.on('error', (err) => {
    console.error(`${cmd} failed:`, err);
  });
  return p;
}

console.log('Starting ws-server and Next dev...');

const children = [];

// start ws server
children.push(spawnProcess(process.execPath, ['server/ws-server.js']));

// start next dev via npm script to respect package.json
// start next dev only if not already running
const http = require('http');
function checkDevRunning(callback) {
  const req = http.request({ method: 'GET', host: '127.0.0.1', port: 3000, timeout: 1000 }, (res) => {
    callback(true);
  });
  req.on('error', () => callback(false));
  req.on('timeout', () => { req.destroy(); callback(false); });
  req.end();
}
checkDevRunning((isRunning) => {
  if (isRunning) {
    console.log('Next dev already running, skipping spawn.');
  } else {
    children.push(spawnProcess('npm', ['run', 'dev']));
  }
});

function shutdown() {
  console.log('Shutting down child processes...');
  for (const c of children) {
    try { c.kill('SIGINT'); } catch (e) {}
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  shutdown();
});
