# クライアント連携ガイド(サーバー⇔UI)

対戦卓画面(table.html)などの実クライアントを、このサーバー(`PokerRoom`)につなぐ際の連携仕様。
既存のモックアップ(table.html)はlocalStorageで疑似的に動いているだけなので、実クライアント化する際は
この仕様に沿って「RoomStateの購読」と「メッセージの送受信」に置き換える。

## 接続

Colyseus.jsクライアントを使用する想定。

```js
import { Client } from "colyseus.js";

const client = new Client("ws://<サーバーのホスト>:<ポート>");
const room = await client.joinOrCreate("poker", {
  name: "プレイヤー名", // room-create.html / room-join.htmlで入力した名前
});
```

- **ルームコードの方式**:Colyseusがルームごとに自動発行する`roomId`(英数字の文字列)を、そのまま「ルームコード」として使う。4桁数字のような専用コード体系は導入しない
- GM(ルーム作成)は `client.create("poker", options)`、参加者は `client.joinById(roomId, { name })` を使う
- ページ遷移(title→room-create→table)のたびにJSの実行コンテキストがリセットされる(＝WebSocket接続が切れる)ため、`room.roomId` / `room.sessionId` / `room.reconnectionToken` を`sessionStorage`に保存しておき、次のページでは`client.reconnect(reconnectionToken)`で同じセッションに復帰する。この一連の処理は`mockups/js/lfh-client.js`にまとめてある(`LFH.createRoom` / `LFH.joinRoom` / `LFH.reconnectRoom`)
- サーバー側(`PokerRoom.onLeave`)は、非明示的な切断(ページ遷移含む)に対して60秒間の再接続猶予を`allowReconnection`で与えるよう実装済み。「退室」ボタンなど明示的な離脱時は`room.leave(true)`(consented=true)を呼ぶことで、猶予なしで即座に処理される
- `options.mode` / `options.bigBlind` / `options.startingChips` / `options.maxRounds` は
  ルーム作成時(`client.create`の第2引数)にGMが指定する。ゲーム開始前であれば`updateSettings`メッセージで変更も可能

## RoomState(自動同期される公開情報)

`room.state` は以下の構造を持ち、変更があると自動的にクライアントへ配信される(Colyseusのスキーマ同期)。

```
RoomState {
  players: Map<sessionId, PlayerState>
  seatOrder: string[]              // 座席順(sessionIdの配列、固定)
  communityCards: string[]         // 例: ["As", "Kd", "9h"]。まだ公開されていない分は要素として存在しない
  pot: number
  sidePots: { amount, eligiblePlayerIds }[]
  phase: "waiting"|"preflop"|"flop"|"turn"|"river"|"showdown"|"roundEnd"|"gameEnd"
  dealerSeatIndex: number
  actionPlayerId: string           // 現在の手番のsessionId
  currentBet: number
  minRaiseUnit: number             // = スモールブラインド額
  smallBlind: number
  bigBlind: number
  roundNumber: number
  maxRounds: number
  startingChips: number
  mode: "normal"|"lostfull"
  lastAggressorId: string
  log: string[]                    // 直近の進行ログ(最大50件)
  gameStarted: boolean
  deckRemaining: number            // 山札の残り枚数
  discardCount: number             // 使用済みカード置き場の枚数
  lostInActive: boolean            // ロストインの宣言〜応答が進行中かどうか
  lostInDeclarerId: string         // 宣言者のsessionId
  lostInAmount: number             // 宣言者の赤札額(応答者が「コール」する場合に支払う額)
}

PlayerState {
  id, name, seatIndex
  chips, currentBet, totalRoundBet
  folded, allIn, connected, isGM
  isBTN, isSB, isBB, positionLabel  // 例: "BTN", "BTN/SB", "UTG"
  hasActed
  holeCardCount                    // 枚数のみ(中身は非公開)
  revealedHoleCards: string[]      // ショーダウンで公開されたときだけ中身が入る
  lastAction                       // "check"|"call"|"raise"|"fold"|"allin"|""
  stress, isDead, isVegetative     // ロストフルモード用(未実装)
  isBusted                         // チップ0によるバスト(以降のラウンドから除外)
  isSurrendered                    // 降参ボタンによる自発的な離脱(以降のラウンドから除外)
}
```

