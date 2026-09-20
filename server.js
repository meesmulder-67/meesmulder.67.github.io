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


/* =========================================================
   ROOMS
   ========================================================= */

const rooms = new Map();


function createRoomCode() {

    const chars =
        "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    let code;

    do {

        code = "";

        for (let i = 0; i < 6; i++) {

            code += chars[
                Math.floor(
                    Math.random() * chars.length
                )
            ];
        }

    } while (rooms.has(code));

    return code;
}


/* =========================================================
   DECK
   ========================================================= */

function createDeck() {

    const suits =
        ["♠", "♥", "♦", "♣"];

    const values =
        [
            "A", "2", "3", "4", "5", "6",
            "7", "8", "9", "10",
            "J", "Q", "K"
        ];

    const deck = [];

    for (let d = 0; d < 6; d++) {

        for (const suit of suits) {

            for (const value of values) {

                deck.push({
                    suit,
                    value
                });
            }
        }
    }


    for (
        let i = deck.length - 1;
        i > 0;
        i--
    ) {

        const j =
            Math.floor(
                Math.random() * (i + 1)
            );

        [
            deck[i],
            deck[j]
        ] = [
            deck[j],
            deck[i]
        ];
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

    if (
        card.value === "J" ||
        card.value === "Q" ||
        card.value === "K"
    ) {
        return 10;
    }

    if (card.value === "A") {
        return 11;
    }

    return Number(card.value);
}


function handValue(cards) {

    let total = 0;
    let aces = 0;

    for (const card of cards) {

        total += cardValue(card);

        if (card.value === "A") {
            aces++;
        }
    }


    while (
        total > 21 &&
        aces > 0
    ) {

        total -= 10;
        aces--;
    }


    return total;
}


/* =========================================================
   ROOM DATA
   ========================================================= */

function roomData(room) {

    return {
        code: room.code,

        hostId: room.hostId,

        players:
            room.players.map(player => ({
                id: player.id,
                name: player.name,
                balance: player.balance
            }))
    };
}


/* =========================================================
   GAME DATA
   ========================================================= */

function gameData(room, socketId) {

    const me =
        room.players.find(
            player =>
                player.id === socketId
        );


    return {

        phase: room.phase,

        hostId: room.hostId,

        myBalance:
            me ? me.balance : 0,

        dealerCards:
            room.dealerCards,

        dealerHidden:
            room.phase === "playing",

        players:
            room.players.map(player => ({

                id: player.id,

                name: player.name,

                balance: player.balance,

                bet: player.bet,

                cards: player.cards,

                active:
                    room.currentPlayerId ===
                    player.id,

                status:
                    player.busted
                        ? "BUST"
                        : player.standing
                            ? "STAND"
                            : ""
            })),

        currentPlayerId:
            room.currentPlayerId,

        allBetsPlaced:
            room.players.length > 0 &&
            room.players.every(
                player =>
                    player.bet > 0
            ),

        resultMessage:
            room.resultMessage || ""
    };
}


function sendGame(room) {

    room.players.forEach(player => {

        io.to(player.id).emit(
            "gameState",
            gameData(
                room,
                player.id
            )
        );
    });
}


function sendRoom(room) {

    io.to(room.code).emit(
        "roomUpdate",
        roomData(room)
    );
}


/* =========================================================
   FIND ROOM
   ========================================================= */

function findRoom(socketId) {

    for (const room of rooms.values()) {

        if (
            room.players.some(
                player =>
                    player.id === socketId
            )
        ) {

            return room;
        }
    }

    return null;
}


/* =========================================================
   CONNECTION
   ========================================================= */

io.on("connection", socket => {

    console.log(
        "Speler verbonden:",
        socket.id
    );


    /* =====================================================
       ROOM MAKEN
       ===================================================== */

    socket.on(
        "createRoom",
        data => {

            const code =
                createRoomCode();


            const player = {

                id: socket.id,

                name:
                    cleanName(
                        data?.name
                    ),

                balance: 1000,

                bet: 0,

                cards: [],

                standing: false,

                busted: false
            };


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


            rooms.set(
                code,
                room
            );


            socket.join(code);


            socket.emit(
                "roomCreated",
                roomData(room)
            );
        }
    );


    /* =====================================================
       JOIN ROOM
       ===================================================== */

    socket.on(
        "joinRoom",
        data => {

            const code =
                String(
                    data?.code || ""
                )
                .trim()
                .toUpperCase();


            const room =
                rooms.get(code);


            if (!room) {

                socket.emit(
                    "joinError",
                    "Deze kamer bestaat niet."
                );

                return;
            }


            if (
                room.phase !==
                "waiting"
            ) {

                socket.emit(
                    "joinError",
                    "Dit spel is al gestart."
                );

                return;
            }


            if (
                room.players.length >= 4
            ) {

                socket.emit(
                    "joinError",
                    "Deze tafel zit vol."
                );

                return;
            }


            const player = {

                id: socket.id,

                name:
                    cleanName(
                        data?.name
                    ),

                balance: 1000,

                bet: 0,

                cards: [],

                standing: false,

                busted: false
            };


            room.players.push(
                player
            );


            socket.join(code);


            socket.emit(
                "roomJoined",
                roomData(room)
            );


            sendRoom(room);
        }
    );


    /* =====================================================
       HOST START GAME
       ===================================================== */

    socket.on(
        "startGame",
        () => {

            const room =
                findRoom(socket.id);


            if (!room)
                return;


            if (
                room.hostId !==
                socket.id
            ) {

                socket.emit(
                    "gameError",
                    "Alleen de host kan het spel starten."
                );

                return;
            }


            if (
                room.phase !==
                "waiting"
            ) {

                return;
            }


            room.phase = "betting";

            room.deck =
                createDeck();

            room.dealerCards = [];

            room.currentPlayerId =
                null;

            room.resultMessage = "";


            room.players.forEach(
                player => {

                    player.bet = 0;

                    player.cards = [];

                    player.standing =
                        false;

                    player.busted =
                        false;
                }
            );


            sendGame(room);
        }
    );


    /* =====================================================
       BET
       ===================================================== */

    socket.on(
        "placeBet",
        data => {

            const room =
                findRoom(socket.id);


            if (!room)
                return;


            if (
                room.phase !==
                "betting"
            )
                return;


            const player =
                room.players.find(
                    p =>
                        p.id ===
                        socket.id
                );


            if (!player)
                return;


            let amount =
                Number(
                    data?.amount
                );


            if (
                !Number.isFinite(
                    amount
                )
            )
                return;


            amount =
                Math.floor(
                    amount
                );


            if (amount <= 0)
                return;


            if (
                player.balance <
                amount
            ) {

                socket.emit(
                    "gameError",
                    "Niet genoeg credits."
                );

                return;
            }


            player.bet +=
                amount;

            player.balance -=
                amount;


            sendGame(room);
        }
    );


    /* =====================================================
       HOST START ROUND
       ===================================================== */

    socket.on(
        "startRound",
        () => {

            const room =
                findRoom(socket.id);


            if (!room)
                return;


            if (
                room.hostId !==
                socket.id
            ) {

                socket.emit(
                    "gameError",
                    "Alleen de host kan het spel starten."
                );

                return;
            }


            if (
                room.phase !==
                "betting"
            )
                return;


            const allBet =
                room.players.every(
                    player =>
                        player.bet > 0
                );


            if (!allBet) {

                socket.emit(
                    "gameError",
                    "Iedere speler moet eerst inzetten."
                );

                return;
            }


            beginRound(room);
        }
    );


    /* =====================================================
       HIT
       ===================================================== */

    socket.on(
        "hit",
        () => {

            const room =
                findRoom(socket.id);


            if (!room)
                return;


            if (
                room.phase !==
                "playing"
            )
                return;


            if (
                room.currentPlayerId !==
                socket.id
            )
                return;


            const player =
                room.players.find(
                    p =>
                        p.id ===
                        socket.id
                );


            if (!player)
                return;


            player.cards.push(
                draw(room)
            );


            const total =
                handValue(
                    player.cards
                );


            if (total > 21) {

                player.busted = true;

                player.standing =
                    true;

                nextPlayer(room);

            } else if (
                total === 21
            ) {

                player.standing =
                    true;

                nextPlayer(room);
            }


            sendGame(room);
        }
    );


    /* =====================================================
       STAND
       ===================================================== */

    socket.on(
        "stand",
        () => {

            const room =
                findRoom(socket.id);


            if (!room)
                return;


            if (
                room.phase !==
                "playing"
            )
                return;


            if (
                room.currentPlayerId !==
                socket.id
            )
                return;


            const player =
                room.players.find(
                    p =>
                        p.id ===
                        socket.id
                );


            if (!player)
                return;


            player.standing =
                true;


            nextPlayer(room);


            sendGame(room);
        }
    );


    /* =====================================================
       DOUBLE
       ===================================================== */

    socket.on(
        "double",
        () => {

            const room =
                findRoom(socket.id);


            if (!room)
                return;


            if (
                room.phase !==
                "playing"
            )
                return;


            if (
                room.currentPlayerId !==
                socket.id
            )
                return;


            const player =
                room.players.find(
                    p =>
                        p.id ===
                        socket.id
                );


            if (!player)
                return;


            if (
                player.cards.length !==
                2
            ) {

                socket.emit(
                    "gameError",
                    "Double kan alleen met je eerste twee kaarten."
                );

                return;
            }


            if (
                player.balance <
                player.bet
            ) {

                socket.emit(
                    "gameError",
                    "Niet genoeg credits."
                );

                return;
            }


            player.balance -=
                player.bet;


            player.bet *= 2;


            player.cards.push(
                draw(room)
            );


            if (
                handValue(
                    player.cards
                ) > 21
            ) {

                player.busted =
                    true;
            }


            player.standing =
                true;


            nextPlayer(room);


            sendGame(room);
        }
    );


    /* =====================================================
       NEXT ROUND
       ===================================================== */

    socket.on(
        "nextRound",
        () => {

            const room =
                findRoom(socket.id);


            if (!room)
                return;


            if (
                room.hostId !==
                socket.id
            )
                return;


            if (
                room.phase !==
                "finished"
            )
                return;


            room.phase =
                "betting";


            room.dealerCards = [];

            room.currentPlayerId =
                null;

            room.resultMessage =
                "";


            room.players.forEach(
                player => {

                    player.bet = 0;

                    player.cards = [];

                    player.standing =
                        false;

                    player.busted =
                        false;


                    /*
                       Als iemand helemaal
                       blut is krijgt hij
                       opnieuw 1000 credits.
                    */

                    if (
                        player.balance <= 0
                    ) {

                        player.balance =
                            1000;
                    }
                }
            );


            sendGame(room);
        }
    );


    /* =====================================================
       LEAVE
       ===================================================== */

    socket.on(
        "leaveRoom",
        () => {

            removePlayer(socket);
        }
    );


    /* =====================================================
       DISCONNECT
       ===================================================== */

    socket.on(
        "disconnect",
        () => {

            removePlayer(socket);

            console.log(
                "Speler weg:",
                socket.id
            );
        }
    );
});


/* =========================================================
   BEGIN ROUND
   ========================================================= */

function beginRound(room) {

    room.phase =
        "playing";


    room.deck =
        createDeck();


    room.dealerCards = [
        draw(room),
        draw(room)
    ];


    room.players.forEach(
        player => {

            player.cards = [
                draw(room),
                draw(room)
            ];

            player.standing =
                false;

            player.busted =
                false;
        }
    );


    room.currentPlayerId =
        room.players[0]?.id ||
        null;


    sendGame(room);
}


/* =========================================================
   NEXT PLAYER
   ========================================================= */

function nextPlayer(room) {

    const index =
        room.players.findIndex(
            player =>
                player.id ===
                room.currentPlayerId
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

        const player =
            room.players[i];


        if (
            !player.standing &&
            !player.busted
        ) {

            room.currentPlayerId =
                player.id;

            return;
        }
    }


    finishRound(room);
}


/* =========================================================
   FINISH ROUND
   ========================================================= */

function finishRound(room) {

    room.currentPlayerId =
        null;


    /*
       Dealer speelt volgens normale
       blackjackregel: hit onder 17.
    */

    while (
        handValue(
            room.dealerCards
        ) < 17
    ) {

        room.dealerCards.push(
            draw(room)
        );
    }


    const dealerTotal =
        handValue(
            room.dealerCards
        );


    const results = [];


    room.players.forEach(
        player => {

            const playerTotal =
                handValue(
                    player.cards
                );


            if (
                player.busted
            ) {

                results.push(
                    `${player.name}: bust`
                );

                return;
            }


            if (
                dealerTotal > 21
            ) {

                player.balance +=
                    player.bet * 2;

                results.push(
                    `${player.name}: gewonnen`
                );

                return;
            }


            if (
                playerTotal >
                dealerTotal
            ) {

                player.balance +=
                    player.bet * 2;

                results.push(
                    `${player.name}: gewonnen`
                );

                return;
            }


            if (
                playerTotal ===
                dealerTotal
            ) {

                player.balance +=
                    player.bet;

                results.push(
                    `${player.name}: push`
                );

                return;
            }


            results.push(
                `${player.name}: verloren`
            );
        }
    );


    room.resultMessage =
        results.join(" • ");


    room.phase =
        "finished";


    sendGame(room);
}


/* =========================================================
   REMOVE PLAYER
   ========================================================= */

function removePlayer(socket) {

    const room =
        findRoom(socket.id);


    if (!room)
        return;


    room.players =
        room.players.filter(
            player =>
                player.id !==
                socket.id
        );


    /*
       Kamer leeg?
    */

    if (
        room.players.length === 0
    ) {

        rooms.delete(
            room.code
        );

        return;
    }


    /*
       Host vertrekt:
       eerste speler wordt host.
    */

    if (
        room.hostId ===
        socket.id
    ) {

        room.hostId =
            room.players[0].id;
    }


    /*
       Was de vertrokken speler
       aan de beurt?
    */

    if (
        room.currentPlayerId ===
        socket.id
    ) {

        nextPlayer(room);
    }


    sendRoom(room);
    sendGame(room);
}


/* =========================================================
   NAME
   ========================================================= */

function cleanName(name) {

    if (!name)
        return "Speler";

    return String(name)
        .replace(/[<>]/g, "")
        .substring(0, 18);
}


/* =========================================================
   SERVER
   ========================================================= */

server.listen(
    PORT,
    () => {

        console.log(
            `Blackjack server draait op poort ${PORT}`
        );
    }
);
