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
  | "judge"
  | "needExchange" // ロストフル:チップが尽きたプレイヤーが部位換金を終えるのを待っている
  | "roundEnd" // ラウンド結果表示中(次ラウンドへの短い間)
  | "gameEnd"; // 全ラウンド終了、最終結果表示

/** ロビーで遊べるミニゲーム「ハイ&ロー」の状態 */
export class IJState extends Schema {
  @type("string") phase: "idle" | "recruiting" | "playing" | "result" = "idle";
  @type("number") bet: number = 0; // 掛け金(次のゲームの初期チップから)
  @type(["string"]) participants = new ArraySchema<string>();
  @type("string") step: "pick" | "reveal" = "pick"; // pick=予想中 / reveal=結果公開中
  @type("number") fieldNum: number = 0; // 場の数字(結果公開まで0=非公開)
  @type("number") roundId: number = 0; // 開始ごとに増える(クライアントのリセット用)
  @type(["string"]) pickedIds = new ArraySchema<string>(); // 予想済みの人(内容は非公開)
  @type(["string"]) winners = new ArraySchema<string>(); // 的中者
  @type("number") winnerGain: number = 0; // 的中者1人あたりの純増額(山分け−自分の掛け金)
  @type("number") turnLeft: number = 0; // 予想の残り秒数
}

export class RoomState extends Schema {
  @type(IJState) ij = new IJState();
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();

  // 座席順(固定)。BTN回転やアクション順の基準にする。
  @type(["string"]) seatOrder = new ArraySchema<string>();

  @type(["string"]) communityCards = new ArraySchema<string>();

  @type("number") pot: number = 0;
  @type([SidePot]) sidePots = new ArraySchema<SidePot>();

  @type("string") phase: GamePhase = "waiting";
  @type("string") endReason: "" | "rounds" | "survivor" = ""; // ゲーム終了理由(rounds=ラウンド切れ / survivor=生存者1人以下)

  @type("number") dealerSeatIndex: number = -1;
  @type("string") actionPlayerId: string = "";

  @type("number") currentBet: number = 0;
  @type("number") minRaiseUnit: number = 20; // = スモールブラインド額

  @type("number") smallBlind: number = 20;
  @type("number") bigBlind: number = 40;

  @type("number") roundNumber: number = 0;
  @type(["string"]) needExchange = new ArraySchema<string>(); // チップが尽きて換金待ちのプレイヤー
  @type("number") timeLimit: number = 30; // 持ち時間(秒)。時間切れで自動フォールド
  @type("number") timeLeft: number = 0; // 現在の手番の残り秒数(表示用)
  @type("number") maxRounds: number = 10;

  @type("number") startingChips: number = 1000;

  @type("string") mode: "normal" | "lostfull" = "normal";

  // ジョーカー設定(GMがゲーム設定モーダルで変更可能)
  @type("boolean") jokerEnabled: boolean = false;
  @type("number") jokerCount: number = 2;
  // 山札の使い回し(GM設定、デフォルトoff)。on=毎ラウンド全カードを山札に戻す / off=使ったカードは山札に戻らず、足りなくなったら全て戻してシャッフル
  @type("boolean") deckReuse: boolean = false;
  // 観戦者にプレイヤーの手札を公開するか(GM設定、デフォルト非公開)
  @type("boolean") spectatorSeeHands: boolean = false;

  @type("string") lastAggressorId: string = ""; // ショーダウン公開順の基準

  @type(["string"]) log = new ArraySchema<string>(); // 直近の進行ログ(UI表示用)

  @type("boolean") gameStarted: boolean = false;

  // 4桁の数字によるルームコード(参加者が入力する用。Colyseus内部のroomIdとは別物)
  @type("string") roomCode: string = "";

  // ロストフルモード:ロストイン(特殊技)の進行状態
  @type("boolean") lostInActive: boolean = false; // 宣言〜応答が全員終わるまでtrue
  @type("string") lostInDeclarerId: string = "";
  @type("number") lostInAmount: number = 0; // 宣言者の赤札額(=このハンドでの必要コール額)

  // UI表示用(山札・使用済みカード置き場の残り枚数)
  @type("number") deckRemaining: number = 0;
  @type("number") discardCount: number = 0;
}
