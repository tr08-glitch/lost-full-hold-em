import { Hand } from "pokersolver";
import { isJokerCode } from "./deck";

export interface EvaluatedHand {
  playerId: string;
  hand: Hand; // pokersolverのHandオブジェクト(name, descr, rankなどを持つ)
}

const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const SUITS = ["s", "h", "d", "c"];
const ALL_STANDARD_CARDS: string[] = (() => {
  const arr: string[] = [];
  for (const r of RANKS) for (const s of SUITS) arr.push(r + s);
  return arr;
})();

/** candidateがcurrentと同等以上に強いか(pokersolver自身の比較ロジックに委ねる) */
function isAtLeastAsGood(candidate: Hand, current: Hand | null): boolean {
  if (!current) return true;
  const winners = Hand.winners([candidate, current]);
  return winners.includes(candidate);
}

/**
 * ジョーカー(完全ワイルドカード)を含む手を評価する。
 * ジョーカーを実際に場にある他のカードと重複しない標準カードに総当たりで置き換え、
 * そのプレイヤーにとって最も強くなる組み合わせを採用する。
 * ジョーカーは最大2枚想定(それ以上は現実的な組み合わせ数を超えるため非対応)。
 */
function evaluateWithWildcards(cards: string[], jokerIndexes: number[]): Hand {
  const usedStandardCards = new Set(cards.filter((_, i) => !jokerIndexes.includes(i)));
  let best: Hand | null = null;

  function tryReplacement(replacement: string[]) {
    const trial = cards.slice();
    jokerIndexes.forEach((idx, k) => {
      trial[idx] = replacement[k];
    });
    const hand = Hand.solve(trial);
    if (isAtLeastAsGood(hand, best)) best = hand;
  }

  if (jokerIndexes.length === 1) {
    for (const c of ALL_STANDARD_CARDS) {
      if (usedStandardCards.has(c)) continue;
      tryReplacement([c]);
    }
  } else {
    // 2枚のジョーカー: 総当たり(52×51通り程度、サーバー負荷としては軽微)
    for (const c1 of ALL_STANDARD_CARDS) {
      if (usedStandardCards.has(c1)) continue;
      for (const c2 of ALL_STANDARD_CARDS) {
        if (c2 === c1 || usedStandardCards.has(c2)) continue;
        tryReplacement([c1, c2]);
      }
    }
  }

  return best as unknown as Hand;
}

/**
 * ホールカード2枚 + コミュニティカード5枚(計7枚)から最善の5枚役を評価する。
 * pokersolverが7枚の中から自動で最善の組み合わせを選んでくれる。
 * ジョーカーが含まれる場合は完全ワイルドカードとして解決してから評価する。
 */
export function evaluateHand(holeCards: string[], communityCards: string[]): Hand {
  const all = [...holeCards, ...communityCards];
  const jokerIndexes = all.map((c, i) => (isJokerCode(c) ? i : -1)).filter((i) => i >= 0);
  if (jokerIndexes.length === 0) {
    return Hand.solve(all);
  }
  return evaluateWithWildcards(all, jokerIndexes);
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
