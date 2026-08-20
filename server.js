"use strict";

const http = require("http");
const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = Number.parseInt(process.env.PORT || "9080", 10);
const PATH = "/rival";
const PROTOCOL = 1;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_TTL_MS = 30 * 60 * 1000;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_MESSAGES_PER_WINDOW = 180;
const RATE_WINDOW_MS = 10 * 1000;

const rooms = new Map();

function send(socket, message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function makeCode() {
  let code = "";
  const bytes = crypto.randomBytes(12);
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

function cleanCode(value) {
  return String(value || "")
    .toUpperCase()
    .split("")
    .filter((character) => CODE_ALPHABET.includes(character))
    .join("")
    .slice(0, 12);
}

function cleanName(value) {
  return String(value || "OPERATOR")
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 16) || "OPERATOR";
}

function roomFor(socket) {
  if (!socket.roomCode) return null;
  return rooms.get(socket.roomCode) || null;
}

function leaveRoom(socket, reason = "RIVAL DISCONNECTED") {
  const room = roomFor(socket);
  if (!room) return;
  const other = socket.role === "host" ? room.guest : room.host;
  send(other, { type: "peer_left", reason });
  if (other) {
    other.roomCode = "";
    other.role = "";
  }
  rooms.delete(room.code);
  socket.roomCode = "";
  socket.role = "";
}

function createRoom(socket, message) {
  leaveRoom(socket, "HOST CREATED A NEW MATCH");
  let code = makeCode();
  while (rooms.has(code)) code = makeCode();
  const room = {
    code,
    host: socket,
    guest: null,
    hostName: cleanName(message.name),
    guestName: "",
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
  rooms.set(code, room);
  socket.roomCode = code;
  socket.role = "host";
  send(socket, { type: "room_created", code, role: "host", protocol: PROTOCOL });
}

function joinRoom(socket, message) {
  leaveRoom(socket, "RIVAL JOINED ANOTHER MATCH");
  const code = cleanCode(message.code);
  const room = rooms.get(code);
  if (!room || !room.host || room.host.readyState !== WebSocket.OPEN) {
    send(socket, { type: "error", code: "ROOM_NOT_FOUND", message: "MATCH CODE NOT FOUND" });
    return;
  }
  if (room.guest && room.guest.readyState === WebSocket.OPEN) {
    send(socket, { type: "error", code: "ROOM_FULL", message: "THAT MATCH ALREADY HAS TWO PLAYERS" });
    return;
  }
  room.guest = socket;
  room.guestName = cleanName(message.name);
  room.lastActivity = Date.now();
  socket.roomCode = code;
  socket.role = "guest";
  send(socket, {
    type: "room_joined",
    code,
    role: "guest",
    host_name: room.hostName,
    protocol: PROTOCOL,
  });
  send(room.host, { type: "peer_joined", name: room.guestName, role: "guest" });
}

function relayMessage(socket, message) {
  const room = roomFor(socket);
  if (!room || !message.payload || typeof message.payload !== "object") {
    send(socket, { type: "error", code: "NOT_IN_ROOM", message: "CREATE OR JOIN A MATCH FIRST" });
    return;
  }
  const other = socket.role === "host" ? room.guest : room.host;
  if (!other || other.readyState !== WebSocket.OPEN) {
    send(socket, { type: "error", code: "NO_RIVAL", message: "WAITING FOR THE SECOND PLAYER" });
    return;
  }
  room.lastActivity = Date.now();
  send(other, { type: "relay", from_role: socket.role, payload: message.payload });
}

function rateAllowed(socket) {
  const now = Date.now();
  if (now - socket.rateWindowStarted >= RATE_WINDOW_MS) {
    socket.rateWindowStarted = now;
    socket.rateCount = 0;
  }
  socket.rateCount += 1;
  return socket.rateCount <= MAX_MESSAGES_PER_WINDOW;
}

const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ ok: true, service: "barcode-blitz-rival-relay", rooms: rooms.size }));
    return;
  }
  response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  response.end("Barcode Blitz Rival Relay is online.\n");
});

const wss = new WebSocketServer({ server, path: PATH, maxPayload: MAX_MESSAGE_BYTES });

wss.on("connection", (socket) => {
  socket.isAlive = true;
  socket.roomCode = "";
  socket.role = "";
  socket.rateWindowStarted = Date.now();
  socket.rateCount = 0;
  socket.on("pong", () => { socket.isAlive = true; });
  socket.on("message", (data, isBinary) => {
    if (isBinary || data.length > MAX_MESSAGE_BYTES || !rateAllowed(socket)) {
      socket.close(1008, "Invalid or excessive traffic");
      return;
    }
    let message;
    try {
      message = JSON.parse(data.toString("utf8"));
    } catch (_error) {
      send(socket, { type: "error", code: "BAD_JSON", message: "INVALID RELAY MESSAGE" });
      return;
    }
    if (message.protocol !== PROTOCOL) {
      send(socket, { type: "error", code: "PROTOCOL", message: "GAME AND RELAY VERSIONS DO NOT MATCH" });
      return;
    }
    switch (message.type) {
      case "create": createRoom(socket, message); break;
      case "join": joinRoom(socket, message); break;
      case "relay": relayMessage(socket, message); break;
      case "leave": leaveRoom(socket, "RIVAL LEFT THE MATCH"); break;
      case "ping": send(socket, { type: "pong", now: Date.now() }); break;
      default: send(socket, { type: "error", code: "UNKNOWN", message: "UNKNOWN RELAY REQUEST" });
    }
  });
  socket.on("close", () => leaveRoom(socket));
  socket.on("error", () => leaveRoom(socket));
});

const heartbeat = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > ROOM_TTL_MS) {
      send(room.host, { type: "peer_left", reason: "MATCH ROOM EXPIRED" });
      send(room.guest, { type: "peer_left", reason: "MATCH ROOM EXPIRED" });
      if (room.host) room.host.roomCode = "";
      if (room.guest) room.guest.roomCode = "";
      rooms.delete(code);
    }
  }
  for (const socket of wss.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 25_000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Barcode Blitz Rival Relay listening on 0.0.0.0:${PORT}${PATH}`);
});

function shutdown() {
  clearInterval(heartbeat);
  for (const socket of wss.clients) socket.close(1001, "Relay restarting");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
