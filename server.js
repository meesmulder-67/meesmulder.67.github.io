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
const STARTING_CREDITS = 1000;


/* =========================
   DECK
========================= */

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

    [
      array[i],
      array[j]
    ] = [
      array[j],
      array[i]
    ];
  }

  return array;
}


/* =========================
   POINTS
========================= */

function handValue(cards) {
  let total = cards.reduce(
    (sum, card) => sum + card.value,
    0
  );

  let aces = cards.filter(
    card => card.name === "A"
  ).length;

  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }

  return total;
}


function isBlackjack(cards) {
  return (
    cards.length === 2 &&
    handValue(cards) === 21
  );
}


/* =========================
   HAND
========================= */

function createHand(cards = [], bet = 0) {
  return {
    cards,
    bet,
    stood: false
  };
}


function activeHand(player) {
  return player.hands[player.activeHand];
}


/* =========================
   BIJVULLEN
========================= */

function refillPlayer(player) {
  if (player.balance <= 0) {
    player.balance = STARTING_CREDITS;
    return true;
  }

  return false;
}


/* =========================
   VOLGENDE RONDE KLAAR?
========================= */

function allPlayersNextRoundReady(room) {
  return (
    room.players.length > 0 &&
    room.players.every(
      player => player.nextRoundReady === true
    )
  );
}


/* =========================
   ROOM STATE
========================= */

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

      ready: player.ready,

      nextRoundReady: player.nextRoundReady,

      activeHand: player.activeHand,

      hands: player.hands.map(hand => ({
        cards: hand.cards,

        bet: hand.bet,

        stood: hand.stood,

        points: handValue(hand.cards)
      })),

      cards: activeHand(player)
        ? activeHand(player).cards
        : [],

      points: activeHand(player)
        ? handValue(activeHand(player).cards)
        : 0,

      stood: activeHand(player)
        ? activeHand(player).stood
        : false
    }))
  };
}


function sendRoom(room) {
  io.to(room.code).emit(
    "roomState",
    roomState(room)
  );
}


/* =========================
   READY
========================= */

function allPlayersReady(room) {
  return (
    room.players.length > 0 &&
    room.players.every(
      player => player.ready
    )
  );
}


function allPlayersHaveBets(room) {
  return (
    room.players.length > 0 &&
    room.players.every(
      player =>
        player.hands.length > 0 &&
        player.hands[0].bet > 0
    )
  );
}


/* =========================
   RONDE STARTEN
========================= */

function startRound(room) {
  if (room.players.length === 0) {
    return;
  }

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
    const bet = player.hands[0].bet;

    player.hands = [
      createHand(
        [
          room.deck.pop(),
          room.deck.pop()
        ],
        bet
      )
    ];

    player.activeHand = 0;

    player.ready = false;
  }

  let firstPlayer = null;

  for (const player of room.players) {
    const hand = activeHand(player);

    if (
      hand &&
      !isBlackjack(hand.cards)
    ) {
      firstPlayer = player;
      break;
    }
  }

  if (firstPlayer) {
    room.currentPlayerId = firstPlayer.id;
  } else {
    finishRound(room);
    return;
  }

  sendRoom(room);
}


/* =========================
   VOLGENDE BEURT
========================= */

