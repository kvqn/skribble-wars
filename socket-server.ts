import { db } from "@/server/db"
import { sleep } from "@/server/utils"
import type {
  SocketChangeGameStateEvent,
  SocketChangeTeamEvent,
  SocketChatEvent,
  SocketDrawEvent,
  SocketFinishDrawingEvent,
  SocketGuessEvent,
  SocketPartyCreateEvent,
  SocketPartyDestroyEvent,
  SocketStartDrawingEvent,
  SocketStartGameEvent,
  SocketUserEnterEvent,
} from "@/types"
import { Server } from "socket.io"

const io = new Server({
  cors: {
    origin: "http://localhost:3000",
  },
})

const userPartyMap = new Map<string, string>()
const socketUserMap = new Map<string, string>()
const partyMap = new Map<
  string,
  {
    leaderId: string
    teams: { red: Set<string>; blue: Set<string> }
    scores: { red: number; blue: number }
    round: number
    half: "FIRST" | "SECOND"
    drawingTeam: "red" | "blue" | null
    drawingUserId: string | null
    currentWord: string | null
    rounds: number
    timeToGuess: number
  }
>()

const getParty = async (partyId: string) => {
  if (partyMap.has(partyId)) return partyMap.get(partyId)!

  const dbParty = await db.party.findUnique({
    where: {
      id: partyId,
    },
  })

  if (!dbParty) return null

  const party = {
    leaderId: dbParty.leaderId,
    teams: {
      red: new Set<string>(),
      blue: new Set<string>(),
    },
    scores: {
      red: 0,
      blue: 0,
    },
    round: 0,
    half: "FIRST" as const,
    drawingTeam: null,
    drawingUserId: null,
    currentWord: null,
    guessed: false,
    rounds: 3,
    timeToGuess: 10000,
  }

  partyMap.set(partyId, party)

  return party
}

const getUserAndParty = (socketId: string) => {
  const userId = socketUserMap.get(socketId)
  let partyId = undefined
  if (userId) partyId = userPartyMap.get(userId)
  return {
    userId,
    partyId,
  }
}

