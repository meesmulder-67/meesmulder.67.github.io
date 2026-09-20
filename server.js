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

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

app.get("/", (req, res) => {
    res.sendFile(__dirname + "/public/index.html");
});

const rooms = new Map();

/* =========================
   HELPERS
========================= */

function cleanName(name) {
    return String(name || "Speler")
        .replace(/[<>]/g, "")
        .trim()
        .substring(0, 18) || "Speler";
}

function createRoomCode() {
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

function createDeck() {
    const suits = ["♠", "♥", "♦", "♣"];
    const values = [
        "A", "2", "3", "4", "5", "6", "7",
        "8", "9", "10", "J", "Q", "K"
    ];

    const deck = [];

    for (let d = 0; d < 6; d++) {
        for (const suit of suits) {
            for (const value of values) {
                deck.push({ suit, value });
            }
        }
    }

    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }

    return deck;
}

function draw(room) {
    if (room.deck.length < 20) {
        room.deck = createDeck();
    }

    return room.deck.pop();
}

function cardValue(card) {
    if (["J", "Q", "K"].includes(card.value)) return 10;
    if (card.value === "A") return 11;
    return Number(card.value);
}

function handValue(cards) {
    let total = 0;
    let aces = 0;

    for (const card of cards) {
        total += cardValue(card);
        if (card.value === "A") aces++;
    }

    while (total > 21 && aces > 0) {
        total -= 10;
        aces--;
    }

    return total;
}

function blackjack(cards) {
    return cards.length === 2 && handValue(cards) === 21;
}

function findRoom(socketId) {
    for (const room of rooms.values()) {
        if (room.players.some(p => p.id === socketId)) {
            return room;
        }
    }

    return null;
}

function newPlayer(socket, name) {
    return {
        id: socket.id,
        name: cleanName(name),
        balance: 1000,
        bet: 0,
        cards: [],
        standing: false,
        busted: false,
        doubled: false
    };
}

/* =========================
   DATA
========================= */

function roomData(room) {
    return {
        code: room.code,
        hostId: room.hostId,
        players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            balance: p.balance
        }))
    };
}

function gameData(room, socketId) {
    const me = room.players.find(p => p.id === socketId);

    return {
        code: room.code,
        phase: room.phase,
        hostId: room.hostId,
        currentPlayerId: room.currentPlayerId,

        myBalance: me ? me.balance : 0,

        dealerCards: room.dealerCards,
        dealerHidden: room.phase === "playing",

        players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            balance: p.balance,
            bet: p.bet,
            cards: p.cards,
            active: p.id === room.currentPlayerId,
            status:
                p.busted
                    ? "BUST"
                    : p.standing
                        ? "STAND"
                        : ""
        })),

        resultMessage: room.resultMessage || ""
    };
}

function sendRoom(room) {
    io.to(room.code).emit("roomUpdate", roomData(room));
}

function sendGame(room) {
    for (const player of room.players) {
        io.to(player.id).emit(
            "gameState",
            gameData(room, player.id)
        );
    }
}

/* =========================
   CONNECTION
========================= */

