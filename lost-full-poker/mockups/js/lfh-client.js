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
   * 保存されたセッションが無い、または再接続に失敗した場合はnullを返す
   * (呼び出し側はtitle.htmlへ戻すなどのフォールバック処理を行うこと)
   */
  async function reconnectRoom() {
    const session = loadSession();
    if (!session) return null;
    try {
      const room = await getClient().reconnect(session.reconnectionToken);
      saveSession(room); // reconnectionTokenは使い回しではなく都度更新されるため保存し直す
      return room;
    } catch (e) {
      clearSession();
      return null;
    }
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
