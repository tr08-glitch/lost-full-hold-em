import { Room, Client, matchMaker } from "colyseus";
import { RoomState } from "../schema/RoomState";
import { PlayerState } from "../schema/PlayerState";
import { Deck, isJokerCode } from "../logic/deck";
import { determineWinners, evaluateHand } from "../logic/handEvaluator";
import { calculatePots, splitPot, PotContribution } from "../logic/potManager";

interface RoomOptions {
  maxRounds?: number;
  timeLimit?: number;
  bigBlind?: number;
  startingChips?: number;
  mode?: "normal" | "lostfull";
  jokerEnabled?: boolean;
  jokerCount?: number;
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
  maxClients = 16; // 対戦席は最大6人(onJoinで制限)。それ以外は観戦者

  private deck = new Deck();
  // ホールカードの中身はスキーマに乗せず、サーバー内部だけで保持する(本人にのみ個別送信)
  private holeCards: Map<string, string[]> = new Map();
  // 最小レイズ未満のショートオールインが発生した際、レイズが打ち返せないプレイヤーの集合。
  // 正規サイズのレイズが行われる、または新しいストリートが始まるとクリアされる。
  private raiseRestricted: Set<string> = new Set();
  // 「退室」ボタンなど、本人が明示的に退室したことを示すsessionIdの集合。
  // room.leave()のconsentedフラグは、ブラウザのページ遷移による切断でも
  // なぜかtrueとして届くことがあり信用できないため、これを正とする。
  private intentionalLeaves: Set<string> = new Set();

  // 現在の手番プレイヤーの行動タイムアウト(30秒操作がなければ自動フォールド)
  private actionTimeout: { clear: () => void } | null = null;
  private lostInCallers = new Set<string>(); // ロストイン宣言にコールで応じた人(実行後も勝負に残る)
  private actionDeadline = 0; // 手番の締切(epoch ms)
  // 切断から強制退室までの猶予(秒)
  private static readonly DISCONNECT_GRACE_SEC = 20;
  // このハンドの開始時点で配札されたプレイヤーのidスナップショット(座席順)。
  // ハンド途中で降参・死亡(isSurrendered/isDead/isVegetative)になっても、
  // そのハンドのポット計算・進行では引き続きこのリストを使う(activeSeatOrderは
  // 「次のハンドに参加できるか」を表すため、ハンド中に変化すると投入済みチップの
  // 集計から抜け落ちてしまう)。
  private handParticipants: string[] = [];
  private surrenderCounter = 0;

  private static clampTimeLimit(n: number): number {
    return Math.min(300, Math.max(5, Math.floor(n)));
  }

  async onCreate(options: RoomOptions) {
    this.setState(new RoomState());

    this.state.maxRounds = options.maxRounds ?? 10;
    this.state.timeLimit = PokerRoom.clampTimeLimit(options.timeLimit ?? 30);
    // 残り秒数を表示用にstateへ反映(0.5秒ごと)
    this.clock.setInterval(() => {
      const active =
        (this.state.actionPlayerId !== "" && ["preflop", "flop", "turn", "river"].includes(this.state.phase)) ||
        this.state.phase === "needExchange";
      const left = active ? Math.max(0, Math.ceil((this.actionDeadline - Date.now()) / 1000)) : 0;
      if (this.state.timeLeft !== left) this.state.timeLeft = left;
    }, 500);
    this.state.bigBlind = options.bigBlind ?? 40;
    this.state.smallBlind = Math.floor(this.state.bigBlind / 2);
    this.state.minRaiseUnit = this.state.smallBlind;
    this.state.startingChips = options.startingChips ?? 1000;
    this.state.mode = options.mode ?? "normal";
    this.state.jokerEnabled = options.jokerEnabled ?? false;
    this.state.jokerCount = options.jokerCount ?? 2;

    // 参加者が入力する4桁のルームコードを発行(Colyseus内部のroomIdとは別物、現在有効な他の
    // 「poker」ルームと重複しないことを確認してから採番する)
    const roomCode = await this.generateUniqueRoomCode();
    this.state.roomCode = roomCode;
    await this.setMetadata({ code: roomCode });

    this.onMessage("startGame", (client) => this.handleStartGame(client));
    this.onMessage("action", (client, message: ActionMessage) =>
      this.handleAction(client, message)
    );
    this.onMessage("updateSettings", (client, message) => this.handleUpdateSettings(client, message));
    this.onMessage("surrender", (client) => this.handleSurrender(client));
    this.onMessage("exchangeBodyPart", (client, message) => this.handleExchangeBodyPart(client, message));
    this.onMessage("leaveIntentional", (client) => {
      console.log(`[LFH][room=${this.roomId} code=${this.state.roomCode}] leaveIntentional received sessionId=${client.sessionId}`);
      this.intentionalLeaves.add(client.sessionId);
    });
    this.onMessage("newGame", (client) => this.handleNewGame(client));
    this.onMessage("returnToLobby", (client) => this.handleReturnToLobby(client));
    this.onMessage("ijOpen", (client, m: { bet?: number }) => this.ijOpen(client, m));
    this.onMessage("ijSetBet", (client, m: { bet?: number }) => this.ijSetBet(client, m));
    this.onMessage("ijJoin", (client) => this.ijJoin(client));
    this.onMessage("ijBegin", (client) => this.ijBegin(client));
    this.onMessage("ijPick", (client, m: { pick?: string }) => this.ijPick(client, m));
    this.onMessage("ijClose", (client) => this.ijClose(client));
    this.onMessage("ijInfoReq", (client) => this.ijSendInfo(client));
    this.onMessage("kick", (client, message: { targetId?: string }) => this.handleKick(client, message));
    this.onMessage("chat", (client, message: { target?: string; text?: string }) => this.handleChat(client, message));
    console.log(`[LFH] onCreate roomId=${this.roomId}`);
  }

  onDispose() {
    console.log(`[LFH] onDispose roomId=${this.roomId} roomCode=${this.state.roomCode}`);
  }

  /** 現在アクティブな他の「poker」ルームと重複しない4桁のルームコードを発行する */
  private async generateUniqueRoomCode(): Promise<string> {
    for (let i = 0; i < 20; i++) {
      const code = String(Math.floor(1000 + Math.random() * 9000));
      const existingRooms = await matchMaker.query({ name: "poker" });
      const taken = existingRooms.some((r) => r.metadata && r.metadata.code === code);
      if (!taken) return code;
    }
    // 20回試して空きが見つからない場合のフォールバック(理論上ほぼ到達しない)
    return String(Math.floor(1000 + Math.random() * 9000));
  }