function moveToNextTurn(room) {
  const currentIndex =
    room.players.findIndex(
      player =>
        player.id === room.currentPlayerId
    );

  if (currentIndex === -1) {
    finishRound(room);
    return;
  }

  const currentPlayer =
    room.players[currentIndex];

  const currentHand =
    activeHand(currentPlayer);

  if (
    currentHand &&
    !currentHand.stood &&
    handValue(currentHand.cards) < 21
  ) {
    sendRoom(room);
    return;
  }

  if (
    currentPlayer.activeHand <
    currentPlayer.hands.length - 1
  ) {
    currentPlayer.activeHand++;

    const nextHand =
      activeHand(currentPlayer);

    if (
      nextHand &&
      !nextHand.stood &&
      handValue(nextHand.cards) < 21
    ) {
      sendRoom(room);
      return;
    }

    moveToNextTurn(room);
    return;
  }

  for (
    let i = currentIndex + 1;
    i < room.players.length;
    i++
  ) {
    const player =
      room.players[i];

    if (!player.hands.length) {
      continue;
    }

    player.activeHand = 0;

    const hand =
      activeHand(player);

    if (
      hand &&
      !hand.stood &&
      !isBlackjack(hand.cards) &&
      handValue(hand.cards) < 21
    ) {
      room.currentPlayerId =
        player.id;

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

  while (
    handValue(room.dealerCards) < 17
  ) {
    room.dealerCards.push(
      room.deck.pop()
    );
  }

  const dealerPoints =
    handValue(room.dealerCards);

  const dealerBJ =
    isBlackjack(room.dealerCards);

  const refillMessages = [];

  for (const player of room.players) {
    const resultParts = [];

    for (const hand of player.hands) {
      if (hand.bet <= 0) {
        continue;
      }

      const playerPoints =
        handValue(hand.cards);

      const playerBJ =
        isBlackjack(hand.cards);

      if (playerPoints > 21) {
        resultParts.push("Verloren");
        continue;
      }

      if (
        player.hands.length === 1 &&
        playerBJ &&
        !dealerBJ
      ) {
        player.balance +=
          Math.floor(hand.bet * 2.5);

        resultParts.push("Blackjack!");
      }

      else if (
        dealerBJ &&
        !playerBJ
      ) {
        resultParts.push("Verloren");
      }

      else if (
        dealerPoints > 21
      ) {
        player.balance +=
          hand.bet * 2;

        resultParts.push("Gewonnen");
      }

      else if (
        playerPoints > dealerPoints
      ) {
        player.balance +=
          hand.bet * 2;

        resultParts.push("Gewonnen");
      }

      else if (
        playerPoints === dealerPoints
      ) {
        player.balance +=
          hand.bet;

        resultParts.push("Gelijkspel");
      }

      else {
        resultParts.push("Verloren");
      }
    }

    player.result =
      resultParts.join(" | ");

    if (refillPlayer(player)) {
      refillMessages.push(
        `${player.name} kreeg 1000 credits bijgevuld`
      );
    }
  }

  room.phase = "finished";

  room.currentPlayerId = null;

  for (const player of room.players) {
    player.ready = false;
    player.stood = false;
    player.nextRoundReady = false;
  }

  room.resultMessage =
    `Dealer: ${dealerPoints} punten`;

  if (refillMessages.length > 0) {
    room.resultMessage +=
      ` — ${refillMessages.join(" | ")}`;
  }

  sendRoom(room);
}


/* =========================
   SPELER VERWIJDEREN
========================= */

function removePlayerFromRoom(socket) {
  for (
    const [code, room]
    of rooms.entries()
  ) {
    const index =
      room.players.findIndex(
        player =>
          player.id === socket.id
      );

    if (index === -1) {
      continue;
    }

    room.players.splice(index, 1);

    if (room.players.length === 0) {
      rooms.delete(code);
      return;
    }

    if (room.hostId === socket.id) {
      room.hostId =
        room.players[0].id;
    }

    if (
      room.phase === "playing" &&
      room.currentPlayerId === socket.id
    ) {
      const nextPlayer =
        room.players.find(player => {
          const hand =
            activeHand(player);

          return (
            hand &&
            !hand.stood &&
            handValue(hand.cards) < 21
          );
        });

      if (nextPlayer) {
        nextPlayer.activeHand = 0;

        room.currentPlayerId =
          nextPlayer.id;
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

io.on(
  "connection",
  socket => {

    /* =========================
       KAMER MAKEN
    ========================= */

    socket.on(
      "createRoom",
      ({ name }) => {

        const cleanName =
          String(name || "Speler")
            .trim()
            .slice(0, 16);

        let code;

        do {
          code =
            Math.random()
              .toString(36)
              .substring(2, 8)
              .toUpperCase();
        } while (rooms.has(code));

        const player = {
          id: socket.id,

          name: cleanName,

          balance: STARTING_CREDITS,

          bet: 0,

          hands: [],

          activeHand: 0,

          ready: false,

          nextRoundReady: false,

          result: ""
        };

        const room = {
          code,

          hostId: socket.id,

          players: [player],

          phase: "waiting",

          deck: [],

          dealerCards: [],

          dealerHidden: false,

          currentPlayerId: null,

          resultMessage: ""
        };

        rooms.set(code, room);

        socket.join(code);

        socket.emit(
          "roomCreated",
          { code }
        );

        sendRoom(room);
      }
    );


    /* =========================
       JOINEN
    ========================= */

    socket.on(
      "joinRoom",
      ({ code, name }) => {

        const roomCode =
          String(code || "")
            .trim()
            .toUpperCase();

        const room =
          rooms.get(roomCode);

        if (!room) {
          socket.emit(
            "errorMessage",
            "Deze kamer bestaat niet."
          );
          return;
        }

        if (
          room.players.length >= 4
        ) {
          socket.emit(
            "errorMessage",
            "Deze kamer zit al vol."
          );
          return;
        }

        if (
          room.phase === "playing"
        ) {
          socket.emit(
            "errorMessage",
            "Je kunt niet joinen terwijl een ronde bezig is."
          );
          return;
        }

        if (
          room.phase === "finished"
        ) {
          socket.emit(
            "errorMessage",
            "Wacht tot de volgende ronde begint."
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

          balance: STARTING_CREDITS,

          bet: 0,

          hands: [],

          activeHand: 0,

          ready: false,

          nextRoundReady: false,

          result: ""
        };

        room.players.push(player);

        socket.join(roomCode);

        socket.emit(
          "joinedRoom",
          {
            code: roomCode
          }
        );

        sendRoom(room);
      }
    );


    /* =========================
       START SPEL
    ========================= */

    socket.on(
      "readyForGame",
      () => {

        for (
          const room of rooms.values()
        ) {

          const player =
            room.players.find(
              p =>
                p.id === socket.id
            );

          if (!player) {
            continue;
          }

          /*
            EERSTE START:
            Lobby -> inzetfase
          */

          if (
            room.phase === "waiting"
          ) {

            room.phase =
              "betting";

            for (
              const p of room.players
            ) {
              p.ready = false;
              p.bet = 0;
              p.hands = [];
              p.activeHand = 0;
              p.nextRoundReady = false;
              p.result = "";
            }

            room.dealerCards = [];
            room.dealerHidden = false;
            room.resultMessage = "";
            room.currentPlayerId = null;

            sendRoom(room);
            return;
          }

          /*
            TWEEDE START:
            Speler is klaar met inzetten.
          */

          if (
            room.phase === "betting"
          ) {

            if (
              player.hands.length === 0 ||
              player.hands[0].bet <= 0
            ) {
              socket.emit(
                "errorMessage",
                "Je moet eerst een inzet kiezen."
              );
              return;
            }

            player.ready = true;

            sendRoom(room);

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
      }
    );


    /* =========================
       INZETTEN
    ========================= */

    socket.on(
      "placeBet",
      ({ amount }) => {

        const value =
          Number(amount);

        if (
          !CHIP_VALUES.includes(value)
        ) {
          return;
        }

        for (
          const room of rooms.values()
        ) {

          const player =
            room.players.find(
              p =>
                p.id === socket.id
            );

          if (!player) {
            continue;
          }

          if (
            room.phase !== "betting"
          ) {
            return;
          }

          if (player.ready) {
            return;
          }

          refillPlayer(player);

          if (
            player.balance < value
          ) {
            return;
          }

          if (
            player.hands.length === 0
          ) {
            player.hands = [
              createHand([], 0)
            ];
          }

          player.balance -= value;

          player.hands[0].bet += value;

          player.bet =
            player.hands[0].bet;

          sendRoom(room);
          return;
        }
      }
    );


    /* =========================
       INZET WISSEN
    ========================= */

    socket.on(
      "clearBet",
      () => {

        for (
          const room of rooms.values()
        ) {

          const player =
            room.players.find(
              p =>
                p.id === socket.id
            );

          if (!player) {
            continue;
          }

          if (
            room.phase !== "betting"
          ) {
            return;
          }

          if (player.ready) {
            return;
          }

          if (
            player.hands.length
          ) {
            player.balance +=
              player.hands[0].bet;

            player.hands[0].bet = 0;
          }

          player.bet = 0;

          sendRoom(room);
          return;
        }
      }
    );


    /* =========================
       HIT
    ========================= */

    socket.on(
      "hit",
      () => {

        for (
          const room of rooms.values()
        ) {

          const player =
            room.players.find(
              p =>
                p.id === socket.id
            );

          if (!player) {
            continue;
          }

          if (
            room.phase !== "playing"
          ) {
            return;
          }

          if (
            room.currentPlayerId !==
            socket.id
          ) {
            return;
          }

          const hand =
            activeHand(player);

          if (!hand) {
            return;
          }

          if (hand.stood) {
            return;
          }

          hand.cards.push(
            room.deck.pop()
          );

          const playerPoints =
            handValue(hand.cards);

          if (
            playerPoints >= 21
          ) {

            hand.stood = true;

            moveToNextTurn(room);

          } else {

            sendRoom(room);

          }

          return;
        }
      }
    );


    /* =========================
       STAND
    ========================= */

    socket.on(
      "stand",
      () => {

        for (
          const room of rooms.values()
        ) {

          const player =
            room.players.find(
              p =>
                p.id === socket.id
            );

          if (!player) {
            continue;
          }

          if (
            room.phase !== "playing"
          ) {
            return;
          }

          if (
            room.currentPlayerId !==
            socket.id
          ) {
            return;
          }

          const hand =
            activeHand(player);

          if (!hand) {
            return;
          }

          hand.stood = true;

          moveToNextTurn(room);

          return;
        }
      }
    );


    /* =========================
       DOUBLE
    ========================= */

    socket.on(
      "double",
      () => {

        for (
          const room of rooms.values()
        ) {

          const player =
            room.players.find(
              p =>
                p.id === socket.id
            );

          if (!player) {
            continue;
          }

          if (
            room.phase !== "playing"
          ) {
            return;
          }

          if (
            room.currentPlayerId !==
            socket.id
          ) {
            return;
          }

          const hand =
            activeHand(player);

          if (!hand) {
            return;
          }

          if (
            hand.cards.length !== 2
          ) {
            return;
          }

          if (
            player.balance < hand.bet
          ) {
            return;
          }

          player.balance -=
            hand.bet;

          hand.bet *= 2;

          hand.cards.push(
            room.deck.pop()
          );

          hand.stood = true;

          moveToNextTurn(room);

          return;
        }
      }
    );


    /* =========================
       SPLIT
    ========================= */

    socket.on(
      "split",
      () => {

        for (
          const room of rooms.values()
        ) {

          const player =
            room.players.find(
              p =>
                p.id === socket.id
            );

          if (!player) {
            continue;
          }

          if (
            room.phase !== "playing"
          ) {
            return;
          }

          if (
            room.currentPlayerId !==
            socket.id
          ) {
            return;
          }

          if (
            player.hands.length !== 1
          ) {
            return;
          }

          const hand =
            activeHand(player);

          if (!hand) {
            return;
          }

          if (
            hand.cards.length !== 2
          ) {
            return;
          }

          if (
            hand.cards[0].value !==
            hand.cards[1].value
          ) {
            return;
          }

          if (
            player.balance < hand.bet
          ) {
            return;
          }

          player.balance -=
            hand.bet;

          const firstCard =
            hand.cards[0];

          const secondCard =
            hand.cards[1];

          const bet =
            hand.bet;

          const firstHand =
            createHand(
              [
                firstCard,
                room.deck.pop()
              ],
              bet
            );

          const secondHand =
            createHand(
              [
                secondCard,
                room.deck.pop()
              ],
              bet
            );

          player.hands = [
            firstHand,
            secondHand
          ];

          player.activeHand = 0;

          sendRoom(room);

          return;
        }
      }
    );


    /* =========================
       VOLGENDE RONDE
       IEDEREEN MOET KLIKKEN
    ========================= */

    socket.on(
      "nextRound",
      () => {

        for (
          const room of rooms.values()
        ) {

          const player =
            room.players.find(
              p =>
                p.id === socket.id
            );

          if (!player) {
            continue;
          }

          if (
            room.phase !== "finished"
          ) {
            return;
          }

          /*
            Alleen DEZE speler wordt
            als klaar gemarkeerd.
          */

          player.nextRoundReady = true;

          /*
            Nog niet iedereen geklikt.
            Dus nog NIETS resetten.
          */

          if (
            !allPlayersNextRoundReady(room)
          ) {

            room.resultMessage =
              `Volgende ronde: ${
                room.players.filter(
                  p => p.nextRoundReady
                ).length
              }/${room.players.length} spelers klaar`;

            sendRoom(room);

            return;
          }

          /*
            IEDEREEN heeft geklikt.
            Nu pas begint de nieuwe
            inzetfase.
          */

          room.phase = "betting";

          room.dealerCards = [];

          room.dealerHidden = false;

          room.currentPlayerId = null;

          room.resultMessage = "";

          for (
            const p of room.players
          ) {

            p.ready = false;

            p.nextRoundReady = false;

            p.bet = 0;

            p.hands = [];

            p.activeHand = 0;

            p.stood = false;

            p.result = "";

            refillPlayer(p);
          }

          sendRoom(room);

          return;
        }
      }
    );


    /* =========================
       VERLATEN
    ========================= */

    socket.on(
      "leaveRoom",
      () => {

        removePlayerFromRoom(socket);

        socket.leaveAll();

      }
    );


    /* =========================
       DISCONNECT
    ========================= */

    socket.on(
      "disconnect",
      () => {

        removePlayerFromRoom(socket);

      }
    );

  }
);


const PORT =
  process.env.PORT || 3000;


server.listen(
  PORT,
  () => {

    console.log(
      `Blackjack server running on port ${PORT}`
    );

  }
);