カード表記は `"As"`(ランク+スート、T=10、スートはs/h/d/c)。UI側で絵柄・数字に変換すること。

### UI実装の目安
- `room.state.players.onAdd/onRemove` で参加者一覧を描画
- 各`PlayerState`の変更(`.onChange`やリアクティブバインディング)でチップ・BET額・ポジションバッジを更新
- `phase`の変化でコミュニティカードの公開演出(フロップ3枚→ターン→リバー)を出す
- `actionPlayerId === room.sessionId` のときだけ自分のアクションボタンを活性化

## サーバー→クライアントのメッセージ(個別 or 全体送信)

### `yourHoleCards`(本人のみ)
```js
room.onMessage("yourHoleCards", ({ cards }) => {
  // cards: ["Ah", "Kd"] など。自分のホールカード2枚(表向き表示用)
});
```
ラウンド開始のたびに、本人にだけ送られる。他プレイヤーには送られない(のぞき見防止)。

### `showdownResult`(全員)
```js
room.onMessage("showdownResult", ({ results, noShowdown }) => {
  // results: [{ playerId, name, handName, handDescr, amountWon }, ...]
  // handName: "Two Pair" のような役名(pokersolver由来、英語)。UI側で日本語の役名に変換すること
  // noShowdown: true の場合、全員フォールドによる不戦勝(役の情報は無い=handName/handDescrはnull)
});
```
ショーダウン結果、または全員フォールドによる決着のたびに送信される。獲得チップ演出などに使う。

### `actionError`(本人のみ)
```js
room.onMessage("actionError", ({ reason }) => {
  // reason: "not_your_turn" | "not_betting_phase" | "cannot_act"
  //       | "check_not_allowed" | "call_not_allowed" | "invalid_raise_amount"
  //       | "no_chips" | "unknown_action_type"
});
```
自分が送った`action`メッセージがサーバー側で無効と判定された場合に送られる。
UI側でボタンの活性/非活性を正しく制御していれば基本的に発生しないはずだが、
通信タイミングのズレ(自分のターンが終わった直後の操作など)に備えて必ずハンドリングすること。

## クライアント→サーバーのメッセージ

### `startGame`(GMのみ有効)
```js
room.send("startGame");
```
引数なし。GM以外が送っても無視される。

### `action`
```js
room.send("action", { type: "check" });
room.send("action", { type: "call" });
room.send("action", { type: "raise", amount: 120 }); // amountは「自分の合計BET額」(追加額ではない)
room.send("action", { type: "allin" });
room.send("action", { type: "fold" });
```
- `raise`の`amount`は上乗せ額ではなく、そのアクション後に自分が到達するBET合計額であることに注意
  (例:現在40ベットしていて、80まで上げたい場合は `amount: 80`)
- レイズ可能な範囲(`minRaiseUnit`・`currentBet`から計算できる最小/最大)はUI側で事前に計算してボタンやスライダーの範囲を制限すること。サーバー側でも`isValidRaise`で最終検証している

### `surrender`
```js
room.send("surrender");
```
引数なし。ゲーム中に送ると、その場でフォールドした上で以降のラウンドから除外される(観戦扱い、`isSurrendered`がtrueになる)。
ゲーム開始前(ロビー中)に送った場合は、退室と同じ扱いになる。

### `updateSettings`(GMのみ有効、ゲーム開始前のみ)
```js
room.send("updateSettings", {
  mode: "normal", // "normal" | "lostfull"
  startingChips: 1000,
  maxRounds: 10,
  bigBlind: 40, // smallBlind/minRaiseUnitはサーバー側で自動的に半額に再計算される
});
```
全てのキーが任意(渡さなかった項目は変更されない)。ジョーカー関連の設定はサーバー未実装のため、送っても反映されない。

## 実クライアント実装済みの範囲(mockups/)
title.html → room-create.html(GM)/ room-join.html → table.html の一連の画面は、
`mockups/js/lfh-client.js` 経由でこのサーバーに実接続するよう実装済み。
- **サーバーURLの設定**:`mockups/js/lfh-client.js` 先頭の `SERVER_URL` を、実際にデプロイしたサーバーの
  WebSocket URL(例: `wss://your-app.onrender.com`)に書き換える必要がある。デフォルトは `ws://localhost:2567`
- ルームコードは前述の通りColyseusの`roomId`をそのまま使用
- ページ遷移のたびに再接続(`client.reconnect`)する方式のため、リロードにも耐えられる

