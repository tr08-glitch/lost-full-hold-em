import http from "http";
import express from "express";
import { Server, matchMaker } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { PokerRoom } from "./rooms/PokerRoom";

const port = Number(process.env.PORT) || 2567;
const app = express();

// 静的サイト(Renderの別サービス)からのクロスオリジン接続を許可する
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

app.get("/", (_req, res) => {
  res.send("ロストフルホールデム サーバーは稼働中です");
});

// 4桁のルームコード(PokerRoom.onCreateで発行・metadataに保存)から、
// クライアントが実際に接続するColyseusのroomIdを引く
app.get("/room-by-code/:code", async (req, res) => {
  const code = req.params.code;
  const rooms = await matchMaker.query({ name: "poker" });
  const found = rooms.find((r) => r.metadata && r.metadata.code === code);
  if (!found) {
    res.status(404).json({ error: "room_not_found" });
    return;
  }
  res.json({ roomId: found.roomId });
});

const server = http.createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server }),
});

gameServer.define("poker", PokerRoom);

gameServer.listen(port);
console.log(`Listening on ws://localhost:${port}`);
