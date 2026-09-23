import { Schema, type, MapSchema, ArraySchema } from "@colyseus/schema";
import { PlayerState } from "./PlayerState";
import { SidePot } from "./SidePot";

export type GamePhase =
  | "waiting" // ルーム待機中(ゲーム開始前)
  | "preflop"
  | "flop"
  | "turn"
  | "river"
  | "showdown"
  | "roundEnd" // ラウンド結果表示中(次ラウンドへの短い間)
  | "gameEnd"; // 全ラウンド終了、最終結果表示

export class RoomState extends Schema {
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();

  // 座席順(固定)。BTN回転やアクション順の基準にする。
  @type(["string"]) seatOrder = new ArraySchema<string>();

  @type(["string"]) communityCards = new ArraySchema<string>();

  @type("number") pot: number = 0;
  @type([SidePot]) sidePots = new ArraySchema<SidePot>();

  @type("string") phase: GamePhase = "waiting";

  @type("number") dealerSeatIndex: number = -1;
  @type("string") actionPlayerId: string = "";

  @type("number") currentBet: number = 0;
  @type("number") minRaiseUnit: number = 20; // = スモールブラインド額

  @type("number") smallBlind: number = 20;
  @type("number") bigBlind: number = 40;

  @type("number") roundNumber: number = 0;
  @type("number") maxRounds: number = 10;

  @type("number") startingChips: number = 1000;

  @type("string") mode: "normal" | "lostfull" = "normal";

  @type("string") lastAggressorId: string = ""; // ショーダウン公開順の基準

  @type(["string"]) log = new ArraySchema<string>(); // 直近の進行ログ(UI表示用)

  @type("boolean") gameStarted: boolean = false;

  // ロストフルモード:ロストイン(特殊技)の進行状態
  @type("boolean") lostInActive: boolean = false; // 宣言〜応答が全員終わるまでtrue
  @type("string") lostInDeclarerId: string = "";
  @type("number") lostInAmount: number = 0; // 宣言者の赤札額(=このハンドでの必要コール額)

  // UI表示用(山札・使用済みカード置き場の残り枚数)
  @type("number") deckRemaining: number = 0;
  @type("number") discardCount: number = 0;
}
