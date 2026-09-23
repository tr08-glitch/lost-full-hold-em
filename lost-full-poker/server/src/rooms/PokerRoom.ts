import { Room, Client } from "colyseus";
import { RoomState } from "../schema/RoomState";
import { PlayerState } from "../schema/PlayerState";
import { Deck } from "../logic/deck";
import { determineWinners, evaluateHand } from "../logic/handEvaluator";
import { calculatePots, splitPot, PotContribution } from "../logic/potManager";

interface RoomOptions {
  maxRounds?: number;
  bigBlind?: number;
  startingChips?: number;
  mode?: "normal" | "lostfull";
}

type ActionMessage =
  | { type: "check" }
  | { type: "call" }
  | { type: "raise"; amount: number }
  | { type: "allin" }
  | { type: "fold" }
  | { type: "lostin" }; // ロストフルモード限定。宣言 or (宣言中の)対抗レイズどちらも同じtype

/**
 * ロストフルホールデム対戦ルーム(ノーマルモード)。
 * ロストフルモード固有の要素(身体パーツ換金・ストレス・ロストイン)は次段階で追加する。
 */
export class PokerRoom extends Room<RoomState> {
  maxClients = 6;

  private deck = new Deck();
  // ホールカードの中身はスキーマに乗せず、サーバー内部だけで保持する(本人にのみ個別送信)
  private holeCards: Map<string, string[]> = new Map();
  // 最小レイズ未満のショートオールインが発生した際、レイズが打ち返せないプレイヤーの集合。
  // 正規サイズのレイズが行われる、または新しいストリートが始まるとクリアされる。
  private raiseRestricted: Set<string> = new Set();
  // 現在の手番プレイヤーの行動タイムアウト(30秒操作がなければ自動フォールド)
  private actionTimeout: { clear: () => void } | null = null;
  private static readonly ACTION_TIMEOUT_MS = 30_000;
  // このハンドの開始時点で配札されたプレイヤーのidスナップショット(座席順)。
  // ハンド途中で降参・死亡(isSurrendered/isDead/isVegetative)になっても、
  // そのハンドのポット計算・進行では引き続きこのリストを使う(activeSeatOrderは
  // 「次のハンドに参加できるか」を表すため、ハンド中に変化すると投入済みチップの
  // 集計から抜け落ちてしまう)。
  private handParticipants: string[] = [];

  onCreate(options: RoomOptions) {
    this.setState(new RoomState());

    this.state.maxRounds = options.maxRounds ?? 10;
    this.state.bigBlind = options.bigBlind ?? 40;
    this.state.smallBlind = Math.floor(this.state.bigBlind / 2);
    this.state.minRaiseUnit = this.state.smallBlind;
    this.state.startingChips = options.startingChips ?? 1000;
    this.state.mode = options.mode ?? "normal";

    this.onMessage("startGame", (client) => this.handleStartGame(client));
    this.onMessage("action", (client, message: ActionMessage) =>
      this.handleAction(client, message)
    );
    this.onMessage("updateSettings", (client, message) => this.handleUpdateSettings(client, message));
    this.onMessage("surrender", (client) => this.handleSurrender(client));
    this.onMessage("exchangeBodyPart", (client, message) => this.handleExchangeBodyPart(client, message));
  }

  onJoin(client: Client, options: { name?: string }) {
    if (this.state.gameStarted) {
      // ゲーム開始後の途中参加は現段階では未対応(observerとしての入室などは今後の課題)
      throw new Error("既にゲームが開始されているため参加できません");
    }

    const player = new PlayerState();
    player.id = client.sessionId;
    player.name = (options?.name || "プレイヤー").slice(0, 10);
    player.chips = this.state.startingChips;
    player.seatIndex = this.state.players.size;
    player.isGM = this.state.players.size === 0; // 最初の入室者がGM(部屋作成者)

    this.state.players.set(client.sessionId, player);
    this.state.seatOrder.push(client.sessionId);

    this.pushLog(`${player.name} が入室しました`);
  }

  async onLeave(client: Client, consented: boolean) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    player.connected = false;

    if (consented) {
      // 「退室」ボタンなど、明示的な離脱
      this.handlePlayerGoneForGood(client.sessionId);
      return;
    }

