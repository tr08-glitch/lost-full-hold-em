import { Schema, type, ArraySchema } from "@colyseus/schema";

/**
 * 全クライアントに同期される「公開情報のみ」のプレイヤー状態。
 * ホールカードの中身はここには含めない(本人にのみ個別メッセージで送信する)。
 * ショーダウンで公開されたカードだけ revealedHoleCards に入る。
 */
export class PlayerState extends Schema {
  @type("string") id: string = "";
  @type("string") name: string = "";
  @type("number") seatIndex: number = -1;

  @type("number") chips: number = 0;
  @type("number") currentBet: number = 0; // 現在のベッティングラウンドでのBET額
  @type("number") totalRoundBet: number = 0; // このハンド全体で投入した額(サイドポット計算用)

  @type("boolean") folded: boolean = false;
  @type("boolean") allIn: boolean = false;
  @type("boolean") connected: boolean = true;
  @type("boolean") isGM: boolean = false;

  @type("boolean") isBTN: boolean = false;
  @type("boolean") isSB: boolean = false;
  @type("boolean") isBB: boolean = false;

  // 表示用ポジション名("BTN"|"BTN/SB"|"SB"|"BB"|"UTG"|"HJ"|"CO")。
  // isBTN/isSB/isBBはゲームロジック判定用、positionLabelはUI表示用(2人対戦時はBTN/SBが1つに合体する)
  @type("string") positionLabel: string = "";

  @type("boolean") hasActed: boolean = false; // 現在のベッティングラウンドで一度でも行動したか
  @type("number") holeCardCount: number = 0; // 手札枚数(内容は非公開)

  @type(["string"]) revealedHoleCards = new ArraySchema<string>(); // ショーダウン時のみ公開

  @type("string") lastAction: string = ""; // UI表示用: "check" | "call" | "raise" | "fold" | "allin" | ""

  // --- ロストフルモード用:身体パーツの状態(ゲーム全体を通して永続、ラウンドをまたいでリセットされない) ---
  @type("number") stress: number = 0;
  @type("boolean") isDead: boolean = false;
  @type("boolean") isVegetative: boolean = false; // 廃人状態

  @type("number") fingersLostLeft: number = 0; // 0〜5
  @type("number") fingersLostRight: number = 0; // 0〜5
  @type("boolean") teethLost: boolean = false; // 以降のストレス上昇が2倍になる
  @type("boolean") earsLostLeft: boolean = false;
  @type("boolean") earsLostRight: boolean = false;
  @type("boolean") lungsLostLeft: boolean = false;
  @type("boolean") lungsLostRight: boolean = false;
  @type("boolean") eyesLostLeft: boolean = false;
  @type("boolean") eyesLostRight: boolean = false;
  @type("boolean") armsLostLeft: boolean = false; // 片方でも失うと強制チェック/コールのみになる
  @type("boolean") armsLostRight: boolean = false;
  @type("boolean") heartLost: boolean = false;

  // 指の喪失により卓上に公開されたホールカード(このハンド限定で毎ラウンド"" にリセットされる)。
  // 左手の指喪失→publicCardLeft(=holeCards[0])、右手の指喪失→publicCardRight(=holeCards[1])
  @type("string") publicCardLeft: string = "";
  @type("string") publicCardRight: string = "";

  // チップ0になったプレイヤー(ノーマルモードでも発生しうる)。
  // 廃人・死亡と同様、以降のラウンドの進行から除外される(観戦扱い)
  @type("boolean") isBusted: boolean = false;

  // 「降参」ボタンによる自発的な離脱(以降のラウンドから除外、観戦扱い)
  @type("boolean") isSurrendered: boolean = false;
}