io.on("connection", socket => {

    console.log("Connected:", socket.id);

    /* CREATE ROOM */

    socket.on("createRoom", data => {

        const code = createRoomCode();
        const player = newPlayer(socket, data?.name);

        const room = {
            code,
            hostId: socket.id,
            players: [player],

            phase: "waiting",

            deck: [],
            dealerCards: [],

            currentPlayerId: null,

            resultMessage: ""
        };

        rooms.set(code, room);

        socket.join(code);

        socket.emit("roomCreated", roomData(room));

        sendRoom(room);
    });

    /* JOIN ROOM */

    socket.on("joinRoom", data => {

        const code = String(data?.code || "")
            .trim()
            .toUpperCase();

        const room = rooms.get(code);

        if (!room) {
            socket.emit(
                "joinError",
                "Deze kamer bestaat niet."
            );
            return;
        }

        if (room.phase !== "waiting") {
            socket.emit(
                "joinError",
                "Dit spel is al gestart."
            );
            return;
        }

        if (room.players.length >= 4) {
            socket.emit(
                "joinError",
                "Deze tafel zit vol."
            );
            return;
        }

        const player = newPlayer(socket, data?.name);

        room.players.push(player);

        socket.join(code);

        socket.emit("roomJoined", roomData(room));

        sendRoom(room);
    });

    /* HOST START */

    socket.on("startGame", () => {

        const room = findRoom(socket.id);

        if (!room) return;

        if (room.hostId !== socket.id) {
            socket.emit(
                "gameError",
                "Alleen de host kan het spel starten."
            );
            return;
        }

        if (room.phase !== "waiting") return;

        room.phase = "betting";
        room.resultMessage = "";

        for (const player of room.players) {
            player.bet = 0;
            player.cards = [];
            player.standing = false;
            player.busted = false;
            player.doubled = false;
        }

        sendGame(room);
    });

    /* BET */

    socket.on("placeBet", data => {

        const room = findRoom(socket.id);

        if (!room || room.phase !== "betting") return;

        const player = room.players.find(
            p => p.id === socket.id
        );

        if (!player) return;

        const amount = Math.floor(Number(data?.amount));

        if (!Number.isFinite(amount) || amount <= 0) return;

        if (player.balance < amount) {
            socket.emit(
                "gameError",
                "Niet genoeg nepcredits."
            );
            return;
        }

        player.balance -= amount;
        player.bet += amount;

        sendGame(room);
    });

    /* START ROUND */

    socket.on("startRound", () => {

        const room = findRoom(socket.id);

        if (!room) return;

        if (room.hostId !== socket.id) {
            socket.emit(
                "gameError",
                "Alleen de host kan de ronde starten."
            );
            return;
        }

        if (room.phase !== "betting") return;

        const allBet = room.players.every(
            p => p.bet > 0
        );

        if (!allBet) {
            socket.emit(
                "gameError",
                "Iedere speler moet eerst inzetten."
            );
            return;
        }

        beginRound(room);
    });

    /* HIT */

    socket.on("hit", () => {

        const room = findRoom(socket.id);

        if (!room) return;

        if (
            room.phase !== "playing" ||
            room.currentPlayerId !== socket.id
        ) return;

        const player = room.players.find(
            p => p.id === socket.id
        );

        if (!player) return;

        player.cards.push(draw(room));

        const total = handValue(player.cards);

        if (total > 21) {
            player.busted = true;
            player.standing = true;
            nextPlayer(room);
        } else if (total === 21) {
            player.standing = true;
            nextPlayer(room);
        }

        sendGame(room);
    });

    /* STAND */

    socket.on("stand", () => {

        const room = findRoom(socket.id);

        if (!room) return;

        if (
            room.phase !== "playing" ||
            room.currentPlayerId !== socket.id
        ) return;

        const player = room.players.find(
            p => p.id === socket.id
        );

        if (!player) return;

        player.standing = true;

        nextPlayer(room);

        sendGame(room);
    });

    /* DOUBLE */

    socket.on("double", () => {

        const room = findRoom(socket.id);

        if (!room) return;

        if (
            room.phase !== "playing" ||
            room.currentPlayerId !== socket.id
        ) return;

        const player = room.players.find(
            p => p.id === socket.id
        );

        if (!player) return;

        if (player.cards.length !== 2) {
            socket.emit(
                "gameError",
                "Double kan alleen met je eerste twee kaarten."
            );
            return;
        }

        if (player.balance < player.bet) {
            socket.emit(
                "gameError",
                "Niet genoeg nepcredits."
            );
            return;
        }

        player.balance -= player.bet;
        player.bet *= 2;
        player.doubled = true;

        player.cards.push(draw(room));

        if (handValue(player.cards) > 21) {
            player.busted = true;
        }

        player.standing = true;

        nextPlayer(room);

        sendGame(room);
    });

    /* SPLIT */

    socket.on("split", () => {

        const room = findRoom(socket.id);

        if (!room) return;

        if (
            room.phase !== "playing" ||
            room.currentPlayerId !== socket.id
        ) return;

        const player = room.players.find(
            p => p.id === socket.id
        );

        if (!player) return;

        if (player.cards.length !== 2) {
            socket.emit(
                "gameError",
                "Split kan alleen met twee kaarten."
            );
            return;
        }

        if (
            cardValue(player.cards[0]) !==
            cardValue(player.cards[1])
        ) {
            socket.emit(
                "gameError",
                "Je kaarten moeten gelijk zijn."
            );
            return;
        }

        if (player.balance < player.bet) {
            socket.emit(
                "gameError",
                "Niet genoeg nepcredits."
            );
            return;
        }

        /*
         * Eén speler kan voorlopig één extra
         * kaart krijgen. De volledige twee-hand
         * split kan daarna worden uitgebreid.
         */

        player.balance -= player.bet;

        player.cards = [
            player.cards[0],
            draw(room)
        ];

        sendGame(room);
    });

    /* NEXT ROUND */

    socket.on("nextRound", () => {

        const room = findRoom(socket.id);

        if (!room) return;

        if (room.hostId !== socket.id) return;

        if (room.phase !== "finished") return;

        room.phase = "betting";
        room.dealerCards = [];
        room.currentPlayerId = null;
        room.resultMessage = "";

        for (const player of room.players) {
            player.bet = 0;
            player.cards = [];
            player.standing = false;
            player.busted = false;
            player.doubled = false;

            if (player.balance <= 0) {
                player.balance = 1000;
            }
        }

        sendGame(room);
    });

    /* LEAVE */

    socket.on("leaveRoom", () => {
        removePlayer(socket);
    });

    /* DISCONNECT */

    socket.on("disconnect", () => {
        removePlayer(socket);
        console.log("Disconnected:", socket.id);
    });
});

