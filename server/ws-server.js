#!/usr/bin/env node
const WebSocket = require('ws');

const port = process.env.WS_PORT ? parseInt(process.env.WS_PORT, 10) : 3001;
const wss = new WebSocket.Server({ port });

console.log(`WebSocket server listening on ws://0.0.0.0:${port}`);

// Map poolId -> Set of clients
const pools = new Map();

function subscribe(ws, poolId) {
  let set = pools.get(poolId);
  if (!set) {
    set = new Set();
    pools.set(poolId, set);
  }
  set.add(ws);
  ws._subscribed = ws._subscribed || new Set();
  ws._subscribed.add(poolId);
}

function unsubscribe(ws, poolId) {
  const set = pools.get(poolId);
  if (set) {
    set.delete(ws);
    if (set.size === 0) pools.delete(poolId);
  }
  if (ws._subscribed) ws._subscribed.delete(poolId);
}

function broadcastToPool(poolId, message, except) {
  const set = pools.get(poolId);
  if (!set) return;
  const data = JSON.stringify(message);
  const recipients = [];
  for (const client of set) {
    if (client !== except && client.readyState === WebSocket.OPEN) {
      try { client.send(data); } catch (e) {}
      recipients.push(client._remote || client._id || 'unknown');
    }
  }
  if (recipients.length) console.log('broadcast', message.type, 'pool', poolId, 'to', recipients.length, 'recipients', recipients.join(','));
}

wss.on('connection', function connection(ws, req) {
  const remote = req && req.socket ? req.socket.remoteAddress : 'unknown';
  console.log('WS connection from', remote);

  ws.on('message', function incoming(raw) {
    console.log('WS message from', remote, raw.toString());
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      return;
    }

    const { type, poolId, member } = msg || {};
    if (!type) return;

    if (type === 'subscribe' && poolId) {
      subscribe(ws, poolId);
      try {
        ws.send(JSON.stringify({ type: 'subscribed', poolId }));
        console.log('sent subscribed ack to', remote, poolId);
      } catch (e) {}
      console.log('subscribe', remote, poolId);
      return;
    }

    if (type === 'unsubscribe' && poolId) {
      unsubscribe(ws, poolId);
      console.log('unsubscribe', remote, poolId);
      return;
    }

    // Track member associations and broadcast domain events to other clients in the pool
    if (type === 'member_joined' && poolId && member) {
      // remember which member this websocket represents for this pool
      ws._members = ws._members || new Map();
      ws._members.set(poolId, member);
      console.log('member_joined', remote, poolId, member.id || member.name);
      broadcastToPool(poolId, msg, ws);
      return;
    }

    if (type === 'member_left' && poolId && member) {
      // remove association for this pool
      if (ws._members) ws._members.delete(poolId);
      console.log('member_left', remote, poolId, member.id || member.name);
      broadcastToPool(poolId, msg, ws);
      return;
    }

    if (type === 'pool_deleted' && poolId) {
      // on pool deletion, clear associated members from this socket and broadcast
      if (ws._members) ws._members.delete(poolId);
      console.log('pool_deleted', remote, poolId);
      broadcastToPool(poolId, msg, ws);
      return;
    }
  });

  ws.on('close', function () {
    console.log('WS closed from', remote);
    // Notify others that this connection's members left, then cleanup
    try {
      if (ws._members) {
        for (const [poolId, member] of ws._members.entries()) {
          console.log('auto member_left on close', remote, poolId, member.id || member.name);
          broadcastToPool(poolId, { type: 'member_left', poolId, member }, ws);
        }
      }
    } catch (e) {
      // ignore
    }

    // cleanup subscriptions
    if (ws._subscribed) {
      for (const poolId of [...ws._subscribed]) unsubscribe(ws, poolId);
    }
  });
});

// simple HTTP endpoint to accept broadcast requests from local API server
const http = require('http');
const httpPort = process.env.WS_HTTP_PORT ? parseInt(process.env.WS_HTTP_PORT, 10) : 3002;

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/broadcast') {
    res.statusCode = 404;
    res.end('not found');
    return;
  }

  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    try {
      const msg = JSON.parse(body);
      const { poolId } = msg || {};
      if (!poolId) {
        res.statusCode = 400;
        res.end('missing poolId');
        return;
      }

      // broadcast to pool
      broadcastToPool(poolId, msg, null);
      res.statusCode = 200;
      res.end('ok');
    } catch (err) {
      res.statusCode = 400;
      res.end('invalid json');
    }
  });
});

server.listen(httpPort, () => console.log(`WS HTTP broker listening on http://0.0.0.0:${httpPort}`));
