# クライアント連携ガイド(サーバー⇔UI)

実クライアント(`mockups/game.html`、タイトル〜対戦卓が1画面で完結するSPA)を、このサーバー(`PokerRoom`)に
つなぐ際の連携仕様。

## 接続

Colyseus.jsクライアントを使用する想定。`game.html`では画面遷移(ページ遷移)が発生しないため、
ルーム作成・参加時に一度だけ接続すれば、ゲームが終わるまで同じ接続を保持し続ければよい
(以前の複数HTMLファイル構成のような、ページ遷移をまたいだ再接続の仕組みは不要)。

```js
import { Client } from "colyseus.js";

const client = new Client("wss://<サーバーのホスト>");
const room = await client.create("poker", { name: "プレイヤー名", ... }); // GM
// または
const room = await client.joinById(roomId, { name: "プレイヤー名" }); // 参加者
```

- **ルームコードの方式**:参加者が入力するのは**4桁の数字コード**(`RoomState.roomCode`)。Colyseus内部の`roomId`(英数字)とは別物で、サーバー(`PokerRoom.onCreate`)がルーム作成のたびに重複しないよう発行し、`room.setMetadata({ code })`で公開する
- GM(ルーム作成)は `client.create("poker", options)`。参加者はまず `client.getAvailableRooms("poker")` で現在募集中のルーム一覧を取得し、`metadata.code`が入力されたコードと一致するものを探して、その実際の`roomId`で`client.joinById(roomId, { name })`する
- サーバー側(`PokerRoom.onLeave`)は、非明示的な切断(通信の瞬断など)に対して60秒間の再接続猶予を`allowReconnection`で与えるよう実装済み。「退室」「降参」など明示的な離脱時は、先に`leaveIntentional`メッセージを送ってから`room.leave(true)`を呼ぶことで、猶予なしで即座に処理される(詳細は後述の`leaveIntentional`の項)
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
  phase: "waiting"|"preflop"|"flop"|"turn"|"river"|"judge"|"showdown"|"roundEnd"|"gameEnd"
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
  jokerEnabled: boolean            // ジョーカーの有無
  jokerCount: number               // ジョーカーの枚数(jokerEnabled=trueの時のみ意味を持つ)
  lastAggressorId: string
  log: string[]                    // 直近の進行ログ(最大50件)
  gameStarted: boolean
  roomCode: string                 // 参加者が入力する4桁の数字コード
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
ジョーカーは `"JOKER1"`,`"JOKER2"`,... という専用表記(`jokerEnabled`時のみ山札に含まれる)。役判定上は完全ワイルドカードとして
サーバー側で解決済みの結果が返るため、クライアント側でワイルド処理をする必要はない(見た目だけ専用デザインにすればよい)。

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

### `leaveIntentional`
```js
room.send("leaveIntentional");
```
引数なし。「退室」「降参」ボタンなど、本人が明示的に接続を終える直前に送る。これを送ってから`room.leave(true)`
(または降参のように単にページ遷移)すると、サーバー側は再接続を待たず即座に退室処理を行う。
**注意**:`room.leave(consented)`の`consented`フラグは、ブラウザのページ遷移による切断でもtrueとして
届くことがあり信用できなかったため、サーバー側はこのメッセージの有無を正としている(`onLeave`の`consented`引数は
現在参照していない)。これを送らずに切断した場合は、通常のページ遷移とみなされ60秒間の再接続猶予が与えられる。

### `chat`
```js
room.send("chat", { target: "all", text: "こんにちは" });      // 全体チャット
room.send("chat", { target: "<相手のsessionId>", text: "..." }); // 個別チャット
```
`target`省略時は`"all"`(全体)扱い。全体チャットは`broadcast`で全員に届き、個別チャットは送信者と指定した
相手のsessionIdの2人にしか届かない(混沌の「宛先選択・全体は白文字/個別は青文字」の仕組みと同じ)。
テキストは200文字で切り詰められる。存在しないsessionIdを指定した場合は無視される。

サーバーからの配信メッセージ(`room.onMessage("chat", ...)`で受け取る)の形:
```js
{
  fromId: "...",       // 送信者のsessionId
  fromName: "...",     // 送信者の表示名
  text: "...",
  isPrivate: false,    // true=個別チャット
  toId: "...",         // 個別チャットの場合のみ:宛先のsessionId
  toName: "...",       // 個別チャットの場合のみ:宛先の表示名
}
```

### `updateSettings`(GMのみ有効、ゲーム開始前のみ)
```js
room.send("updateSettings", {
  mode: "normal", // "normal" | "lostfull"
  startingChips: 1000,
  maxRounds: 10,
  bigBlind: 40, // smallBlind/minRaiseUnitはサーバー側で自動的に半額に再計算される
});
```
全てのキーが任意(渡さなかった項目は変更されない)。

## 実クライアント実装済みの範囲(mockups/)
`mockups/index.html` は、タイトル〜ルーム作成/参加〜対戦卓までが1つのHTMLファイル内で画面切り替え(ページ遷移なし)
する構成になっており、このサーバーに実接続するよう実装済み。
- **サーバーURLの設定**:`index.html` 冒頭の `SERVER_URL` を、実際にデプロイしたサーバーの
  WebSocket URL(例: `wss://your-app.onrender.com`)に書き換える必要がある
- ルームコードは4桁の数字(`RoomState.roomCode`)。前述の通り、実際のjoinには内部の`roomId`を使う
- ページ遷移が発生しないため、接続は一度確立したらゲームが終わるまでそのまま保持される
  (以前の複数ページ構成で問題になっていた「ページ遷移のたびの再接続」は発生しない)