/* =========================
   ROUND
========================= */

function beginRound(room) {

    room.phase = "playing";
    room.deck = createDeck();
    room.resultMessage = "";

    room.dealerCards = [
        draw(room),
        draw(room)
    ];

    for (const player of room.players) {

        player.cards = [
            draw(room),
            draw(room)
        ];

        player.standing = false;
        player.busted = false;
        player.doubled = false;
    }

    room.currentPlayerId =
        room.players[0]?.id || null;

    sendGame(room);
}

function nextPlayer(room) {

    const index = room.players.findIndex(
        p => p.id === room.currentPlayerId
    );

    if (index === -1) {
        finishRound(room);
        return;
    }

    for (
        let i = index + 1;
        i < room.players.length;
        i++
    ) {
        const player = room.players[i];

        if (!player.standing && !player.busted) {
            room.currentPlayerId = player.id;
            return;
        }
    }

    finishRound(room);
}

function finishRound(room) {

    room.currentPlayerId = null;

    while (handValue(room.dealerCards) < 17) {
        room.dealerCards.push(draw(room));
    }

    const dealerTotal =
        handValue(room.dealerCards);

    const results = [];

    for (const player of room.players) {

        const total = handValue(player.cards);

        if (player.busted) {
            results.push(`${player.name}: verloren`);
            continue;
        }

        if (
            blackjack(player.cards) &&
            !blackjack(room.dealerCards)
        ) {
            player.balance +=
                Math.floor(player.bet * 2.5);

            results.push(
                `${player.name}: BLACKJACK`
            );

            continue;
        }

        if (dealerTotal > 21) {

            player.balance +=
                player.bet * 2;

            results.push(
                `${player.name}: gewonnen`
            );

        } else if (total > dealerTotal) {

            player.balance +=
                player.bet * 2;

            results.push(
                `${player.name}: gewonnen`
            );

        } else if (total === dealerTotal) {

            player.balance +=
                player.bet;

            results.push(
                `${player.name}: push`
            );

        } else {

            results.push(
                `${player.name}: verloren`
            );
        }
    }

    room.resultMessage =
        results.join(" • ");

    room.phase = "finished";

    sendGame(room);
}

/* =========================
   REMOVE PLAYER
========================= */

function removePlayer(socket) {

    const room = findRoom(socket.id);

    if (!room) return;

    room.players = room.players.filter(
        p => p.id !== socket.id
    );

    if (room.players.length === 0) {
        rooms.delete(room.code);
        return;
    }

    if (room.hostId === socket.id) {
        room.hostId = room.players[0].id;
    }

    if (room.currentPlayerId === socket.id) {
        nextPlayer(room);
    }

    sendRoom(room);
    sendGame(room);
}

server.listen(PORT, () => {
    console.log(
        `Blackjack server draait op poort ${PORT}`
    );
});