io.on("connection", (socket) => {
  console.log("connected", socket.id)

  socket.on("SocketIdentify", async (userId: string) => {
    socketUserMap.set(socket.id, userId)
    io.to(socket.id).emit("SocketIdentifyAck")
    console.log(socket.id, "identified as", userId)
  })

  socket.on("SocketJoinParty", async (partyId: string) => {
    console.log("SocketJoinParty")
    const userId = socketUserMap.get(socket.id)
    if (!userId) return

    const party = await db.party.findUnique({
      where: {
        id: partyId,
      },
    })

    if (!party) {
      console.log(userId, "tried to join a party that doesn't exist")
      return
    }

    userPartyMap.set(userId, party.id)
    await socket.join(party.id)
    console.log(userId, "joined", party.id)

    const events = await db.event.findMany({
      where: {
        partyId: partyId,
      },
      include: {
        ChatEvent: {
          include: {
            user: true,
          },
        },
        UserEnterEvent: {
          include: {
            user: true,
          },
        },
        UserLeaveEvent: {
          include: {
            user: true,
          },
        },
        PartyLeaderChangeEvent: {
          include: {
            user: true,
          },
        },
        PartyCreateEvent: {
          include: {
            User: true,
          },
        },
        PartyDestroyEvent: {
          include: {
            User: true,
          },
        },
        ChangeTeamEvent: {
          include: {
            user: true,
          },
        },
      },
      orderBy: {
        id: "asc",
      },
    })

    for (const event of events) {
      if (event.PartyCreateEvent) {
        const emitEvent: SocketPartyCreateEvent = event.PartyCreateEvent
        io.to(socket.id).emit("SocketPartyCreateEvent", emitEvent)
      }
      if (event.PartyDestroyEvent) {
        const emitEvent: SocketPartyDestroyEvent = event.PartyDestroyEvent
        io.to(socket.id).emit("SocketPartyDestroyEvent", emitEvent)
      }
      if (event.UserEnterEvent) {
        const emitEvent: SocketUserEnterEvent = event.UserEnterEvent
        io.to(socket.id).emit("SocketUserEnterEvent", emitEvent)
      }
      if (event.UserLeaveEvent) {
        const emitEvent: SocketUserEnterEvent = event.UserLeaveEvent
        io.to(socket.id).emit("SocketUserLeaveEvent", emitEvent)
      }
      if (event.ChatEvent) {
        const emitEvent: SocketChatEvent = {
          userId: event.ChatEvent.userId,
          name: event.ChatEvent.user.name ?? "",
          image: event.ChatEvent.user.image,
          message: event.ChatEvent.message,
        }
        io.to(socket.id).emit("SocketChatEvent", emitEvent)
      }

      if (event.ChangeTeamEvent) {
        const emitEvent: SocketChangeTeamEvent = {
          user: {
            id: event.ChangeTeamEvent.userId,
            name: event.ChangeTeamEvent.user.name ?? "",
            image: event.ChangeTeamEvent.user.image,
          },
          team: event.ChangeTeamEvent.team,
        }
        io.to(socket.id).emit("SocketChangeTeamEvent", emitEvent)
      }
    }
  })

  socket.on("SocketChatEvent", async (event: SocketChatEvent) => {
    const userId = socketUserMap.get(socket.id)
    if (!userId) {
      console.log("SocketChatEvent: no user id")
      return
    }
    const partyId = userPartyMap.get(userId)
    if (!partyId) {
      console.log("SocketChatEvent: no party id")
      return
    }
    console.log("SocketChatEvent", userId, partyId)
    console.log(socket.rooms)

    io.to(partyId).emit("SocketChatEvent", event)

    await db.event.create({
      data: {
        partyId: partyId,
        ChatEvent: {
          create: {
            userId: userId,
            message: event.message,
          },
        },
      },
    })

    console.log("SocketChatEvent: created event")
  })

  socket.on("SocketStartDrawing", (event: SocketStartDrawingEvent) => {
    const userId = socketUserMap.get(socket.id)
    if (!userId) return
    const partyId = userPartyMap.get(userId)
    if (!partyId) return

    socket.to(partyId).emit("SocketStartDrawing", event)
  })

  socket.on("SocketDraw", (event: SocketDrawEvent) => {
    const userId = socketUserMap.get(socket.id)
    if (!userId) return
    const partyId = userPartyMap.get(userId)
    if (!partyId) return

    socket.to(partyId).emit("SocketDraw", event)
  })

  socket.on("SocketFinishDrawing", (event: SocketFinishDrawingEvent) => {
    const userId = socketUserMap.get(socket.id)
    if (!userId) return
    const partyId = userPartyMap.get(userId)
    if (!partyId) return

    socket.to(partyId).emit("SocketFinishDrawing", event)
  })

  socket.on("SocketChangeTeamEvent", async (event: SocketChangeTeamEvent) => {
    const userId = socketUserMap.get(socket.id)
    if (!userId) return
    const partyId = userPartyMap.get(userId)
    if (!partyId) return

    const party = await getParty(partyId)
    if (!party) return

    if (event.team === "red") {
      party.teams.blue.delete(userId)
      party.teams.red.add(userId)
    } else if (event.team === "blue") {
      party.teams.red.delete(userId)
      party.teams.blue.add(userId)
    }

    partyMap.set(partyId, party)

    io.to(partyId).emit("SocketChangeTeamEvent", event)
    await db.event.create({
      data: {
        partyId: partyId,
        ChangeTeamEvent: {
          create: {
            userId: userId,
            team: event.team,
          },
        },
      },
    })

    console.log("SocketChangeTeamEvent")
  })

  const SocketRoundChangeEvent = async (partyId: string) => {
    const party = partyMap.get(partyId)
    if (!party) return

    if (party.round == 0) {
      party.round = 1
      party.drawingTeam = Math.random() > 0.5 ? "red" : "blue"
      party.half = "FIRST"
    } else {
      if (party.half == "FIRST") {
        party.half = "SECOND"
      } else {
        party.half = "FIRST"
        party.round++
      }
      party.drawingTeam = party.drawingTeam === "red" ? "blue" : "red"
    }

    if (party.round >= party.rounds) {
      io.to(partyId).emit("SocketChangeGameStateEvent", {
        state: "GAME_OVER",
      } as SocketChangeGameStateEvent)
      return
    }

    if (party.drawingTeam === "red") {
      party.drawingUserId = Array.from(party.teams.red).sort()[
        party.round % party.teams.red.size
      ]!
    } else {
      party.drawingUserId = Array.from(party.teams.blue).sort()[
        party.round % party.teams.blue.size
      ]!
    }

    party.currentWord = "apple"

    const half = party.half
    const round = party.round

    partyMap.set(partyId, party)

    io.to(partyId).emit("SocketChangeGameStateEvent", {
      state: "ROUND_CHANGE",
      round: party.round,
      drawingTeam: party.drawingTeam,
      drawingUserId: party.drawingUserId,
      timeToGuess: party.timeToGuess,
    } as SocketChangeGameStateEvent)

    Array.from(socketUserMap.entries())
      .filter((entry) => entry[1] === party.drawingUserId)
      .map((entry) => entry[0])
      .forEach((socketId) => {
        console.log("start drawing", socketId)
        io.to(socketId).emit("SocketUserStartDrawing")
      })

    await sleep(party.timeToGuess)

    const partyAfter = partyMap.get(partyId)!
    if (partyAfter.round === round && partyAfter.half === half) {
      Array.from(socketUserMap.entries())
        .filter((entry) => entry[1] === party.drawingUserId)
        .map((entry) => entry[0])
        .forEach((socketId) => {
          console.log("start drawing", socketId)
          io.to(socketId).emit("SocketUserStopDrawing")
        })
      io.to(partyId).emit("SocketChangeGameStateEvent", {
        state: "GUESS_TIMEOUT",
        word: party.currentWord,
      } as SocketChangeGameStateEvent)
      await sleep(3000)
      await SocketRoundChangeEvent(partyId)
    }
  }

  socket.on("SocketGuess", async (event: SocketGuessEvent) => {
    const { userId, partyId } = getUserAndParty(socket.id)
    if (!userId || !partyId) return

    const party = await getParty(partyId)
    if (!party) return
    if (!party.currentWord) return

    if (event.guess == party.currentWord) {
      io.to(partyId).emit("SocketChangeGameStateEvent", {
        state: "GUESS_CORRECT",
        word: party.currentWord,
        guesserId: userId,
      } as SocketChangeGameStateEvent)
      await sleep(3000)
      await SocketRoundChangeEvent(partyId)
    }
  })

  socket.on("SocketStartGameEvent", async (event: SocketStartGameEvent) => {
    const { userId, partyId } = getUserAndParty(socket.id)
    if (!userId || !partyId) return

    const party = await getParty(partyId)
    if (!party) return

    console.log(event)

    party.rounds = event.rounds
    party.timeToGuess = event.timeToGuess * 1000

    partyMap.set(partyId, party)

    // TODO: check if game hasn't already started
    // TODO: check if user is party leader
    // TODO: check if both teams have at least 1 user

    io.to(partyId).emit("SocketChangeGameStateEvent", {
      state: "TOSS",
    } as SocketChangeGameStateEvent)

    await sleep(5000)

    await SocketRoundChangeEvent(partyId)
  })
})

console.log("Listening on port 3001")
io.listen(3001)