### `exchangeBodyPart`(ロストフルモードのみ、いつでも送信可能)
```js
room.send("exchangeBodyPart", { part: "finger", side: "left" });
room.send("exchangeBodyPart", { part: "tooth" });          // sideなし
room.send("exchangeBodyPart", { part: "ear" });                // 耳は左右同時に1回(sideなし。earsLostLeft/Rightが同時にtrue)
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
2. `lostInActive`がtrueの間、手番のプレイヤーは以下の4つの`action`のみ有効:
   - `{type:"fold"}`:このロストインを無視してフォールド
   - `{type:"call"}`:赤札額(`lostInAmount`)分を通常チップで支払う → **即座に宣言者のロストインが実行され、ショーダウンに進む**
   - `{type:"allin"}`:手持ちを全て賭けて応答(`call`と同様に即座に宣言者のロストインが実行される)
   - `{type:"lostin"}`:自分も対抗ロストインする(自分の残存部位を換算した独自の赤札額で)→ **宣言者・自分の両方のロストインが即座に実行され、ショーダウンに進む**
3. 手番の全員が`fold`した場合(宣言者以外が全員フォールド):ロストインは不実行のまま終了し、宣言者が通常のポットを獲得する(身体は失わない)
4. コール・対抗ロストインで実行が確定した時点で、まだ応答していない他のプレイヤーは自動的にフォールド扱いになり、残りのコミュニティカードが公開されてショーダウンに進む
5. ロストインを実行したプレイヤー(宣言者・対抗者とも)は、勝敗に関わらず`isDead=true`になる

`actionError`の`reason: "lostin_response_required"`は、`lostInActive`中に上記4種類(fold/call/lostin/allin)以外の`action`を送った場合に返る。

## 今後の課題(未着手)
- ルームコード(4桁)を人に伝える手段(コピー機能など)はUI未実装。今は画面に表示するのみ
- チャット機能はサーバー未実装(ルームロビー画面のチャットUIは見た目のみ)


## ミニゲーム:インディアンジャッジ(ロビー専用)
- state: `ij { phase: idle|recruiting|playing|result, bet, participants[], step: pick|reveal, fieldNum(結果公開まで0), roundId, pickedIds[], winners[], winnerGain, turnLeft }`
- client→server: `ijOpen {bet}`(GM。1〜BB)/ `ijSetBet {bet}`(GM、募集中のみ)/ `ijJoin`(参加・辞退のトグル)/ `ijBegin`(GM、2人以上)/ `ijPick {pick:"high"|"low"}`(25秒以内に何度でも変更可)/ `ijInfoReq`(自分の公開情報の再送要求)/ `ijClose`(GM。中止・結果画面を閉じる)
- server→client: `ijInfo {seen:[{who:playerId|"grave", num}], total}`(本人にだけ)/ `ijReveal {field, nums{id:number}, picks{id:high|low}, grave[], winners[]}`
- ルール: 数字カードは1〜(人数+2)。場1枚・各プレイヤー1枚(自分のは見えない)・墓地1枚。各プレイヤーには「他プレイヤー+墓地」のうち半数(切り捨て)がランダムに公開される。自分の数字が場より大きいか小さいかを予想し、的中者全員で掛け金を山分け(全員外れなら増減なし)。掛け金は次のゲームの初期チップから(`chipDelta`)。

## 観戦者
- ゲーム開始後に入室した人は `players[id].isSpectator = true`(座席なし・手番なし・チップ0)。ニューゲーム/ロビー復帰時に空き席があれば通常プレイヤーに昇格。
- 設定 `spectatorSeeHands`(GM、デフォルトfalse)がtrueのとき、観戦者に `spectatorHands { hands: {playerId: [card, card]} }` が各ラウンド開始時と入室時に送られる。


## 終了時の順位
- `state.endReason`: `"rounds"`(ラウンド切れ)/ `"survivor"`(生存者1人以下)。ゲーム終了(`phase==="gameEnd"`)で設定される。
- `rounds`: 死亡・廃人のスコア=チップ×0.7。それ以外はチップそのまま。スコア降順で順位。
- `survivor`: 死亡・廃人は全員敗北(それ以外の人より下)。降参者は常に最下位。

## ロストフル 部位価格(最新)
| 部位 | チップ | ストレス |
|---|---|---|
| 指(1本) | 20 | 3 |
| 歯 | 200 | 10 |
| 耳(左右同時1回) | 140 | 20 |
| 肺(片方) | 150 | 25 |
| 目(片方) | 250 | 15 |
| 腕(片方) | 150 | 20(同側の指5本も連鎖喪失・連鎖分は加算なし) |
| 心臓 | 400 | なし(即死) |

- ロストインの赤札=残存部位の合計(**心臓も含む**)。実行時は心臓も失う(`heartLost=true, isDead=true`)。
- 腕喪失中でも、レイズにならない`allin`(手持ち全額でも現在のベットに届かない場合、ロストイン応答時は手持ち≦赤札額の場合)は可能。ロストインへの応答では`allin`(手持ちを全て賭ける)も有効。

## カードの落下(指の欠損)
- server→client(全員にbroadcast): `cardDrop { playerId, side:"left"|"right", card, ms }`(ms=見えている時間。3500)
- 落下中は`players[id].publicCardLeft/Right`にカードが入り、`ms`後に空に戻る。指4〜5本欠損の側は空に戻らず常時公開。
- 確率: 1本5% / 2本15% / 3本30%(4本以上は常時公開。行動のたびに判定。落下中は再判定しない)。

## 切断・復帰
- `PlayerState.connected=false` の間、`disconnectLeft` に復帰猶予の残り秒数(初期30)が毎秒更新される。
- 猶予切れでゲーム中なら `isSurrendered=true`(強制敗北)。環境変数 `DC_GRACE` で猶予秒数を変更可(テスト用)。
