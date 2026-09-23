/**
 * ロストフルホールデム 共通クライアント接続モジュール。
 * room-create.html / room-join.html / table.html から読み込んで使う。
 *
 * ページ遷移(title→room-create→table)のたびにJSの実行コンテキストが
 * リセットされる(WebSocket接続が切れる)ため、sessionStorageに接続情報を保存し、
 * 次のページでは同じセッションに reconnect() して復帰する方式を取っている。
 * (サーバー側 PokerRoom.onLeave は60秒間の再接続猶予を与えるよう実装済み)
 */
window.LFH = (function () {
  // ▼▼▼ サーバーをRenderにデプロイしたら、ここを実際のURLに書き換えてください ▼▼▼
  // 例: "wss://lost-full-holdem-server.onrender.com"
  const SERVER_URL = "wss://lost-full-holdem-server.onrender.com";
  // ▲▲▲ ここまで ▲▲▲

  const SESSION_KEY = "lfh_session";
  let client = null;

  // Chromeなどのbfcache(ページ遷移時にページを「凍結」して裏で保持する機能)が働くと、
  // location.href で次のページへ移動してもWebSocket接続がすぐには切れず、
  // サーバー側のonLeave(再接続の受付開始)が数十秒遅れることがある。
  // ダミーのunloadリスナーを登録しておくと、ブラウザはbfcacheを使わず
  // ページ遷移時に確実に接続を即座に閉じるようになる。
  window.addEventListener("unload", function () {});

  function getClient() {
    if (!client) client = new Colyseus.Client(SERVER_URL);
    return client;
  }

  function saveSession(room) {
    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        roomId: room.roomId,
        sessionId: room.sessionId,
        reconnectionToken: room.reconnectionToken,
      })
    );
  }

  function loadSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function clearSession() {
    sessionStorage.removeItem(SESSION_KEY);
  }

  /** 新規にルームを作成する(GMがルーム作成画面に初めて入ったとき) */
  async function createRoom(options) {
    const room = await getClient().create("poker", options);
    saveSession(room);
    return room;
  }

  /** ルームID(Colyseus内部ID)を直接指定して参加する */
  async function joinRoom(roomId, options) {
    const room = await getClient().joinById(roomId, options);
    saveSession(room);
    return room;
  }

  /**
   * 4桁のルームコードを指定して参加する。
   * サーバーの各「poker」ルームはmetadata.codeにコードを持っているので、
   * 現在募集中のルーム一覧から一致するものを探し、そのColyseus内部roomIdでjoinする。
   * 該当が無い場合はエラーを投げる(呼び出し側でキャッチしてエラー表示すること)。
   */
  async function joinRoomByCode(code, options) {
    const rooms = await getClient().getAvailableRooms("poker");
    const match = rooms.find((r) => r.metadata && r.metadata.code === code);
    if (!match) {
      throw new Error("room not found for code: " + code);
    }
    return joinRoom(match.roomId, options);
  }

  /**
   * 直前のページで確立したセッションに復帰する。
   * 保存されたセッションが無い場合はnullを返す。
   * 再接続に失敗した場合は、最後に発生したエラーをそのままthrowする
   * (呼び出し側でエラー内容を確認できるようにするため。誰にも見えない失敗にしない)。
   * ページ遷移直後の一瞬のタイミングのズレに備え、間隔を空けながら複数回リトライする。
   */
  async function reconnectRoom() {
    const session = loadSession();
    if (!session) return null;

    const delays = [300, 600, 1000, 1500, 2000]; // 合計約5.4秒粘る
    let lastError = null;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        const room = await getClient().reconnect(session.reconnectionToken);
        saveSession(room); // reconnectionTokenは使い回しではなく都度更新されるため保存し直す
        return room;
      } catch (e) {
        lastError = e;
        console.warn('[LFH] reconnect attempt failed:', e);
        if (attempt < delays.length) {
          await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
        }
      }
    }
    clearSession();
    throw lastError || new Error('reconnect failed with unknown error');
  }

  return {
    getClient,
    createRoom,
    joinRoom,
    joinRoomByCode,
    reconnectRoom,
    saveSession,
    loadSession,
    clearSession,
  };
})();
