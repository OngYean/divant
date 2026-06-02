const { spawn } = require('child_process');

console.log('Starting ws-server and Next production server...');

const children = [];

function spawnProcess(cmd, args) {
  const p = spawn(cmd, args, { stdio: 'inherit', env: process.env });
  p.on('exit', (code, signal) => {
    if (signal) {
      console.log(`${cmd} terminated with signal ${signal}`);
    } else {
      console.log(`${cmd} exited with code ${code}`);
    }
    // If one process exits, shutdown the other to restart the container
    shutdown();
  });
  p.on('error', (err) => {
    console.error(`${cmd} failed:`, err);
    shutdown();
  });
  return p;
}

function shutdown() {
  console.log('Shutting down child processes...');
  for (const c of children) {
    try { c.kill('SIGTERM'); } catch (e) {}
  }
  process.exit(0);
}

// Start WebSocket server
children.push(spawnProcess(process.execPath, ['server/ws-server.js']));

// Start Next production server
children.push(spawnProcess('npx', ['next', 'start', '-p', process.env.PORT || '3000']));

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