    // ページ遷移(title→room-create→table など)や瞬断はここに入る。
    // 60秒間は同じセッションでの再接続(client.reconnect)を受け付け、
    // 別プレイヤー扱いにならないようにする。
    try {
      await this.allowReconnection(client, 60);
      player.connected = true; // 再接続成功
      this.pushLog(`${player.name}が再接続しました`);
    } catch (e) {
      // 60秒以内に再接続されなかった → 本当に退室したとみなす
      this.handlePlayerGoneForGood(client.sessionId);
    }
  }

  /** 再接続の見込みがなくなった(退室 or タイムアウト)プレイヤーの後処理 */
  private handlePlayerGoneForGood(sessionId: string) {
    const player = this.state.players.get(sessionId);
    if (!player) return;

    if (!this.state.gameStarted) {
      // ロビー中の離脱はそのまま座席から取り除く
      this.state.players.delete(sessionId);
      const idx = this.state.seatOrder.indexOf(sessionId);
      if (idx !== -1) this.state.seatOrder.splice(idx, 1);
      this.pushLog(`${player.name}が退室しました`);
      return;
    }

    if (!player.folded && !player.isDead && !player.isVegetative) {
      player.folded = true;
      player.lastAction = "fold";
      this.pushLog(`${player.name}が退室したためフォールドしました`);
      this.progressGame();
    }
  }

  private pushLog(message: string) {
    this.state.log.push(message);
    while (this.state.log.length > 50) this.state.log.shift();
  }

  private syncDeckCounts() {
    this.state.deckRemaining = this.deck.remaining;
    this.state.discardCount = this.deck.discarded;
  }

  private sendToPlayer(playerId: string, type: string, payload: unknown) {
    const client = this.clients.find((c) => c.sessionId === playerId);
    client?.send(type, payload);
  }

  /** 手番プレイヤーを設定し、30秒の行動タイムアウトを仕掛け直す */
  private setActionPlayer(playerId: string) {
    this.actionTimeout?.clear();
    this.state.actionPlayerId = playerId;
    this.actionTimeout = this.clock.setTimeout(
      () => this.autoFoldOnTimeout(playerId),
      PokerRoom.ACTION_TIMEOUT_MS
    );
  }

  /** タイムアウト発火時、まだ本当にそのプレイヤーの手番であればフォールドさせる */
  private autoFoldOnTimeout(playerId: string) {
    if (this.state.actionPlayerId !== playerId) return; // 既に状況が進んでいれば何もしない
    if (!["preflop", "flop", "turn", "river"].includes(this.state.phase)) return;

    const player = this.state.players.get(playerId);
    if (!player || player.folded || player.allIn) return;

    player.folded = true;
    player.hasActed = true;
    player.lastAction = "fold";
    this.pushLog(`${player.name}が時間切れのため自動フォールドしました`);
    this.progressGame();
  }

  // ---------- 座席・順序ヘルパー ----------

  /** 脱落(死亡/廃人/バスト)していないプレイヤーの座席順。 */
  private activeSeatOrder(): string[] {
    return this.state.seatOrder.filter((id) => {
      const p = this.state.players.get(id);
      return p && !p.isDead && !p.isVegetative && !p.isBusted && !p.isSurrendered;
    });
  }

  private nextActiveDealerIndex(fromIndex: number): number {
    const n = this.state.seatOrder.length;
    let idx = fromIndex;
    for (let i = 0; i < n; i++) {
      idx = (idx + 1) % n;
      const id = this.state.seatOrder[idx]!;
      const p = this.state.players.get(id);
      if (p && !p.isDead && !p.isVegetative && !p.isBusted && !p.isSurrendered) return idx;
    }
    return fromIndex;
  }

  /** チップが0になったプレイヤーを「バスト」として以降のラウンドの進行から除外する */
  private markBustedPlayers() {
    for (const id of this.state.seatOrder) {
      const p = this.state.players.get(id);
      if (p && !p.isDead && !p.isVegetative && !p.isBusted && !p.isSurrendered && p.chips <= 0) {
        p.isBusted = true;
        this.pushLog(`${p.name}はチップが尽きたため、以降のラウンドから除外されます`);
      }
    }
  }

  // ---------- ゲーム開始 ----------

  private handleStartGame(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (!player?.isGM) return; // GM(ルーム作成者)のみ開始可能
    if (this.state.gameStarted) return;
    if (this.state.players.size < 2) return;

    this.state.gameStarted = true;
    this.state.roundNumber = 0;
    this.state.dealerSeatIndex = Math.floor(Math.random() * this.state.seatOrder.length);
    this.lock(); // 開始後の新規入室を禁止

    this.startNewRound();
  }

  /** GMがルーム設定モーダルで「確定」した内容をルームに反映する(ゲーム開始前のみ有効) */
  private handleUpdateSettings(
    client: Client,
    message: Partial<{
      mode: "normal" | "lostfull";
      startingChips: number;
      maxRounds: number;
      bigBlind: number;
    }>
  ) {
    const player = this.state.players.get(client.sessionId);
    if (!player?.isGM) return; // GMのみ変更可能
    if (this.state.gameStarted) return; // 開始後は変更不可

    if (message.mode === "normal" || message.mode === "lostfull") {
      this.state.mode = message.mode;
    }
    if (typeof message.maxRounds === "number" && message.maxRounds > 0) {
      this.state.maxRounds = Math.floor(message.maxRounds);
    }
    if (typeof message.bigBlind === "number" && message.bigBlind > 0) {
      this.state.bigBlind = Math.floor(message.bigBlind);
      this.state.smallBlind = Math.floor(this.state.bigBlind / 2);
      this.state.minRaiseUnit = this.state.smallBlind;
    }
    if (typeof message.startingChips === "number" && message.startingChips > 0) {
      this.state.startingChips = Math.floor(message.startingChips);
      // まだ開始前なので、既に入室済みのプレイヤーのチップも新しい初期値に揃える
      for (const p of this.state.players.values()) {
        p.chips = this.state.startingChips;
      }
    }

    this.pushLog("ゲーム設定が更新されました");
  }

  private endGame() {
    this.state.phase = "gameEnd";
    this.state.gameStarted = false;

    let winner: PlayerState | null = null;
    for (const id of this.state.seatOrder) {
      const p = this.state.players.get(id);
      if (!p) continue;
      if (!winner || p.chips > winner.chips) winner = p;
    }
    if (winner) {
      this.pushLog(`--- 全${this.state.maxRounds}ラウンド終了。優勝: ${winner.name}(${winner.chips}チップ) ---`);
    }
  }

  // ---------- ラウンド開始 ----------

  private startNewRound() {
    this.markBustedPlayers();
    const order = this.activeSeatOrder();
    this.handParticipants = order; // このハンドの参加者を確定・スナップショット
    if (order.length < 2) {
      this.endGame();
      return;
    }

    this.state.roundNumber++;
    if (this.state.roundNumber > this.state.maxRounds) {
      this.endGame();
      return;
    }

    this.deck.reset();
    this.syncDeckCounts();
    this.holeCards.clear();
    this.state.communityCards.clear();
    this.state.pot = 0;
    this.state.sidePots.clear();
    this.state.currentBet = 0;
    this.state.lastAggressorId = "";
    this.raiseRestricted.clear();

    for (const id of this.state.seatOrder) {
      const p = this.state.players.get(id);
      if (!p) continue;
      p.currentBet = 0;
      p.totalRoundBet = 0;
      p.folded = p.isDead || p.isVegetative || p.isBusted || p.isSurrendered;
      p.allIn = false;
      p.hasActed = false;
      p.holeCardCount = 0;
      p.revealedHoleCards.clear();
      p.isBTN = false;
      p.isSB = false;
      p.isBB = false;
      p.positionLabel = "";
      p.lastAction = "";
      // 指の喪失による公開カードは毎ハンドリセット(4〜5本喪失で常時公開の場合は配札後すぐに再セットされる)
      p.publicCardLeft = "";
      p.publicCardRight = "";
    }

    // BTN移動(2ラウンド目以降。初回はhandleStartGameでランダム決定済み)
    if (this.state.roundNumber > 1) {
      this.state.dealerSeatIndex = this.nextActiveDealerIndex(this.state.dealerSeatIndex);
    } else if (!order.includes(this.state.seatOrder[this.state.dealerSeatIndex]!)) {
      this.state.dealerSeatIndex = this.nextActiveDealerIndex(this.state.dealerSeatIndex);
    }

    const btnId = this.state.seatOrder[this.state.dealerSeatIndex]!;
    this.state.players.get(btnId)!.isBTN = true;
    this.assignPositionLabels(order, btnId);

    // ホールカード配布(本人にのみ個別送信、スキーマには枚数のみ反映)
    for (const id of order) {
      const cards = this.deck.draw(2);
      this.syncDeckCounts();
      this.holeCards.set(id, cards);
      const p = this.state.players.get(id)!;
      p.holeCardCount = 2;
      this.sendToPlayer(id, "yourHoleCards", { cards });
      // 指が4〜5本無い側は、配札直後から常時カードが公開された状態になる
      if (p.fingersLostLeft >= 4) p.publicCardLeft = cards[0];
      if (p.fingersLostRight >= 4) p.publicCardRight = cards[1];
    }

    // ブラインド決定
    let sbId: string;
    let bbId: string;
    if (order.length === 2) {
      // ヘッズアップ特例: BTN = SB
      sbId = btnId;
      bbId = order[(order.indexOf(btnId) + 1) % order.length]!;
    } else {
      sbId = order[(order.indexOf(btnId) + 1) % order.length]!;
      bbId = order[(order.indexOf(btnId) + 2) % order.length]!;
    }
    this.state.players.get(sbId)!.isSB = true;
    this.state.players.get(bbId)!.isBB = true;

    this.postBlind(sbId, this.state.smallBlind);
    this.postBlind(bbId, this.state.bigBlind);
    this.state.currentBet = this.state.bigBlind;

    this.pushLog(`--- ラウンド${this.state.roundNumber}開始(BTN: ${this.state.players.get(btnId)!.name}) ---`);
    this.state.phase = "preflop";

    // プリフロップの初手番: ヘッズアップはSB(=BTN)、それ以外はBBの次(UTG)
    if (order.length === 2) {
      this.setActionPlayer(sbId);
    } else {
      const startIdx = (order.indexOf(bbId) + 1) % order.length;
      this.setActionPlayer(order[startIdx]!);
    }
  }

  /**
   * 人数に応じたポジション名をBTNを起点に時計回りで割り当てる。
   * 2人:BTN/SB(兼任),BB / 3人:BTN,SB,BB / 4人:+UTG / 5人:+CO / 6人:+HJ
   */
  private assignPositionLabels(order: string[], btnId: string) {
    const n = order.length;
    const labelsFromBTN: Record<number, string[]> = {
      2: ["BTN/SB", "BB"],
      3: ["BTN", "SB", "BB"],
      4: ["BTN", "SB", "BB", "UTG"],
      5: ["BTN", "SB", "BB", "UTG", "CO"],
      6: ["BTN", "SB", "BB", "UTG", "HJ", "CO"],
    };
    const labels = labelsFromBTN[n] || [];
    const btnIdx = order.indexOf(btnId);
    for (let i = 0; i < n; i++) {
      const id = order[(btnIdx + i) % n];
      const p = this.state.players.get(id)!;
      p.positionLabel = labels[i] || "";
    }
  }

  /** 「降参」ボタン:以降のラウンドから除外される(廃人・死亡・バストと同様の観戦扱い) */
  private handleSurrender(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    if (player.isDead || player.isVegetative || player.isBusted || player.isSurrendered) return;

    if (!this.state.gameStarted) {
      // ロビー中の降参は退室と同義に扱う
      this.handlePlayerGoneForGood(client.sessionId);
      return;
    }

    player.isSurrendered = true;
    this.pushLog(`${player.name}が降参しました`);

    if (!player.folded) {
      player.folded = true;
      player.hasActed = true;
      player.lastAction = "fold";
      this.progressGame();
    }
  }

  // ---------- ロストフルモード:身体パーツ換金 ----------

  /**
   * 指の喪失本数に応じた確率でホールカードを公開する(1〜3本:確率判定、4〜5本:確定済みなのでここでは何もしない)。
   * 「アクションを選択する瞬間」に毎回判定し、既に公開済みの側は再判定しない。
   */
  private checkFingerReveal(player: PlayerState) {
    const holeCards = this.holeCards.get(player.id);
    if (!holeCards) return;
    const probByCount: Record<number, number> = { 1: 0.05, 2: 0.15, 3: 0.3 };

    if (!player.publicCardLeft && player.fingersLostLeft >= 1 && player.fingersLostLeft <= 3) {
      if (Math.random() < probByCount[player.fingersLostLeft]) {
        player.publicCardLeft = holeCards[0];
        this.pushLog(`${player.name}の指の震えでカードが見えてしまった(左)`);
      }
    }
    if (!player.publicCardRight && player.fingersLostRight >= 1 && player.fingersLostRight <= 3) {
      if (Math.random() < probByCount[player.fingersLostRight]) {
        player.publicCardRight = holeCards[1];
        this.pushLog(`${player.name}の指の震えでカードが見えてしまった(右)`);
      }
    }
  }

  /** 指が4〜5本無い側は、確率判定なしで常にホールカードが公開される(このハンドに手札が配られている場合のみ即時反映) */
  private applyForcedFingerReveal(player: PlayerState, side: "left" | "right") {
    const lostCount = side === "left" ? player.fingersLostLeft : player.fingersLostRight;
    if (lostCount < 4) return;
    const holeCards = this.holeCards.get(player.id);
    if (!holeCards) return; // ハンドの合間(配札前)なら、次回配札時にstartNewRound側で反映する
    if (side === "left" && !player.publicCardLeft) player.publicCardLeft = holeCards[0];
    if (side === "right" && !player.publicCardRight) player.publicCardRight = holeCards[1];
  }

  /** 身体パーツ換金(チップの有無・自分の手番に関わらず、いつでも実行可能) */
  private handleExchangeBodyPart(client: Client, message: { part?: string; side?: "left" | "right" }) {
    if (this.state.mode !== "lostfull") return;
    if (!this.state.gameStarted) return;

    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    if (player.isDead || player.isVegetative || player.isBusted || player.isSurrendered) return;

    const part = message.part;
    const side = message.side;
    // 歯を既に失っている場合、"今回の"換金によるストレス上昇も2倍になる。
    // (歯そのものを失う換金は、まだ歯を失っていない時点の判定=等倍になる)
    const preMultiplier = player.teethLost ? 2 : 1;

    let chipGain = 0;
    let stressGain = 0;
    let causesDeath = false;
    let label = "";

    switch (part) {
      case "finger": {
        if (side !== "left" && side !== "right") return;
        const current = side === "left" ? player.fingersLostLeft : player.fingersLostRight;
        if (current >= 5) return;
        if (side === "left") player.fingersLostLeft++;
        else player.fingersLostRight++;
        chipGain = 30;
        stressGain = 3;
        label = `指(${side === "left" ? "左" : "右"})`;
        this.applyForcedFingerReveal(player, side);
        break;
      }
      case "tooth": {
        if (player.teethLost) return;
        player.teethLost = true;
        chipGain = 200;
        stressGain = 10;
        label = "歯";
        break;
      }
      case "ear": {
        if (side !== "left" && side !== "right") return;
        if (side === "left") {
          if (player.earsLostLeft) return;
          player.earsLostLeft = true;
        } else {
          if (player.earsLostRight) return;
          player.earsLostRight = true;
        }
        chipGain = 70;
        stressGain = 10;
        label = `耳(${side === "left" ? "左" : "右"})`;
        break;
      }
      case "lung": {
        if (side !== "left" && side !== "right") return;
        if (side === "left") {
          if (player.lungsLostLeft) return;
          player.lungsLostLeft = true;
        } else {
          if (player.lungsLostRight) return;
          player.lungsLostRight = true;
        }
        chipGain = 150;
        stressGain = 25;
        label = `肺(${side === "left" ? "左" : "右"})`;
        if (player.lungsLostLeft && player.lungsLostRight) causesDeath = true;
        break;
      }
      case "eye": {
        if (side !== "left" && side !== "right") return;
        if (side === "left") {
          if (player.eyesLostLeft) return;
          player.eyesLostLeft = true;
        } else {
          if (player.eyesLostRight) return;
          player.eyesLostRight = true;
        }
        chipGain = 250;
        stressGain = 15;
        label = `目(${side === "left" ? "左" : "右"})`;
        break;
      }
      case "arm": {
        if (side !== "left" && side !== "right") return;
        if (side === "left") {
          if (player.armsLostLeft) return;
          player.armsLostLeft = true;
        } else {
          if (player.armsLostRight) return;
          player.armsLostRight = true;
        }
        chipGain = 250;
        stressGain = 20;
        label = `腕(${side === "left" ? "左" : "右"})`;
        // 連鎖:その腕の指5本も同時に喪失(連鎖分のチップ・ストレスは加算しない)
        if (side === "left") player.fingersLostLeft = 5;
        else player.fingersLostRight = 5;
        this.applyForcedFingerReveal(player, side);
        break;
      }
      case "heart": {
        if (player.heartLost) return;
        player.heartLost = true;
        chipGain = 750;
        stressGain = 0; // 心臓はストレス対象外
        label = "心臓";
        causesDeath = true;
        break;
      }
      default:
        return;
    }

    player.chips += chipGain;
    if (stressGain > 0) {
      player.stress += stressGain * preMultiplier;
    }

    const newlyVegetative = !player.isVegetative && player.stress >= 100;
    if (newlyVegetative) player.isVegetative = true;
    if (causesDeath) player.isDead = true;

    this.pushLog(`${player.name}が${label}を換金した(+${chipGain}チップ)`);
    if (causesDeath) this.pushLog(`${player.name}は死亡した`);
    if (newlyVegetative) this.pushLog(`${player.name}は廃人となった`);

    if ((causesDeath || newlyVegetative) && this.state.gameStarted && !player.folded) {
      player.folded = true;
      player.hasActed = true;
      player.lastAction = "fold";
      this.progressGame();
    }
  }

  // ---------- ロストフルモード:ロストイン(特殊技) ----------

  /** 残存する換金可能部位(心臓除く)の合計チップ換算額=「赤札」を計算する */
  private calculateRedCardAmount(player: PlayerState): number {
    let total = 0;
    total += (5 - player.fingersLostLeft) * 30 + (5 - player.fingersLostRight) * 30;
    if (!player.teethLost) total += 200;
    if (!player.earsLostLeft) total += 70;
    if (!player.earsLostRight) total += 70;
    if (!player.lungsLostLeft) total += 150;
    if (!player.lungsLostRight) total += 150;
    if (!player.eyesLostLeft) total += 250;
    if (!player.eyesLostRight) total += 250;
    if (!player.armsLostLeft) total += 250;
    if (!player.armsLostRight) total += 250;
    return total;
  }

  /**
   * ロストインを実行する(部位を全て失わせ、赤札額をポットに投入)。
   * 宣言者・対抗者どちらも同じ処理。勝敗に関わらず死亡する。
   */
  private executeLostIn(player: PlayerState, amount: number) {
    player.fingersLostLeft = 5;
    player.fingersLostRight = 5;
    player.teethLost = true;
    player.earsLostLeft = true;
    player.earsLostRight = true;
    player.lungsLostLeft = true;
    player.lungsLostRight = true;
    player.eyesLostLeft = true;
    player.eyesLostRight = true;
    player.armsLostLeft = true;
    player.armsLostRight = true;
    player.isDead = true; // ロストイン実行者は勝敗に関わらず死亡

    player.totalRoundBet += amount;
    player.allIn = true;
    this.state.pot += amount;

    this.pushLog(`${player.name}がロストイン実行(${amount}チップ相当・死亡)`);
  }

  /** ロストイン宣言(赤札の提示のみ。この時点ではまだ何も失わない) */
  private declareLostIn(player: PlayerState) {
    const amount = this.calculateRedCardAmount(player);
    this.state.lostInActive = true;
    this.state.lostInDeclarerId = player.id;
    this.state.lostInAmount = amount;
    player.hasActed = true;
    player.lastAction = "lostin";

    this.pushLog(`${player.name}がロストインを宣言!(赤札: ${amount})`);

    const next = this.findNextLostInResponder(player.id);
    if (next) {
      this.setActionPlayer(next);
    } else {
      // 応答できるプレイヤーが誰もいない(全員フォールド/オールイン済み) → 不実行のまま通常進行に戻す
      this.state.lostInActive = false;
      this.progressGame();
    }
  }

  /** ロストイン宣言者の次から、まだ応答していない(フォールドもオールインもしていない)プレイヤーを探す */
  private findNextLostInResponder(fromId: string): string | null {
    const order = this.handParticipants;
    const startIdx = order.indexOf(fromId);
    for (let i = 1; i <= order.length; i++) {
      const id = order[(startIdx + i) % order.length]!;
      if (id === fromId) continue;
      const p = this.state.players.get(id)!;
      if (!p.folded && !p.allIn) return id;
    }
    return null;
  }

  /** ロストイン宣言に対する応答(フォールド/コール/対抗ロストイン)を処理する */
  private handleLostInResponse(client: Client, player: PlayerState, message: ActionMessage) {
    if (message.type !== "fold" && message.type !== "call" && message.type !== "lostin") {
      this.sendToPlayer(client.sessionId, "actionError", { reason: "lostin_response_required" });
      return;
    }

    const declarer = this.state.players.get(this.state.lostInDeclarerId);
    if (!declarer) {
      // 万一宣言者が既にいない場合は安全側に倒して応答フローを終了する
      this.state.lostInActive = false;
      this.progressGame();
      return;
    }

    if (message.type === "fold") {
      player.folded = true;
      player.hasActed = true;
      player.lastAction = "fold";
      this.pushLog(`${player.name}がロストインへの応答でフォールド`);

      const remaining = this.handParticipants.filter((id) => !this.state.players.get(id)!.folded);
      if (remaining.length === 1) {
        // 全員フォールド → ロストインは不実行。身体は失わず、通常ポットのみ宣言者が回収
        this.state.lostInActive = false;
        this.pushLog(`ロストインは不実行のまま終了(${declarer.name}がポットを獲得)`);
        this.progressGame();
        return;
      }

      const next = this.findNextLostInResponder(this.state.lostInDeclarerId);
      if (next) {
        this.setActionPlayer(next);
      } else {
        this.state.lostInActive = false;
        this.progressGame();
      }
      return;
    }

    if (message.type === "call") {
      const payAmount = Math.min(this.state.lostInAmount, player.chips);
      player.chips -= payAmount;
      player.totalRoundBet += payAmount;
      this.state.pot += payAmount;
      if (player.chips === 0) player.allIn = true;
      player.hasActed = true;
      player.lastAction = "call";
      this.pushLog(`${player.name}が赤札分をコール(${payAmount}チップ)`);

      this.executeLostIn(declarer, this.state.lostInAmount);
      this.resolveLostInExecution();
      return;
    }

    // message.type === "lostin"(対抗ロストイン)
    const counterAmount = this.calculateRedCardAmount(player);
    this.executeLostIn(declarer, this.state.lostInAmount);
    this.executeLostIn(player, counterAmount);
    this.pushLog(`${player.name}が対抗ロストイン!(赤札: ${counterAmount})`);
    this.resolveLostInExecution();
  }

  /** ロストイン実行確定後:まだ応答していないプレイヤーは自動的にフォールド扱いにし、残りのストリートを一気に公開してショーダウンへ */
  private resolveLostInExecution() {
    this.state.lostInActive = false;

    for (const id of this.handParticipants) {
      const p = this.state.players.get(id)!;
      if (!p.folded && !p.allIn) {
        p.folded = true;
        p.hasActed = true;
        p.lastAction = "fold";
      }
    }

    const remaining = this.handParticipants.filter((id) => !this.state.players.get(id)!.folded);
    if (remaining.length === 1) {
      this.awardPotToSingleWinner(remaining[0]!);
      return;
    }
    this.autoRunToShowdown();
  }

  private postBlind(playerId: string, amount: number) {
    const p = this.state.players.get(playerId)!;
    const actual = Math.min(amount, p.chips);
    p.chips -= actual;
    p.currentBet = actual;
    p.totalRoundBet = actual;
    if (p.chips === 0) p.allIn = true;
    this.state.pot += actual;
  }

  // ---------- アクション処理 ----------

  private handleAction(client: Client, message: ActionMessage) {
    if (this.state.actionPlayerId !== client.sessionId) {
      this.sendToPlayer(client.sessionId, "actionError", { reason: "not_your_turn" });
      return;
    }
    if (!["preflop", "flop", "turn", "river"].includes(this.state.phase)) {
      this.sendToPlayer(client.sessionId, "actionError", { reason: "not_betting_phase" });
      return;
    }

    const player = this.state.players.get(client.sessionId);
    if (!player || player.folded || player.allIn) {
      this.sendToPlayer(client.sessionId, "actionError", { reason: "cannot_act" });
      return;
    }

    // ロストフルモード:指の喪失によるホールカード公開判定(アクションを選択する瞬間に判定)
    if (this.state.mode === "lostfull") {
      this.checkFingerReveal(player);
    }

    // ロストフルモード:腕を失っている場合、チェック/コール以外は選択不可
    // (ただしロストインの宣言・対抗ロストインは例外的に可能。捨て身の特攻なので腕の制約を受けない)
    const armRestricted = player.armsLostLeft || player.armsLostRight;
    if (
      armRestricted &&
      (message.type === "raise" || message.type === "allin" || message.type === "fold")
    ) {
      this.sendToPlayer(client.sessionId, "actionError", { reason: "arm_restricted" });
      return;
    }

    // ロストイン応答中(宣言に対して他プレイヤーが応答している最中)は専用の処理に分岐する
    if (this.state.mode === "lostfull" && this.state.lostInActive) {
      this.handleLostInResponse(client, player, message);
      return;
    }

    switch (message.type) {
      case "lostin": {
        if (this.state.mode !== "lostfull") {
          this.sendToPlayer(client.sessionId, "actionError", { reason: "unknown_action_type" });
          return;
        }
        this.declareLostIn(player);
        return; // 通常のprogressGame()は使わず、応答フローを専用に開始する
      }
      case "check": {
        if (player.currentBet !== this.state.currentBet) {
          this.sendToPlayer(client.sessionId, "actionError", { reason: "check_not_allowed" });
          return; // コール額が残っているならチェック不可
        }
        player.lastAction = "check";
        player.hasActed = true;
        this.pushLog(`${player.name} チェック`);
        break;
      }
      case "call": {
        const toCall = this.state.currentBet - player.currentBet;
        if (toCall <= 0) {
          this.sendToPlayer(client.sessionId, "actionError", { reason: "call_not_allowed" });
          return;
        }
        const payAmount = Math.min(toCall, player.chips);
        player.chips -= payAmount;
        player.currentBet += payAmount;
        player.totalRoundBet += payAmount;
        this.state.pot += payAmount;
        if (player.chips === 0) player.allIn = true;
        player.hasActed = true;
        player.lastAction = player.allIn ? "allin" : "call";
        this.pushLog(`${player.name}が${player.allIn ? "オールイン(コール)" : "コール"}`);
        break;
      }
      case "raise": {
        const raiseTo = message.amount;
        if (!this.isValidRaise(player, raiseTo)) {
          this.sendToPlayer(client.sessionId, "actionError", { reason: "invalid_raise_amount" });
          return;
        }
        const additional = raiseTo - player.currentBet;
        player.chips -= additional;
        player.currentBet = raiseTo;
        player.totalRoundBet += additional;
        this.state.pot += additional;
        this.state.currentBet = raiseTo;
        this.state.lastAggressorId = player.id;
        player.hasActed = true;
        player.lastAction = "raise";
        this.raiseRestricted.clear(); // 正規サイズのレイズなので全員のレイズ権を再オープン
        this.resetHasActedExcept(player.id);
        this.pushLog(`${player.name}がレイズ(${raiseTo})`);
        break;
      }
      case "allin": {
        const additional = player.chips;
        if (additional <= 0) {
          this.sendToPlayer(client.sessionId, "actionError", { reason: "no_chips" });
          return;
        }
        const previousCurrentBet = this.state.currentBet;
        const raiseTo = player.currentBet + additional;
        player.currentBet = raiseTo;
        player.totalRoundBet += additional;
        this.state.pot += additional;
        player.chips = 0;
        player.allIn = true;
        player.hasActed = true;
        player.lastAction = "allin";
        if (raiseTo > previousCurrentBet) {
          this.state.currentBet = raiseTo;
          const raiseIncrement = raiseTo - previousCurrentBet;
          if (raiseIncrement >= this.state.minRaiseUnit) {
            // 最小レイズ額以上のオールイン → 正規のレイズとして全員のレイズ権を再オープン
            this.state.lastAggressorId = player.id;
            this.raiseRestricted.clear();
            this.resetHasActedExcept(player.id);
          } else {
            // 最小レイズ額に満たないショートオールイン → コール/フォールドのみ可能にする
            // (既存のraiseRestrictedプレイヤーは維持したまま、新たに他の全員を追加)
            for (const id of this.handParticipants) {
              const p = this.state.players.get(id)!;
              if (id !== player.id && !p.folded && !p.allIn) {
                this.raiseRestricted.add(id);
              }
            }
          }
        }
        this.pushLog(`${player.name}がオールイン`);
        break;
      }
      case "fold": {
        player.folded = true;
        player.hasActed = true;
        player.lastAction = "fold";
        this.pushLog(`${player.name}がフォールド`);
        break;
      }
      default:
        this.sendToPlayer(client.sessionId, "actionError", { reason: "unknown_action_type" });
        return;
    }

    this.progressGame();
  }

  /**
   * レイズ額(raiseTo=そのプレイヤーの合計BET額として指定)の妥当性検証。
   * ルール:既にBETが入っている状態へのレイズは「現在のBET額を超える額 〜 現在のBET額の2倍まで」、最小単位はSB刻み。
   * 現在のBET額が0(オープニングベット。フロップ以降で発生)の場合は上限を設けない(最小額SBのみ適用、最大は自分のチップ残高まで)。
   * ちょうどオールインになる額は allin アクションを使うこと。
   */
  private isValidRaise(player: PlayerState, raiseTo: number): boolean {
    if (this.raiseRestricted.has(player.id)) return false; // ショートオールインへの応答中はレイズ不可

    if (!Number.isFinite(raiseTo)) return false;
    if (raiseTo <= this.state.currentBet) return false;

    const minRaiseTo =
      this.state.currentBet > 0
        ? this.state.currentBet + this.state.minRaiseUnit
        : this.state.minRaiseUnit;
    if (raiseTo < minRaiseTo) return false;

    if (this.state.currentBet > 0 && raiseTo > this.state.currentBet * 2) return false;

    const additional = raiseTo - player.currentBet;
    if (additional >= player.chips) return false; // 超過 or ちょうどオールインは allin アクションで行う

    return true;
  }

  private resetHasActedExcept(exceptId: string) {
    for (const id of this.handParticipants) {
      const p = this.state.players.get(id)!;
      if (id !== exceptId && !p.folded && !p.allIn) {
        p.hasActed = false;
      }
    }
  }

  // ---------- ベッティングラウンド進行 ----------

  /** アクション後(退室によるフォールド含む)に必ず呼ぶ、進行状況の再評価。 */
  private progressGame() {
    const remaining = this.handParticipants.filter((id) => !this.state.players.get(id)!.folded);

    if (remaining.length === 1) {
      this.awardPotToSingleWinner(remaining[0]);
      return;
    }

    const stillToAct = remaining.filter((id) => {
      const p = this.state.players.get(id)!;
      return !p.allIn && (!p.hasActed || p.currentBet !== this.state.currentBet);
    });

    if (stillToAct.length === 0) {
      this.moveToNextStreetOrShowdown();
    } else {
      this.setActionPlayer(this.findNextToAct());
    }
  }

  private findNextToAct(): string {
    const order = this.handParticipants;
    const currentIdx = order.indexOf(this.state.actionPlayerId);
    for (let i = 1; i <= order.length; i++) {
      const idx = (currentIdx + i) % order.length;
      const id = order[idx];
      const p = this.state.players.get(id)!;
      if (!p.folded && !p.allIn) return id;
    }
    return this.state.actionPlayerId;
  }

  private firstToActPostflop(): string {
    const order = this.handParticipants;
    const btnId = this.state.seatOrder[this.state.dealerSeatIndex]!;
    const btnIdx = order.indexOf(btnId);
    for (let i = 1; i <= order.length; i++) {
      const idx = (btnIdx + i) % order.length;
      const id = order[idx];
      const p = this.state.players.get(id)!;
      if (!p.folded && !p.allIn) return id;
    }
    return order[0];
  }

  private dealNextStreetCards() {
    if (this.state.phase === "preflop") {
      this.state.communityCards.push(...this.deck.draw(3));
      this.syncDeckCounts();
      this.state.phase = "flop";
      this.pushLog("フロップ公開");
    } else if (this.state.phase === "flop") {
      this.state.communityCards.push(...this.deck.draw(1));
      this.syncDeckCounts();
      this.state.phase = "turn";
      this.pushLog("ターン公開");
    } else if (this.state.phase === "turn") {
      this.state.communityCards.push(...this.deck.draw(1));
      this.syncDeckCounts();
      this.state.phase = "river";
      this.pushLog("リバー公開");
    }
  }

  /** 残り全員オールイン等でベット不要な場合、リバーまで一気にカードを公開してからショーダウン */
  private autoRunToShowdown() {
    while (this.state.phase !== "river") {
      this.dealNextStreetCards();
    }
    this.showdown();
  }

  private moveToNextStreetOrShowdown() {
    for (const id of this.handParticipants) {
      const p = this.state.players.get(id)!;
      p.currentBet = 0;
      p.hasActed = false;
    }
    this.state.currentBet = 0;
    this.raiseRestricted.clear(); // 新しいストリートではレイズ制限をリセット

    if (this.state.phase === "river") {
      this.showdown();
      return;
    }

    const remaining = this.handParticipants.filter((id) => !this.state.players.get(id)!.folded);
    const canAct = remaining.filter((id) => !this.state.players.get(id)!.allIn);

    if (canAct.length <= 1) {
      this.autoRunToShowdown();
      return;
    }

    this.dealNextStreetCards();
    this.setActionPlayer(this.firstToActPostflop());
  }

  // ---------- ショーダウン・精算 ----------

  private showdownOrder(remaining: string[]): string[] {
    const order = this.handParticipants.filter((id) => remaining.includes(id));
    let startIdx = 0;
    if (this.state.lastAggressorId && order.includes(this.state.lastAggressorId)) {
      startIdx = order.indexOf(this.state.lastAggressorId);
    } else {
      const btnId = this.state.seatOrder[this.state.dealerSeatIndex]!;
      const idx = order.indexOf(btnId);
      startIdx = idx === -1 ? 0 : idx;
    }
    const result: string[] = [];
    for (let i = 0; i < order.length; i++) {
      result.push(order[(startIdx + i) % order.length]);
    }
    return result;
  }

  private showdown() {
    this.actionTimeout?.clear();
    this.state.phase = "showdown";
    const remaining = this.handParticipants.filter((id) => !this.state.players.get(id)!.folded);
    const order = this.showdownOrder(remaining);

    const handInfos = order.map((id) => ({ playerId: id, holeCards: this.holeCards.get(id)! }));

    for (const id of order) {
      const p = this.state.players.get(id)!;
      const cards = this.holeCards.get(id)!;
      p.revealedHoleCards.push(...cards);
    }

    const contributions: PotContribution[] = this.handParticipants.map((id) => {
      const p = this.state.players.get(id)!;
      return { playerId: id, totalRoundBet: p.totalRoundBet, folded: p.folded };
    });

    const pots = calculatePots(contributions);
    const community = Array.from(this.state.communityCards) as string[];

    const wonAmounts: Record<string, number> = {};
    for (const pot of pots) {
      const eligibleHands = handInfos.filter((h) => pot.eligiblePlayerIds.includes(h.playerId));
      const winnerIds = determineWinners(eligibleHands, community);
      const split = splitPot(pot.amount, winnerIds);
      for (const [id, amount] of Object.entries(split)) {
        const p = this.state.players.get(id)!;
        p.chips += amount;
        wonAmounts[id] = (wonAmounts[id] || 0) + amount;
        this.pushLog(`${p.name}が${amount}チップ獲得`);
      }
    }

    // クライアントのUI表示用に、公開された各プレイヤーの役名を通知する
    // (revealedHoleCardsとcommunityCardsから役名だけをクライアント側で再計算させず、サーバー側の判定結果をそのまま渡す)
    const showdownResults = order.map((id) => {
      const p = this.state.players.get(id)!;
      const hand = evaluateHand(this.holeCards.get(id)!, community);
      return {
        playerId: id,
        name: p.name,
        handName: hand.name, // 例:"Two Pair"
        handDescr: hand.descr, // 例:"Two Pair, A's & K's"
        amountWon: wonAmounts[id] || 0,
      };
    });
    this.broadcast("showdownResult", { results: showdownResults });

    this.state.pot = 0;
    this.state.sidePots.clear();

    const usedHole = order.flatMap((id) => this.holeCards.get(id) || []);
    this.deck.discard([...community, ...usedHole]);
    this.syncDeckCounts();

    this.state.phase = "roundEnd";
    this.clock.setTimeout(() => this.startNewRound(), 4000);
  }

  private awardPotToSingleWinner(winnerId: string) {
    this.actionTimeout?.clear();
    const p = this.state.players.get(winnerId)!;
    const amount = this.state.pot;
    p.chips += amount;
    this.pushLog(`${p.name}の勝利(ポット${amount}チップ獲得)`);
    this.broadcast("showdownResult", {
      results: [{ playerId: winnerId, name: p.name, handName: null, handDescr: null, amountWon: amount }],
      noShowdown: true, // ショーダウンなし(全員フォールド)での決着であることをクライアントに伝える
    });
    this.state.pot = 0;
    this.state.phase = "roundEnd";

    const usedHole = this.handParticipants.flatMap((id) => this.holeCards.get(id) || []);
    this.deck.discard([...(Array.from(this.state.communityCards) as string[]), ...usedHole]);
    this.syncDeckCounts();

    this.clock.setTimeout(() => this.startNewRound(), 3000);
  }
}
