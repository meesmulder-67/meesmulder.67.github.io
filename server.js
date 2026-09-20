const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.get("/", (req, res) => {
  res.send("Blackjack server online");
});

const rooms = new Map();

const CHIP_VALUES = [5, 10, 25, 50, 100, 500];

function createDeck() {
  const suits = ["♠", "♥", "♦", "♣"];

  const ranks = [
    { name: "A", value: 11 },
    { name: "2", value: 2 },
    { name: "3", value: 3 },
    { name: "4", value: 4 },
    { name: "5", value: 5 },
    { name: "6", value: 6 },
    { name: "7", value: 7 },
    { name: "8", value: 8 },
    { name: "9", value: 9 },
    { name: "10", value: 10 },
    { name: "J", value: 10 },
    { name: "Q", value: 10 },
    { name: "K", value: 10 }
  ];

  const deck = [];

  for (let d = 0; d < 6; d++) {
    for (const suit of suits) {
      for (const rank of ranks) {
        deck.push({
          name: rank.name,
          suit,
          value: rank.value
        });
      }
    }
  }

  return shuffle(deck);
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }

  return array;
}

function handValue(cards) {
  let total = cards.reduce((sum, card) => sum + card.value, 0);
  let aces = cards.filter(card => card.name === "A").length;

  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }

  return total;
}

function isBlackjack(cards) {
  return cards.length === 2 && handValue(cards) === 21;
}

function roomState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    dealerCards: room.dealerCards,
    dealerHidden: room.dealerHidden,
    currentPlayerId: room.currentPlayerId,
    resultMessage: room.resultMessage,

    players: room.players.map(player => ({
      id: player.id,
      name: player.name,
      balance: player.balance,
      bet: player.bet,
      cards: player.cards,
      points: handValue(player.cards),
      ready: player.ready,
      stood: player.stood
    }))
  };
}

function sendRoom(room) {
  io.to(room.code).emit("roomState", roomState(room));
}

function allPlayersReady(room) {
  return (
    room.players.length > 0 &&
    room.players.every(player => player.ready)
  );
}

function allPlayersHaveBets(room) {
  return (
    room.players.length > 0 &&
    room.players.every(player => player.bet > 0)
  );
}


/* =========================
   ECHTE RONDE STARTEN
========================= */

function startRound(room) {
  if (room.players.length === 0) return;

  room.deck = createDeck();

  room.dealerCards = [
    room.deck.pop(),
    room.deck.pop()
  ];

  room.dealerHidden = true;
  room.phase = "playing";
  room.resultMessage = "";
  room.currentPlayerId = null;

  for (const player of room.players) {
    player.cards = [];
    player.stood = false;
    player.ready = false;

    player.cards.push(room.deck.pop());
    player.cards.push(room.deck.pop());
  }

  const firstPlayer = room.players.find(
    player =>
      player.bet > 0 &&
      !isBlackjack(player.cards)
  );

  if (firstPlayer) {
    room.currentPlayerId = firstPlayer.id;
  } else {
    finishRound(room);
  }

  sendRoom(room);
}


/* =========================
   VOLGENDE SPELER
========================= */

function moveToNextPlayer(room) {
  const currentIndex = room.players.findIndex(
    player => player.id === room.currentPlayerId
  );

  for (
    let i = currentIndex + 1;
    i < room.players.length;
    i++
  ) {
    const player = room.players[i];

    if (
      player.bet > 0 &&
      !player.stood &&
      !isBlackjack(player.cards) &&
      handValue(player.cards) < 21
    ) {
      room.currentPlayerId = player.id;
      sendRoom(room);
      return;
    }
  }

  finishRound(room);
}


/* =========================
   RONDE AFMAKEN
========================= */

function finishRound(room) {
  room.dealerHidden = false;

  while (handValue(room.dealerCards) < 17) {
    room.dealerCards.push(room.deck.pop());
  }

  const dealerPoints = handValue(room.dealerCards);

  for (const player of room.players) {
    if (player.bet <= 0) continue;

    const playerPoints = handValue(player.cards);

    if (playerPoints > 21) {
      // Bust
    }

    else if (
      isBlackjack(player.cards) &&
      !isBlackjack(room.dealerCards)
    ) {
      player.balance += Math.floor(player.bet * 2.5);
    }

    else if (
      isBlackjack(room.dealerCards) &&
      !isBlackjack(player.cards)
    ) {
      // Dealer blackjack
    }

    else if (dealerPoints > 21) {
      player.balance += player.bet * 2;
    }

    else if (playerPoints > dealerPoints) {
      player.balance += player.bet * 2;
    }

    else if (playerPoints === dealerPoints) {
      player.balance += player.bet;
    }
  }

  room.phase = "finished";
  room.currentPlayerId = null;

  for (const player of room.players) {
    player.stood = false;
    player.ready = false;
  }

  room.resultMessage =
    `Dealer: ${dealerPoints} punten`;

  sendRoom(room);
}