  onJoin(client: Client, options: { name?: string }) {
    console.log(`[LFH][room=${this.roomId} code=${this.state.roomCode}] onJoin sessionId=${client.sessionId} name=${options?.name}`);
    const spectating = this.state.gameStarted; // ゲーム開始後の入室は観戦者
    if (!spectating && this.state.seatOrder.length >= 6) {
      throw new Error("room_full");
    }

    const player = new PlayerState();
    player.id = client.sessionId;
    const takenNames = new Set<string>();
    this.state.players.forEach((p) => takenNames.add(p.name.trim().toLowerCase()));
    const requested = (options?.name || "").trim().slice(0, 10);
    let finalName = requested;
    if (!requested) {
      // 名前未入力の場合は「プレイヤー1」「プレイヤー2」…と、空いている最小の番号を割り当てる
      let n = 1;
      while (takenNames.has(`プレイヤー${n}`.toLowerCase())) n++;
      finalName = `プレイヤー${n}`;
    } else if (takenNames.has(requested.toLowerCase())) {
      throw new Error("duplicate_name");
    }
    player.name = finalName;
    if (spectating) {
      player.isSpectator = true;
      player.chips = 0;
      player.seatIndex = -1;
      player.isGM = false;
      player.folded = true;
      this.state.players.set(client.sessionId, player);
      this.pushLog(`${player.name} が観戦者として入室しました`);
      this.sendSpectatorHands(client.sessionId);
      return;
    }
    player.chips = this.state.startingChips;
    player.seatIndex = this.state.seatOrder.length;
    player.isGM = this.state.seatOrder.length === 0; // 最初の入室者がGM(部屋作成者)

    this.state.players.set(client.sessionId, player);
    this.state.seatOrder.push(client.sessionId);

    this.pushLog(`${player.name} が入室しました`);
  }

  async onLeave(client: Client, consented: boolean) {
    const isIntentional = this.intentionalLeaves.has(client.sessionId);
    this.intentionalLeaves.delete(client.sessionId);
    console.log(
      `[LFH][room=${this.roomId} code=${this.state.roomCode}] onLeave START sessionId=${client.sessionId} consented=${consented} isIntentional=${isIntentional}`
    );
    const player = this.state.players.get(client.sessionId);
    if (!player) {
      console.log(`[LFH][room=${this.roomId} code=${this.state.roomCode}] onLeave: player not found in state (already removed?) sessionId=${client.sessionId}`);
      return;
    }
    player.connected = false;

    if (isIntentional) {
      // 「退室」ボタンなど、本人が明示的に退室した場合のみ、再接続を待たず即座に処理する
      console.log(`[LFH][room=${this.roomId} code=${this.state.roomCode}] onLeave: intentional leave, treating as permanent. sessionId=${client.sessionId}`);
      this.handlePlayerGoneForGood(client.sessionId);
      return;
    }

    // ページ遷移(title→room-create→table など)や瞬断はここに入る。
    // 20秒間は同じセッションでの再接続(client.reconnect)を受け付け、
    // 別プレイヤー扱いにならないようにする。
    console.log(`[LFH][room=${this.roomId} code=${this.state.roomCode}] onLeave: arming allowReconnection(20s) sessionId=${client.sessionId} reconnectionToken=${(client as any)._reconnectionToken}`);
    try {
      await this.allowReconnection(client, PokerRoom.DISCONNECT_GRACE_SEC);
      player.connected = true; // 再接続成功
      console.log(`[LFH][room=${this.roomId} code=${this.state.roomCode}] onLeave: RECONNECTED successfully sessionId=${client.sessionId}`);
      this.pushLog(`${player.name}が再接続しました`);
    } catch (e) {
      // 20秒以内に再接続されなかった → 本当に退室したとみなす
      console.log(`[LFH][room=${this.roomId} code=${this.state.roomCode}] onLeave: allowReconnection FAILED/EXPIRED sessionId=${client.sessionId} error=${e}`);
      this.handlePlayerGoneForGood(client.sessionId);
    }
  }

  /** GMによるキック。対象は即座に退室扱いになる */
  private handleKick(client: Client, message: { targetId?: string }) {
    const gm = this.state.players.get(client.sessionId);
    if (!gm || !gm.isGM) return;
    const targetId = message?.targetId;
    if (!targetId || targetId === client.sessionId) return;
    const target = this.state.players.get(targetId);
    if (!target) return;

    this.intentionalLeaves.add(targetId);
    const targetClient = this.clients.find((c) => c.sessionId === targetId);
    if (targetClient) {
      targetClient.send("kicked", {});
      targetClient.leave(); // onLeaveが意図的退室として処理する
    } else {
      // 既に切断中のプレイヤーは、再接続待ちを待たずに直接処理する
      this.intentionalLeaves.delete(targetId);
      this.handlePlayerGoneForGood(targetId);
    }
    this.pushLog(`${target.name}がGMにキックされました`);
  }