### `exchangeBodyPart`(ロストフルモードのみ、いつでも送信可能)
```js
room.send("exchangeBodyPart", { part: "finger", side: "left" });
room.send("exchangeBodyPart", { part: "tooth" });          // sideなし
room.send("exchangeBodyPart", { part: "ear", side: "right" });
room.send("exchangeBodyPart", { part: "lung", side: "left" });
room.send("exchangeBodyPart", { part: "eye", side: "right" });
room.send("exchangeBodyPart", { part: "arm", side: "left" });
room.send("exchangeBodyPart", { part: "heart" });           // sideなし
```
自分の手番かどうかに関わらず、いつでも送信できる(ルール通り)。既に失っている部位・上限に達した部位を
指定した場合や、ノーマルモード中・ゲーム開始前は黙って無視される(現状`actionError`は返さない)。
成功すると対応する`PlayerState`のフィールド(`fingersLostLeft`など)とチップ・ストレス値が更新される。
心臓・両肺喪失は`isDead`、ストレス100到達は`isVegetative`をtrueにし、以降のラウンドから除外される。

## PlayerStateのロストフルモード関連フィールド
```
stress: number                    // 0〜100+。100でisVegetative=true
isDead, isVegetative              // 廃人・死亡(以降のラウンドから除外)
fingersLostLeft, fingersLostRight // 0〜5
teethLost                         // true以降、ストレス上昇が全て2倍になる
earsLostLeft, earsLostRight
lungsLostLeft, lungsLostRight     // 両方trueでisDead=true
eyesLostLeft, eyesLostRight
armsLostLeft, armsLostRight       // どちらかtrueで、そのプレイヤーはcheck/callしか送れない(raise/allin/foldはactionErrorになる。ただしlostinは例外的に送信可能)
heartLost                         // trueでisDead=true
publicCardLeft, publicCardRight   // 指の喪失で公開されたホールカード(""=非公開)。ハンドごとにリセットされる
```
`revealedHoleCards`(ショーダウン時の全公開)とは別物。`publicCardLeft`/`publicCardRight`は
指の喪失によりハンドの途中で公開される分で、他プレイヤーにも同じタイミングで同期される。

### ロストイン(特殊技)
`room.send("action", { type: "lostin" })` の1つのメッセージ型で、**宣言**と**対抗宣言**の両方をまかなう
(`room.state.lostInActive` がfalseなら宣言、trueなら対抗宣言として扱われる)。

**流れ**:
1. 自分の手番で `action:{type:"lostin"}` を送ると宣言になる。この時点ではまだ何も失わない。
   `lostInActive=true`、`lostInDeclarerId`、`lostInAmount`(宣言者の赤札額)がセットされ、
   手番が宣言者の次のプレイヤーに移る
2. `lostInActive`がtrueの間、手番のプレイヤーは以下の3つの`action`のみ有効:
   - `{type:"fold"}`:このロストインを無視してフォールド
   - `{type:"call"}`:赤札額(`lostInAmount`)分を通常チップで支払う → **即座に宣言者のロストインが実行され、ショーダウンに進む**
   - `{type:"lostin"}`:自分も対抗ロストインする(自分の残存部位を換算した独自の赤札額で)→ **宣言者・自分の両方のロストインが即座に実行され、ショーダウンに進む**
3. 手番の全員が`fold`した場合(宣言者以外が全員フォールド):ロストインは不実行のまま終了し、宣言者が通常のポットを獲得する(身体は失わない)
4. コール・対抗ロストインで実行が確定した時点で、まだ応答していない他のプレイヤーは自動的にフォールド扱いになり、残りのコミュニティカードが公開されてショーダウンに進む
5. ロストインを実行したプレイヤー(宣言者・対抗者とも)は、勝敗に関わらず`isDead=true`になる

`actionError`の`reason: "lostin_response_required"`は、`lostInActive`中に上記3種類以外の`action`を送った場合に返る。

## 今後の課題(未着手)
- ジョーカーの有無・枚数設定はサーバー未実装
- ルームコード(roomId)を人に伝える手段(URLシェア・コピー機能など)はUI未実装。今は`roomIdText`に表示するのみ
- チャット機能はサーバー未実装(room-create.htmlのチャットUIは見た目のみ)
