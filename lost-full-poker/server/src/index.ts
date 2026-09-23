import http from "http";
import express from "express";
import { Server } from "colyseus";
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

const server = http.createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server }),
});

gameServer.define("poker", PokerRoom);

gameServer.listen(port);
console.log(`Listening on ws://localhost:${port}`);