/* =========================
   SPELER VERWIJDEREN
========================= */

function removePlayerFromRoom(socket) {
  for (const [code, room] of rooms.entries()) {
    const index = room.players.findIndex(
      player => player.id === socket.id
    );

    if (index === -1) continue;

    room.players.splice(index, 1);

    if (room.players.length === 0) {
      rooms.delete(code);
      return;
    }

    if (room.hostId === socket.id) {
      room.hostId = room.players[0].id;
    }

    if (
      room.phase === "playing" &&
      room.currentPlayerId === socket.id
    ) {
      const nextPlayer = room.players.find(
        player =>
          player.bet > 0 &&
          !player.stood &&
          handValue(player.cards) < 21
      );

      if (nextPlayer) {
        room.currentPlayerId = nextPlayer.id;
      } else {
        finishRound(room);
        return;
      }
    }

    sendRoom(room);
    return;
  }
}


/* =========================
   SOCKET.IO
========================= */

io.on("connection", socket => {


  /* =========================
     KAMER MAKEN
  ========================= */

  socket.on("createRoom", ({ name }) => {
    const cleanName =
      String(name || "Speler")
        .trim()
        .slice(0, 16);

    let code;

    do {
      code = Math.random()
        .toString(36)
        .substring(2, 8)
        .toUpperCase();
    } while (rooms.has(code));

    const player = {
      id: socket.id,
      name: cleanName,
      balance: 1000,
      bet: 0,
      cards: [],
      ready: false,
      stood: false
    };

    const room = {
      code,
      hostId: socket.id,
      players: [player],

      // waiting = lobby
      // betting = inzetfase
      // playing = echte ronde
      // finished = ronde afgelopen
      phase: "waiting",

      deck: [],
      dealerCards: [],
      dealerHidden: false,
      currentPlayerId: null,
      resultMessage: ""
    };

    rooms.set(code, room);

    socket.join(code);

    socket.emit("roomCreated", {
      code
    });

    sendRoom(room);
  });


  /* =========================
     JOINEN
  ========================= */

  socket.on("joinRoom", ({ code, name }) => {
    const roomCode =
      String(code || "")
        .trim()
        .toUpperCase();

    const room = rooms.get(roomCode);

    if (!room) {
      socket.emit(
        "errorMessage",
        "Deze kamer bestaat niet."
      );
      return;
    }

    if (room.players.length >= 4) {
      socket.emit(
        "errorMessage",
        "Deze kamer zit al vol."
      );
      return;
    }

    if (room.phase === "playing") {
      socket.emit(
        "errorMessage",
        "Je kunt niet joinen terwijl een ronde bezig is."
      );
      return;
    }

    const cleanName =
      String(name || "Speler")
        .trim()
        .slice(0, 16);

    const player = {
      id: socket.id,
      name: cleanName,
      balance: 1000,
      bet: 0,
      cards: [],
      ready: false,
      stood: false
    };

    room.players.push(player);

    socket.join(roomCode);

    socket.emit("joinedRoom", {
      code: roomCode
    });

    sendRoom(room);
  });


  /* =========================
     START SPEL
     
     EERSTE KEER:
     waiting -> betting

     TWEEDE KEER:
     betting -> playing
  ========================= */

  socket.on("readyForGame", () => {

    for (const room of rooms.values()) {

      const player =
        room.players.find(
          p => p.id === socket.id
        );

      if (!player) continue;


      /* =========================
         EERSTE START
      ========================= */

      if (room.phase === "waiting") {

        // Iedereen krijgt eerst de inzetfase.
        room.phase = "betting";

        // Niemand is al ready voor de echte ronde.
        for (const p of room.players) {
          p.ready = false;
          p.bet = 0;
          p.cards = [];
          p.stood = false;
        }

        room.dealerCards = [];
        room.dealerHidden = false;
        room.resultMessage = "";
        room.currentPlayerId = null;

        sendRoom(room);

        return;
      }


      /* =========================
         TWEEDE START
      ========================= */

      if (room.phase === "betting") {

        if (player.bet <= 0) {

          socket.emit(
            "errorMessage",
            "Je moet eerst een inzet kiezen."
          );

          return;
        }

        player.ready = true;

        sendRoom(room);

        // Pas als IEDEREEN heeft ingezet
        // én IEDEREEN opnieuw op START SPEL
        // heeft geklikt, begint de ronde.
        if (
          allPlayersReady(room) &&
          allPlayersHaveBets(room)
        ) {
          startRound(room);
        }

        return;
      }

      return;
    }
  });


  /* =========================
     INZETTEN
  ========================= */

  socket.on("placeBet", ({ amount }) => {

    const value = Number(amount);

    if (!CHIP_VALUES.includes(value)) return;

    for (const room of rooms.values()) {

      const player =
        room.players.find(
          p => p.id === socket.id
        );

      if (!player) continue;

      // Alleen tijdens inzetfase.
      if (room.phase !== "betting") return;

      // Als speler al ready is mag hij niet meer wijzigen.
      if (player.ready) return;

      if (player.balance < value) return;

      player.balance -= value;
      player.bet += value;

      sendRoom(room);

      return;
    }
  });


  /* =========================
     INZET WISSEN
  ========================= */

  socket.on("clearBet", () => {

    for (const room of rooms.values()) {

      const player =
        room.players.find(
          p => p.id === socket.id
        );

      if (!player) continue;

      if (room.phase !== "betting") return;

      if (player.ready) return;

      player.balance += player.bet;
      player.bet = 0;

      sendRoom(room);

      return;
    }
  });


  /* =========================
     HIT
  ========================= */

  socket.on("hit", () => {

    for (const room of rooms.values()) {

      const player =
        room.players.find(
          p => p.id === socket.id
        );

      if (!player) continue;

      if (room.phase !== "playing") return;

      if (room.currentPlayerId !== socket.id) return;

      if (player.stood) return;

      player.cards.push(
        room.deck.pop()
      );

      const points =
        handValue(player.cards);

      if (points >= 21) {

        player.stood = true;

        moveToNextPlayer(room);

      } else {

        sendRoom(room);
      }

      return;
    }
  });


  /* =========================
     STAND
  ========================= */

  socket.on("stand", () => {

    for (const room of rooms.values()) {

      const player =
        room.players.find(
          p => p.id === socket.id
        );

      if (!player) continue;

      if (room.phase !== "playing") return;

      if (room.currentPlayerId !== socket.id) return;

      player.stood = true;

      moveToNextPlayer(room);

      return;
    }
  });


  /* =========================
     DOUBLE
  ========================= */

  socket.on("double", () => {

    for (const room of rooms.values()) {

      const player =
        room.players.find(
          p => p.id === socket.id
        );

      if (!player) continue;

      if (room.phase !== "playing") return;

      if (room.currentPlayerId !== socket.id) return;

      if (player.cards.length !== 2) return;

      if (player.balance < player.bet) return;

      player.balance -= player.bet;
      player.bet *= 2;

      player.cards.push(
        room.deck.pop()
      );

      player.stood = true;

      moveToNextPlayer(room);

      return;
    }
  });


  /* =========================
     VOLGENDE RONDE
  ========================= */

  socket.on("nextRound", () => {

    for (const room of rooms.values()) {

      const player =
        room.players.find(
          p => p.id === socket.id
        );

      if (!player) continue;

      if (room.phase !== "finished") return;

      for (const p of room.players) {
        p.ready = false;
        p.bet = 0;
        p.cards = [];
        p.stood = false;
      }

      room.dealerCards = [];
      room.dealerHidden = false;
      room.resultMessage = "";
      room.currentPlayerId = null;

      // Terug naar lobby.
      room.phase = "waiting";

      sendRoom(room);

      return;
    }
  });


  /* =========================
     VERLATEN
  ========================= */

  socket.on("leaveRoom", () => {

    removePlayerFromRoom(socket);

    socket.leaveAll();
  });


  /* =========================
     DISCONNECT
  ========================= */

  socket.on("disconnect", () => {

    removePlayerFromRoom(socket);
  });

});


const PORT =
  process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(
    `Blackjack server running on port ${PORT}`
  );
});
