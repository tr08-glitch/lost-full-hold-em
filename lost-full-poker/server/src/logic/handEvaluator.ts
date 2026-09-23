import { Hand } from "pokersolver";

export interface EvaluatedHand {
  playerId: string;
  hand: Hand; // pokersolverのHandオブジェクト(name, descr, rankなどを持つ)
}

/**
 * ホールカード2枚 + コミュニティカード5枚(計7枚)から最善の5枚役を評価する。
 * pokersolverが7枚の中から自動で最善の組み合わせを選んでくれる。
 */
export function evaluateHand(holeCards: string[], communityCards: string[]): Hand {
  const all = [...holeCards, ...communityCards];
  return Hand.solve(all);
}

/**
 * 複数プレイヤーの手札から勝者(複数=引き分けの可能性あり)を判定する。
 * 戻り値は勝者のplayerIdの配列(1人なら単独勝利、2人以上ならスプリット)。
 */
export function determineWinners(
  hands: { playerId: string; holeCards: string[] }[],
  communityCards: string[]
): string[] {
  const evaluated: EvaluatedHand[] = hands.map((h) => ({
    playerId: h.playerId,
    hand: evaluateHand(h.holeCards, communityCards),
  }));

  const winningHands = Hand.winners(evaluated.map((e) => e.hand));

  // winningHandsに含まれるHandオブジェクトと同じものを持つプレイヤーを探す
  const winnerIds: string[] = [];
  for (const e of evaluated) {
    if (winningHands.includes(e.hand)) {
      winnerIds.push(e.playerId);
    }
  }
  return winnerIds;
}