  /** 再接続の見込みがなくなった(退室 or タイムアウト)プレイヤーの後処理 */
  private handlePlayerGoneForGood(sessionId: string) {
    const player = this.state.players.get(sessionId);
    if (!player) return;

    if (player.isSpectator) {
      this.state.players.delete(sessionId);
      this.pushLog(`${player.name}(観戦者)が退室しました`);
      return;
    }

    if (!this.state.gameStarted) {
      // ロビー中の離脱はそのまま座席から取り除く(ミニゲーム進行中なら中止)
      if (this.state.ij.phase === "recruiting" || this.state.ij.phase === "playing") {
        this.ijReset();
        this.pushLog("参加者が退室したためインディアンジャッジを中止しました");
      }
      this.state.players.delete(sessionId);
      const idx = this.state.seatOrder.indexOf(sessionId);
      if (idx !== -1) this.state.seatOrder.splice(idx, 1);
      this.pushLog(`${player.name}が退室しました`);
      return;
    }

    if (this.state.phase === "gameEnd") return;
    if (this.state.phase === "needExchange") {
      // 換金待ちの間の離脱:換金待ち中の本人はそのまま脱落、それ以外は通常通り(次ラウンドで除外される)
      if (player.chips <= 0) player.isBusted = true;
      player.folded = true;
      this.checkNeedExchangeDone();
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
    const ms = this.state.timeLimit * 1000;
    this.actionDeadline = Date.now() + ms;
    this.state.timeLeft = this.state.timeLimit;
    this.actionTimeout = this.clock.setTimeout(() => this.autoFoldOnTimeout(playerId), ms);
  }

  /** タイムアウト発火時、まだ本当にそのプレイヤーの手番であればフォールドさせる */
  private autoFoldOnTimeout(playerId: string) {
    if (this.state.actionPlayerId !== playerId) return; // 既に状況が進んでいれば何もしない
    if (!["preflop", "flop", "turn", "river"].includes(this.state.phase)) return;

    const player = this.state.players.get(playerId);
    if (!player || player.folded || player.allIn) return;

    // ロストイン応答待ち中の時間切れは、応答フローの「フォールド」として処理する(そうしないと宣言状態が残り手番が進まなくなる)
    if (this.state.mode === "lostfull" && this.state.lostInActive) {
      this.pushLog(`${player.name}が時間切れのため自動フォールドしました`);
      this.handleLostInResponse({ sessionId: playerId } as Client, player, { type: "fold" } as ActionMessage);
      return;
    }

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

  /** まだ換金できる身体パーツが残っているか(心臓も含む) */
  private hasExchangeableParts(p: PlayerState): boolean {
    return (
      p.fingersLostLeft < 5 || p.fingersLostRight < 5 || !p.teethLost ||
      !p.earsLostLeft || !p.earsLostRight || !p.lungsLostLeft || !p.lungsLostRight ||
      !p.eyesLostLeft || !p.eyesLostRight || !p.armsLostLeft || !p.armsLostRight || !p.heartLost
    );
  }

  private needExchangeTimer: { clear: () => void } | null = null;

  /** ロストフル:チップが尽きたプレイヤーがいれば、部位換金が済むまでラウンド開始を待つ(ゲームは終わらない) */
  private enterNeedExchangeIfAny(): boolean {
    if (this.state.mode !== "lostfull") return false;
    const needy: string[] = [];
    for (const id of this.state.seatOrder as string[]) {
      const p = this.state.players.get(id);
      if (p && !p.isDead && !p.isVegetative && !p.isBusted && !p.isSurrendered && p.chips <= 0) needy.push(id);
    }
    if (needy.length === 0) return false;
    this.actionTimeout?.clear();
    this.state.actionPlayerId = "";
    this.state.needExchange.clear();
    needy.forEach((id) => this.state.needExchange.push(id));
    this.state.phase = "needExchange";
    const ms = Math.max(30, this.state.timeLimit * 2) * 1000;
    this.actionDeadline = Date.now() + ms;
    this.state.timeLeft = Math.ceil(ms / 1000);
    this.needExchangeTimer?.clear();
    this.needExchangeTimer = this.clock.setTimeout(() => this.expireNeedExchange(), ms);
    const names = needy.map((id) => this.state.players.get(id)?.name ?? "").join("、");
    this.pushLog(`${names}のチップが0になりました。換金が終わるまで次のラウンドを待ちます`);
    return true;
  }

  /** 換金が済んだ(または死亡・廃人になった)人を待ち行列から外し、全員済んだらラウンド開始 */
  private checkNeedExchangeDone() {
    if (this.state.phase !== "needExchange") return;
    for (const id of [...(this.state.needExchange as string[])]) {
      const p = this.state.players.get(id);
      const i = (this.state.needExchange as string[]).indexOf(id);
      if (!p || p.chips > 0 || p.isDead || p.isVegetative || p.isBusted || p.isSurrendered || !this.hasExchangeableParts(p)) {
        if (i !== -1) this.state.needExchange.splice(i, 1);
      }
    }
    if (this.state.needExchange.length === 0) {
      this.needExchangeTimer?.clear();
      this.needExchangeTimer = null;
      this.startNewRound();
    }
  }

  /** 制限時間内に換金しなかった人は脱落(バスト)扱いにして続行 */
  private expireNeedExchange() {
    if (this.state.phase !== "needExchange") return;
    for (const id of [...(this.state.needExchange as string[])]) {
      const p = this.state.players.get(id);
      if (p && p.chips <= 0 && !p.isDead && !p.isVegetative) {
        p.isBusted = true;
        this.pushLog(`${p.name}は換金せず、チップが尽きたため脱落しました`);
      }
    }
    this.state.needExchange.clear();
    this.needExchangeTimer = null;
    this.startNewRound();
  }

  /** チップが0になったプレイヤーを「バスト」として以降のラウンドの進行から除外する */
  private markBustedPlayers() {
    for (const id of this.state.seatOrder) {
      const p = this.state.players.get(id);
      if (p && !p.isDead && !p.isVegetative && !p.isBusted && !p.isSurrendered && p.chips <= 0) {
        // ロストフルモードでは、換金できる部位が残っていればバストにせず、換金して続行できる
        if (this.state.mode === "lostfull" && this.hasExchangeableParts(p)) continue;
        p.isBusted = true;
        this.pushLog(`${p.name}はチップが尽きたため、以降のラウンドから除外されます`);
      }
    }
  }


  // ---------- ミニゲーム:インディアンジャッジ(ロビー専用) ----------
  // 掛け金は「次のゲームの初期チップ」から支払う。
  // 数字カードは 1〜(人数+2)。場に1枚(結果公開まで誰にも見えない)、各プレイヤーに1枚(自分のは見えない)、残り1枚は墓地(使われない)。
  // 各プレイヤーには「他プレイヤーの手札+墓地」のうち半数(切り捨て)がランダムに公開される。
  // それを踏まえて自分のカードが場より大きいか小さいかを予想し、的中者全員で全員の掛け金を山分け。
  private ijPicks = new Map<string, "high" | "low">();
  private ijSeen = new Map<string, { who: string; num: number }[]>(); // 各プレイヤーに公開された情報(本人にだけ送る)
  private ijNums = new Map<string, number>(); // 各プレイヤーの数字(非公開)
  private ijGrave: number[] = [];
  private ijField = 0; // 場の数字(結果公開まで非公開)
  private ijTimer: { clear: () => void } | null = null;
  private ijTicker: { clear: () => void } | null = null;
  private static readonly IJ_PICK_SEC = 25;
  private static readonly IJ_REVEAL_MS = 6000;

  private ijReset() {
    this.ijTimer?.clear();
    this.ijTicker?.clear();
    this.ijTimer = null;
    this.ijTicker = null;
    this.ijPicks.clear();
    this.ijSeen.clear();
    this.ijNums.clear();
    this.ijGrave = [];
    const r = this.state.ij;
    r.phase = "idle";
    r.bet = 0;
    r.participants.clear();
    r.step = "pick";
    r.fieldNum = 0;
    r.pickedIds.clear();
    r.winners.clear();
    r.winnerGain = 0;
    r.turnLeft = 0;
  }

  /** ゲーム開始時、ミニゲームの増減を初期チップに反映して0に戻す */
  private applyChipDeltas() {
    for (const id of this.state.seatOrder as string[]) {
      const p = this.state.players.get(id);
      if (!p) continue;
      p.chips = Math.max(1, this.state.startingChips + p.chipDelta);
      p.chipDelta = 0;
    }
  }

  private ijMaxBet(): number {
    return Math.max(1, this.state.bigBlind); // 「少量」:BBと同じ額まで
  }

  private ijOpen(client: Client, m: { bet?: number }) {
    const gm = this.state.players.get(client.sessionId);
    if (!gm?.isGM || this.state.gameStarted) return;
    const r = this.state.ij;
    if (r.phase === "recruiting" || r.phase === "playing") return;
    const bet = Math.floor(Number(m?.bet));
    if (!Number.isFinite(bet) || bet < 1 || bet > this.ijMaxBet()) return;
    this.ijReset();
    r.bet = bet;
    r.phase = "recruiting";
    r.participants.push(client.sessionId);
    this.pushLog(`インディアンジャッジ参加者募集(掛け金${bet})`);
  }

  private ijSetBet(client: Client, m: { bet?: number }) {
    const gm = this.state.players.get(client.sessionId);
    const r = this.state.ij;
    if (!gm?.isGM || r.phase !== "recruiting") return;
    const bet = Math.floor(Number(m?.bet));
    if (!Number.isFinite(bet) || bet < 1 || bet > this.ijMaxBet()) return;
    r.bet = bet;
    // 掛け金を払えなくなった参加者(GM以外)は自動で外す
    for (const id of [...(r.participants as string[])]) {
      const p = this.state.players.get(id);
      if (!p || p.isGM) continue;
      if (this.state.startingChips + p.chipDelta - bet < 1) {
        const i = (r.participants as string[]).indexOf(id);
        if (i !== -1) r.participants.splice(i, 1);
      }
    }
  }

  private ijJoin(client: Client) {
    const r = this.state.ij;
    if (r.phase !== "recruiting") return;
    const p = this.state.players.get(client.sessionId);
    if (!p || p.isSpectator) return;
    const idx = (r.participants as string[]).indexOf(client.sessionId);
    if (idx !== -1) {
      if (p.isGM) return; // GMは主催者なので抜けられない
      r.participants.splice(idx, 1);
      return;
    }
    if (this.state.startingChips + p.chipDelta - r.bet < 1) return; // 掛け金を払えない
    r.participants.push(client.sessionId);
  }

  private ijBegin(client: Client) {
    const gm = this.state.players.get(client.sessionId);
    const r = this.state.ij;
    if (!gm?.isGM || r.phase !== "recruiting" || r.participants.length < 2) return;
    const order = (this.state.seatOrder as string[]).filter((id) => (r.participants as string[]).includes(id));
    r.participants.clear();
    order.forEach((id) => r.participants.push(id));
    r.winners.clear();
    r.pickedIds.clear();
    const n = order.length;
    // 1〜(n+2) をシャッフル:先頭=場、次のn枚=各プレイヤー、残り1枚=墓地
    const deck = Array.from({ length: n + 2 }, (_, i) => i + 1);
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j]!, deck[i]!];
    }
    this.ijField = deck[0]!;
    r.fieldNum = 0;
    r.roundId++;
    this.ijNums.clear();
    order.forEach((id, i) => this.ijNums.set(id, deck[1 + i]!));
    this.ijGrave = deck.slice(1 + n);
    // 各プレイヤーに公開する情報(他プレイヤー+墓地のうち半数・切り捨て)
    this.ijSeen.clear();
    for (const id of order) {
      const cand: { who: string; num: number }[] = order.filter((o) => o !== id).map((o) => ({ who: o, num: this.ijNums.get(o)! }));
      this.ijGrave.forEach((g) => cand.push({ who: "grave", num: g }));
      for (let i = cand.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [cand[i], cand[j]] = [cand[j]!, cand[i]!];
      }
      this.ijSeen.set(id, cand.slice(0, Math.floor(cand.length / 2)));
    }
    r.phase = "playing";
    this.pushLog("インディアンジャッジ開始!");
    this.ijSendInfoAll();
    this.ijStartPick();
  }

  private ijSendInfoAll() {
    for (const c of this.clients) this.ijSendInfo(c);
  }
  private ijSendInfo(client: Client) {
    const r = this.state.ij;
    if (r.phase !== "playing") return;
    const seen = this.ijSeen.get(client.sessionId);
    if (!seen) return;
    client.send("ijInfo", { seen, total: r.participants.length + 2 });
  }

  private ijStartPick() {
    const r = this.state.ij;
    this.ijTimer?.clear();
    this.ijTicker?.clear();
    this.ijPicks.clear();
    r.pickedIds.clear();
    r.step = "pick";
    r.turnLeft = PokerRoom.IJ_PICK_SEC;
    const deadline = Date.now() + PokerRoom.IJ_PICK_SEC * 1000;
    this.ijTicker = this.clock.setInterval(() => {
      r.turnLeft = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    }, 500);
    this.ijTimer = this.clock.setTimeout(() => this.ijReveal(), PokerRoom.IJ_PICK_SEC * 1000);
  }

  private ijPick(client: Client, m: { pick?: string }) {
    const r = this.state.ij;
    if (r.phase !== "playing" || r.step !== "pick") return;
    const id = client.sessionId;
    if (!(r.participants as string[]).includes(id)) return;
    if (m?.pick !== "high" && m?.pick !== "low") return;
    this.ijPicks.set(id, m.pick);
    if (!(r.pickedIds as string[]).includes(id)) r.pickedIds.push(id);
    if ((r.participants as string[]).every((a) => this.ijPicks.has(a))) this.ijReveal();
  }

  /** 全員の数字を公開して判定する */
  private ijReveal() {
    const r = this.state.ij;
    if (r.phase !== "playing" || r.step !== "pick") return;
    this.ijTimer?.clear();
    this.ijTicker?.clear();
    r.turnLeft = 0;
    const parts = r.participants as string[];
    for (const id of parts) {
      if (!this.ijPicks.has(id)) this.ijPicks.set(id, Math.random() < 0.5 ? "high" : "low");
    }
    const field = this.ijField;
    r.fieldNum = field;
    const winners = parts.filter((id) => {
      const n = this.ijNums.get(id)!;
      return n > field ? this.ijPicks.get(id) === "high" : this.ijPicks.get(id) === "low";
    });
    const nums: Record<string, number> = {};
    const picks: Record<string, string> = {};
    parts.forEach((id) => {
      nums[id] = this.ijNums.get(id)!;
      picks[id] = this.ijPicks.get(id)!;
    });
    r.step = "reveal";
    this.broadcast("ijReveal", { field, nums, picks, grave: this.ijGrave, winners });
    this.ijTimer = this.clock.setTimeout(() => this.ijFinish(winners), PokerRoom.IJ_REVEAL_MS);
  }

  private ijFinish(winners: string[]) {
    const r = this.state.ij;
    const parts = r.participants as string[];
    // 全員の掛け金の合計を、的中者で山分け(端数切り捨て)。的中者なしなら変動なし
    if (winners.length > 0) {
      const pot = r.bet * parts.length;
      const each = Math.floor(pot / winners.length);
      for (const id of parts) {
        const pl = this.state.players.get(id);
        if (!pl) continue;
        if (winners.includes(id)) pl.chipDelta += each - r.bet;
        else pl.chipDelta -= r.bet;
      }
      r.winnerGain = each - r.bet;
      this.pushLog(`インディアンジャッジ決着!的中者は次のゲームの初期チップ ${r.winnerGain >= 0 ? "+" : ""}${r.winnerGain}、外れた人は -${r.bet}`);
    } else {
      r.winnerGain = 0;
      this.pushLog("インディアンジャッジ:全員外れ…チップの増減なし");
    }
    winners.forEach((id) => r.winners.push(id));
    r.phase = "result";
  }

  private ijClose(client: Client) {
    const gm = this.state.players.get(client.sessionId);
    if (!gm?.isGM || this.state.gameStarted) return;
    this.ijReset();
  }

  // ---------- ゲーム開始 ----------

  private handleStartGame(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (!player?.isGM) return; // GM(ルーム作成者)のみ開始可能
    if (this.state.gameStarted) return;
    if (this.state.seatOrder.length < 2) return;

    this.ijReset();
    this.applyChipDeltas();
    this.state.gameStarted = true;
    this.state.roundNumber = 0;
    this.state.dealerSeatIndex = Math.floor(Math.random() * this.state.seatOrder.length);

    this.startNewRound();
  }

  /** GMがルーム設定モーダルで「確定」した内容をルームに反映する(ゲーム開始前のみ有効) */
  private handleUpdateSettings(
    client: Client,
    message: Partial<{
      mode: "normal" | "lostfull";
      startingChips: number;
      maxRounds: number;
      timeLimit: number;
      bigBlind: number;
      jokerEnabled: boolean;
      jokerCount: number;
      spectatorSeeHands: boolean;
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
    if (typeof message.timeLimit === "number" && message.timeLimit > 0) {
      this.state.timeLimit = PokerRoom.clampTimeLimit(message.timeLimit);
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
    if (typeof message.jokerEnabled === "boolean") {
      this.state.jokerEnabled = message.jokerEnabled;
    }
    if (typeof message.spectatorSeeHands === "boolean") {
      this.state.spectatorSeeHands = message.spectatorSeeHands;
    }
    if (typeof message.jokerCount === "number" && message.jokerCount > 0) {
      this.state.jokerCount = Math.floor(message.jokerCount);
    }

    this.pushLog("ゲーム設定が更新されました");
  }

  /** 結果発表後の再戦/ロビー復帰用:全員のチップ・身体・ストレス等を初期状態に戻す(切断中の人は除外) */
  private resetForNewGame() {
    this.state.endReason = "";
    this.clearDropTimers();
    this.runoutTimer?.clear();
    this.runoutTimer = null;
    for (const id of [...this.state.seatOrder] as string[]) {
      const p = this.state.players.get(id);
      if (!p) continue;
      if (!p.connected) {
        this.state.players.delete(id);
        const idx = this.state.seatOrder.indexOf(id);
        if (idx !== -1) this.state.seatOrder.splice(idx, 1);
      }
    }
    let seat = 0;
    for (const id of this.state.seatOrder as string[]) {
      const p = this.state.players.get(id)!;
      p.seatIndex = seat++;
      p.chips = this.state.startingChips;
      p.currentBet = 0; p.totalRoundBet = 0;
      p.folded = false; p.allIn = false; p.hasActed = false; p.holeCardCount = 0;
      p.revealedHoleCards.clear();
      p.isBTN = false; p.isSB = false; p.isBB = false; p.positionLabel = ""; p.lastAction = "";
      p.stress = 0; p.isDead = false; p.isVegetative = false;
      p.fingersLostLeft = 0; p.fingersLostRight = 0; p.teethLost = false;
      p.earsLostLeft = false; p.earsLostRight = false;
      p.lungsLostLeft = false; p.lungsLostRight = false;
      p.eyesLostLeft = false; p.eyesLostRight = false;
      p.armsLostLeft = false; p.armsLostRight = false; p.heartLost = false;
      p.publicCardLeft = ""; p.publicCardRight = "";
      p.isBusted = false; p.isSurrendered = false; p.surrenderOrder = 0;
    }
    this.surrenderCounter = 0;
    this.needExchangeTimer?.clear();
    this.needExchangeTimer = null;
    this.state.needExchange.clear();
    this.holeCards.clear();
    this.raiseRestricted.clear();
    this.state.communityCards.clear();
    this.state.sidePots.clear();
    this.state.pot = 0;
    this.state.currentBet = 0;
    this.state.roundNumber = 0;
    this.state.actionPlayerId = "";
    this.state.lastAggressorId = "";
    this.state.lostInActive = false;
    this.state.lostInDeclarerId = "";
    this.state.lostInAmount = 0;
  }

  /** 観戦者を通常プレイヤーに昇格させる(空き席がある分だけ)。ニューゲーム/ロビー復帰時に呼ぶ */
  private promoteSpectators() {
    this.state.players.forEach((p, id) => {
      if (!p.isSpectator) return;
      if (this.state.seatOrder.length >= 6) return;
      p.isSpectator = false;
      p.folded = false;
      this.state.seatOrder.push(id);
      this.pushLog(`${p.name}が観戦者から参加者になりました`);
    });
  }

  /** 観戦者への手札公開(設定がオンのときだけ)。sessionId指定でその観戦者のみに送る */
  private sendSpectatorHands(onlyId?: string) {
    if (!this.state.spectatorSeeHands) return;
    if (this.holeCards.size === 0) return;
    if (!["preflop", "flop", "turn", "river", "judge", "showdown"].includes(this.state.phase)) return;
    const hands: Record<string, string[]> = {};
    for (const id of this.handParticipants) {
      const c = this.holeCards.get(id);
      if (c) hands[id] = c;
    }
    for (const c of this.clients) {
      const pl = this.state.players.get(c.sessionId);
      if (!pl?.isSpectator) continue;
      if (onlyId && c.sessionId !== onlyId) continue;
      c.send("spectatorHands", { hands });
    }
  }

  private handleNewGame(client: Client) {
    const gm = this.state.players.get(client.sessionId);
    if (!gm?.isGM || this.state.phase !== "gameEnd") return;
    this.promoteSpectators();
    this.resetForNewGame();
    if (this.state.seatOrder.length < 2) return this.handleReturnToLobby(client);
    this.state.dealerSeatIndex = Math.floor(Math.random() * this.state.seatOrder.length);
    this.applyChipDeltas();
    this.pushLog("--- ニューゲーム ---");
    this.startNewRound();
  }

  private handleReturnToLobby(client: Client) {
    const gm = this.state.players.get(client.sessionId);
    if (!gm?.isGM || this.state.phase !== "gameEnd") return;
    this.promoteSpectators();
    this.resetForNewGame();
    this.state.gameStarted = false;
    this.state.phase = "waiting";
    this.state.dealerSeatIndex = -1;
    this.unlock();
    this.pushLog("ルームに戻りました");
  }

  private endGame(reason: "rounds" | "survivor") {
    this.actionTimeout?.clear();
    this.state.actionPlayerId = "";
    this.state.phase = "gameEnd"; // gameStartedはtrueのまま(クライアントはphaseで結果発表を表示する)
    this.state.endReason = reason;

    // 順位ルール:
    //  ・ラウンド切れ … 死亡/廃人のスコアはチップ×0.7(それ以外はチップそのまま)
    //  ・それ以外(生存者1人以下)… 死亡/廃人は全員敗北(生存扱いの人より下)
    const score = (p: PlayerState) => (reason === "rounds" && (p.isDead || p.isVegetative) ? p.chips * 0.7 : p.chips);
    let winner: PlayerState | null = null;
    for (const id of this.state.seatOrder) {
      const p = this.state.players.get(id);
      if (!p || p.isSurrendered) continue;
      if (reason === "survivor" && (p.isDead || p.isVegetative)) continue;
      if (!winner || score(p) > score(winner)) winner = p;
    }
    if (winner) {
      this.pushLog(reason === "rounds"
        ? `--- 全${this.state.maxRounds}ラウンド終了。優勝: ${winner.name}(スコア${Math.round(score(winner) * 10) / 10}) ---`
        : `--- 生存者が1人以下になったため終了。優勝: ${winner.name}(${winner.chips}チップ) ---`);
    }
  }

  // ---------- ラウンド開始 ----------

  private startNewRound() {
    this.runoutTimer?.clear();
    this.runoutTimer = null;
    this.markBustedPlayers();
    this.state.needExchange.clear();
    this.clearDropTimers();
    if (this.enterNeedExchangeIfAny()) return;
    const order = this.activeSeatOrder();
    this.handParticipants = order; // このハンドの参加者を確定・スナップショット
    if (order.length < 2) {
      this.endGame("survivor");
      return;
    }

    this.state.roundNumber++;
    if (this.state.roundNumber > this.state.maxRounds) {
      this.endGame("rounds");
      return;
    }

    this.deck.reset(this.state.jokerEnabled ? this.state.jokerCount : 0);
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

      // ロストフルモード限定:ジョーカーを配られると1枚につきストレス値+5
      if (this.state.mode === "lostfull") {
        const jokerCount = cards.filter((c) => isJokerCode(c)).length;
        if (jokerCount > 0) {
          p.stress += jokerCount * 5;
          this.pushLog(`${p.name}にジョーカーが配られた(ストレス+${jokerCount * 5})`);
          if (!p.isVegetative && p.stress >= 100) {
            p.isVegetative = true;
            p.folded = true; // まだアクション開始前なのでフォールド状態にしておくだけでよい
            this.pushLog(`${p.name}は廃人となった`);
          }
        }
      }
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
    this.sendSpectatorHands();

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
    if (!player || player.isSpectator) return;
    if (this.state.phase === "gameEnd") return; // ゲーム終了後は降参不可
    if (player.isDead || player.isVegetative || player.isBusted || player.isSurrendered) return;

    if (!this.state.gameStarted) {
      // ロビー中の降参は退室と同義に扱う
      this.handlePlayerGoneForGood(client.sessionId);
      return;
    }

    player.isSurrendered = true;
    this.surrenderCounter++;
    player.surrenderOrder = this.surrenderCounter;
    this.pushLog(`${player.name}が降参しました`);

    if (this.state.phase === "needExchange") {
      this.checkNeedExchangeDone();
      return;
    }

    if (!player.folded) {
      player.folded = true;
      player.hasActed = true;
      player.lastAction = "fold";
      this.progressGame();
    }
  }

  // ---------- ロストフルモード:身体パーツ換金 ----------

  private static readonly DROP_MS = 3500; // カードを落としている(=公開されている)時間
  private dropTimers = new Map<string, { clear: () => void }>();

  /** 落下中の公開を終了する(指5本欠損の常時公開は対象外) */
  private endCardDrop(player: PlayerState, side: "left" | "right") {
    this.dropTimers.delete(player.id + ":" + side);
    const lost = side === "left" ? player.fingersLostLeft : player.fingersLostRight;
    if (lost >= 4) return;
    if (side === "left") player.publicCardLeft = "";
    else player.publicCardRight = "";
  }
  private clearDropTimers() {
    this.dropTimers.forEach((t) => t.clear());
    this.dropTimers.clear();
  }

  /**
   * 指を失った側は、アクションを選択する瞬間に確率でカードを卓に落とす(落ちている間だけ全員に見える)。
   * 確率(1〜3本欠損):1本5% / 2本15% / 3本30%。4〜5本欠損(と腕の喪失)は常時公開(指が2本以下ではカードを持てないため)なのでここでは判定しない。
   * 既に落ちている間は再判定しない。落ちたカードはDROP_MS後に拾い直されて非公開に戻る。
   */
  private checkFingerReveal(player: PlayerState) {
    const holeCards = this.holeCards.get(player.id);
    if (!holeCards) return;
    const probByCount: Record<number, number> = { 1: 0.05, 2: 0.15, 3: 0.3 };

    const sides: ("left" | "right")[] = ["left", "right"];
    for (const side of sides) {
      const lost = side === "left" ? player.fingersLostLeft : player.fingersLostRight;
      const current = side === "left" ? player.publicCardLeft : player.publicCardRight;
      if (current || lost < 1 || lost > 3) continue;
      if (Math.random() >= probByCount[lost]!) continue;
      const card = side === "left" ? holeCards[0]! : holeCards[1]!;
      if (side === "left") player.publicCardLeft = card;
      else player.publicCardRight = card;
      this.pushLog(`${player.name}が手を滑らせてカードを落とした(${side === "left" ? "左" : "右"})`);
      this.broadcast("cardDrop", { playerId: player.id, side, card, ms: PokerRoom.DROP_MS });
      const key = player.id + ":" + side;
      this.dropTimers.get(key)?.clear();
      this.dropTimers.set(key, this.clock.setTimeout(() => this.endCardDrop(player, side), PokerRoom.DROP_MS));
    }
  }

  /** 指が4〜5本無い側(腕を失った側を含む)は、確率判定なしで常にホールカードが公開される(このハンドに手札が配られている場合のみ即時反映) */
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
    const deny = (reason: string) => client.send("exchangeError", { reason });
    if (this.state.mode !== "lostfull") return deny("not_lostfull");
    if (!this.state.gameStarted || this.state.phase === "gameEnd") return deny("not_started");

    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    if (player.isSpectator) return deny("out");
    if (player.isDead) return deny("dead");
    if (player.isVegetative) return deny("vegetative");
    if (player.isBusted || player.isSurrendered) return deny("out");

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
        if (side !== "left" && side !== "right") return deny("invalid_side");
        const current = side === "left" ? player.fingersLostLeft : player.fingersLostRight;
        if (current >= 5) return;
        if (side === "left") player.fingersLostLeft++;
        else player.fingersLostRight++;
        chipGain = 20;
        stressGain = 3;
        label = `指(${side === "left" ? "左" : "右"})`;
        this.applyForcedFingerReveal(player, side);
        break;
      }
      case "tooth": {
        if (player.teethLost) return deny("already_lost");
        player.teethLost = true;
        chipGain = 200;
        stressGain = 10;
        label = "歯";
        break;
      }
      case "ear": {
        // 耳は左右同時に1回で換金(sideは無視)
        if (player.earsLostLeft || player.earsLostRight) return deny("already_lost");
        player.earsLostLeft = true;
        player.earsLostRight = true;
        chipGain = 140;
        stressGain = 20;
        label = "耳(両耳)";
        break;
      }
      case "lung": {
        if (side !== "left" && side !== "right") return deny("invalid_side");
        if (side === "left") {
          if (player.lungsLostLeft) return deny("already_lost");
          player.lungsLostLeft = true;
        } else {
          if (player.lungsLostRight) return deny("already_lost");
          player.lungsLostRight = true;
        }
        chipGain = 150;
        stressGain = 25;
        label = `肺(${side === "left" ? "左" : "右"})`;
        if (player.lungsLostLeft && player.lungsLostRight) causesDeath = true;
        break;
      }
      case "eye": {
        if (side !== "left" && side !== "right") return deny("invalid_side");
        if (side === "left") {
          if (player.eyesLostLeft) return deny("already_lost");
          player.eyesLostLeft = true;
        } else {
          if (player.eyesLostRight) return deny("already_lost");
          player.eyesLostRight = true;
        }
        chipGain = 250;
        stressGain = 15;
        label = `目(${side === "left" ? "左" : "右"})`;
        break;
      }
      case "arm": {
        if (side !== "left" && side !== "right") return deny("invalid_side");
        if (side === "left") {
          if (player.armsLostLeft) return deny("already_lost");
          player.armsLostLeft = true;
        } else {
          if (player.armsLostRight) return deny("already_lost");
          player.armsLostRight = true;
        }
        chipGain = 150;
        stressGain = 20;
        label = `腕(${side === "left" ? "左" : "右"})`;
        // 連鎖:その腕の指5本も同時に喪失(連鎖分のチップ・ストレスは加算しない)
        if (side === "left") player.fingersLostLeft = 5;
        else player.fingersLostRight = 5;
        this.applyForcedFingerReveal(player, side);
        break;
      }
      case "heart": {
        if (player.heartLost) return deny("already_lost");
        player.heartLost = true;
        chipGain = 400;
        stressGain = 0; // 心臓はストレス対象外
        label = "心臓";
        causesDeath = true;
        break;
      }
      default:
        return deny("unknown_part");
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

    if (this.state.phase === "needExchange") {
      this.checkNeedExchangeDone();
      return;
    }

    if ((causesDeath || newlyVegetative) && this.state.gameStarted && !player.folded) {
      player.folded = true;
      player.hasActed = true;
      player.lastAction = "fold";
      this.progressGame();
    }
  }

  // ---------- ロストフルモード:ロストイン(特殊技) ----------

  /** 残存する換金可能部位(心臓含む)の合計チップ換算額=「赤札」を計算する */
  private calculateRedCardAmount(player: PlayerState): number {
    let total = 0;
    total += (5 - player.fingersLostLeft) * 20 + (5 - player.fingersLostRight) * 20;
    if (!player.teethLost) total += 200;
    if (!player.earsLostLeft && !player.earsLostRight) total += 140;
    if (!player.lungsLostLeft) total += 150;
    if (!player.lungsLostRight) total += 150;
    if (!player.eyesLostLeft) total += 250;
    if (!player.eyesLostRight) total += 250;
    if (!player.armsLostLeft) total += 150;
    if (!player.armsLostRight) total += 150;
    if (!player.heartLost) total += 400; // ロストインは心臓も含む
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
    player.heartLost = true;
    player.isDead = true; // ロストイン実行者は勝敗に関わらず死亡

    player.totalRoundBet += amount;
    player.allIn = true;
    this.state.pot += amount;

    this.pushLog(`${player.name}がロストイン実行(${amount}チップ相当・死亡)`);
  }

  /** ロストイン宣言(赤札の提示のみ。この時点ではまだ何も失わない) */
  private declareLostIn(player: PlayerState) {
    const amount = this.calculateRedCardAmount(player);
    this.lostInCallers.clear();
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
    if (message.type !== "fold" && message.type !== "call" && message.type !== "lostin" && message.type !== "allin") {
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

    if (message.type === "call" || message.type === "allin") {
      // コール=赤札額(足りなければ全額)/オールイン=手持ちを全て賭ける。どちらもロストインへの応答として成立する
      if (message.type === "allin" && player.chips <= 0) {
        this.sendToPlayer(client.sessionId, "actionError", { reason: "no_chips" });
        return;
      }
      const payAmount = message.type === "allin" ? player.chips : Math.min(this.state.lostInAmount, player.chips);
      player.chips -= payAmount;
      player.totalRoundBet += payAmount;
      this.state.pot += payAmount;
      if (player.chips === 0) player.allIn = true;
      player.hasActed = true;
      player.lastAction = message.type === "allin" ? "allin" : "call";
      this.lostInCallers.add(player.id);
      this.pushLog(message.type === "allin" ? `${player.name}がロストインにオールインで応答(${payAmount}チップ)` : `${player.name}が赤札分をコール(${payAmount}チップ)`);

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
      if (!p.folded && !p.allIn && !this.lostInCallers.has(id)) {
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

  /**
   * チャット送信。target未指定(または"all")なら全体チャット(broadcast)、
   * 特定のsessionIdを指定すると個別チャット(送信者と受信者本人にしか届かない)。
   * 混沌の「宛先選択(全体/個別)」「全体は白文字・個別は青文字」の仕組みに合わせている。
   */
  private handleChat(client: Client, message: { target?: string; text?: string }) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const text = (message.text || "").slice(0, 200).trim();
    if (!text) return;

    const target = message.target || "all";

    if (target === "all") {
      this.broadcast("chat", {
        fromId: client.sessionId,
        fromName: player.name,
        text,
        isPrivate: false,
      });
      return;
    }

    const toPlayer = this.state.players.get(target);
    if (!toPlayer) return; // 存在しない宛先は無視

    const payload = {
      fromId: client.sessionId,
      fromName: player.name,
      text,
      isPrivate: true,
      toId: target,
      toName: toPlayer.name,
    };
    // 個別チャットは送信者と受信者のみに届ける
    this.sendToPlayer(client.sessionId, "chat", payload);
    if (target !== client.sessionId) {
      this.sendToPlayer(target, "chat", payload);
    }
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
    // 例外:オールインでも「コール扱い」(レイズにならない)ものは可能
    //  ・通常時: 手持ち全額を出しても現在のベット額に届かない/ちょうどのとき
    //  ・ロストイン応答時: 手持ちが赤札額以下のとき
    const nonRaisingAllIn =
      message.type === "allin" &&
      (this.state.lostInActive
        ? player.chips <= this.state.lostInAmount
        : player.currentBet + player.chips <= this.state.currentBet);
    if (
      armRestricted &&
      !nonRaisingAllIn &&
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
   * ルール:レイズに上限は設けない(最小は現在のBET額+SB、最大は自分のチップ残高まで)。
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

  private runoutTimer: any = null;

  /** 残り全員オールイン等でベット不要な場合、手札を公開し、コミュニティカードを段階的に開いてからショーダウン */
  private autoRunToShowdown() {
    this.actionTimeout?.clear();
    this.runoutTimer?.clear();
    this.state.actionPlayerId = "";
    // 緊張感のため、残っている全員の手札を先に公開
    for (const id of this.handParticipants) {
      const p = this.state.players.get(id)!;
      if (!p.folded && p.revealedHoleCards.length === 0) {
        const cards = this.holeCards.get(id);
        if (cards) p.revealedHoleCards.push(...cards);
      }
    }
    const STEP_MS = 3000;
    const step = () => {
      this.runoutTimer = null;
      if (this.state.phase === "river") {
        this.showdown();
        return;
      }
      if (!["preflop", "flop", "turn"].includes(this.state.phase)) return;
      this.dealNextStreetCards();
      this.runoutTimer = this.clock.setTimeout(step, STEP_MS);
    };
    this.runoutTimer = this.clock.setTimeout(step, 2000);
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
    this.state.phase = "judge";
    const remaining = this.handParticipants.filter((id) => !this.state.players.get(id)!.folded);
    const order = this.showdownOrder(remaining);

    const handInfos = order.map((id) => ({ playerId: id, holeCards: this.holeCards.get(id)! }));

    for (const id of order) {
      const p = this.state.players.get(id)!;
      const cards = this.holeCards.get(id)!;
      if (p.revealedHoleCards.length === 0) p.revealedHoleCards.push(...cards);
    }

    // ---- ジャッジのターン: 全員の役を照らし合わせて順位付けし、演出してから精算する ----
    const community0 = Array.from(this.state.communityCards) as string[];
    const rankOf: Record<string, number> = {};
    let pool = handInfos.slice();
    let rank = 1;
    while (pool.length > 0) {
      const top = determineWinners(pool, community0);
      for (const id of top) rankOf[id] = rank;
      pool = pool.filter((h) => !top.includes(h.playerId));
      rank++;
    }
    const judgeHands = order.map((id) => ({
      playerId: id,
      name: this.state.players.get(id)!.name,
      handName: evaluateHand(this.holeCards.get(id)!, community0).name,
      rank: rankOf[id],
    }));
    // 弱い順に1人ずつ発表 → 最後に勝者
    const judgeSteps = judgeHands.length;
    const JUDGE_STEP_MS = 1500;
    const JUDGE_INTRO_MS = 2200;
    const judgeMs = JUDGE_INTRO_MS + judgeSteps * JUDGE_STEP_MS + 1500;
    this.broadcast("judgeStart", { hands: judgeHands, stepMs: JUDGE_STEP_MS, introMs: JUDGE_INTRO_MS });
    this.pushLog("ジャッジ開始");
    this.runoutTimer?.clear();
    this.runoutTimer = this.clock.setTimeout(() => {
      this.runoutTimer = null;
      this.settleShowdown(order, handInfos);
    }, judgeMs);
  }

  private settleShowdown(order: string[], handInfos: { playerId: string; holeCards: string[] }[]) {
    if (this.state.phase !== "judge") return;
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
