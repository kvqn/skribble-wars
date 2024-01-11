import { db } from "@/server/db"
import type {
  SocketChatEvent,
  SocketPartyCreateEvent,
  SocketPartyDestroyEvent,
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
})

io.listen(3001)