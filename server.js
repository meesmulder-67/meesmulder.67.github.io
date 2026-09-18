const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

const rooms = new Map();

app.get("/", (req, res) => {
  res.send("Blackjack Royale server is online 🃏");
});

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;

  do {
    code = "";
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));

  return code;
}

io.on("connection", (socket) => {
  console.log("Speler verbonden:", socket.id);

  socket.on("createRoom", ({ name }) => {
    const code = generateCode();

    rooms.set(code, {
      players: [
        {
          id: socket.id,
          name: name || "Speler"
        }
      ]
    });

    socket.join(code);
    socket.roomCode = code;

    socket.emit("roomCreated", {
      code: code
    });

    io.to(code).emit("roomUpdate", rooms.get(code));
  });

  socket.on("joinRoom", ({ code, name }) => {
    code = String(code || "").toUpperCase();

    const room = rooms.get(code);

    if (!room) {
      socket.emit("joinError", "Deze kamer bestaat niet.");
      return;
    }

    if (room.players.length >= 5) {
      socket.emit("joinError", "Deze kamer zit vol.");
      return;
    }

    room.players.push({
      id: socket.id,
      name: name || "Speler"
    });

    socket.join(code);
    socket.roomCode = code;

    socket.emit("roomJoined", {
      code: code
    });

    io.to(code).emit("roomUpdate", room);
  });

  socket.on("disconnect", () => {
    const code = socket.roomCode;

    if (!code || !rooms.has(code)) {
      return;
    }

    const room = rooms.get(code);

    room.players = room.players.filter(
      (player) => player.id !== socket.id
    );

    if (room.players.length === 0) {
      rooms.delete(code);
    } else {
      io.to(code).emit("roomUpdate", room);
    }

    console.log("Speler vertrokken:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Blackjack Royale server draait op poort ${PORT}`);
});
