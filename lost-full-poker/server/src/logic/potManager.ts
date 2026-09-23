export interface PotContribution {
  playerId: string;
  totalRoundBet: number; // このハンドでの投入合計額
  folded: boolean;
}

export interface PotLayer {
  amount: number;
  eligiblePlayerIds: string[];
}

/**
 * 各プレイヤーの投入額からメインポット+サイドポットを計算する。
 * フォールドしたプレイヤーの投入額もポットの金額には含まれるが、
 * 受け取り資格(eligiblePlayerIds)には含めない。
 *
 * アルゴリズム:投入額の水準ごとに層を作り、各層をその水準以上投入した
 * (かつフォールドしていない)プレイヤーで分け合う形にする。
 */
export function calculatePots(contributions: PotContribution[]): PotLayer[] {
  const withMoney = contributions.filter((c) => c.totalRoundBet > 0);
  if (withMoney.length === 0) return [];

  const levels = Array.from(new Set(withMoney.map((c) => c.totalRoundBet))).sort(
    (a, b) => a - b
  );

  const layers: PotLayer[] = [];
  let prevLevel = 0;

  for (const level of levels) {
    const layerContributors = withMoney.filter((c) => c.totalRoundBet >= level);
    const amount = (level - prevLevel) * layerContributors.length;
    const eligible = layerContributors.filter((c) => !c.folded).map((c) => c.playerId);

    if (amount > 0 && eligible.length > 0) {
      layers.push({ amount, eligiblePlayerIds: eligible });
    }
    prevLevel = level;
  }

  return layers;
}

/**
 * ポット1層を勝者間で分配する。割り切れない場合は先頭(アクション順で先の勝者)に
 * 端数を寄せる(標準的なポーカーの端数処理に準拠)。
 * winnerIdsは呼び出し側で「そのポットの資格者の中での勝者」に絞り込んだ状態で渡すこと。
 */
export function splitPot(amount: number, winnerIds: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  const base = Math.floor(amount / winnerIds.length);
  let remainder = amount - base * winnerIds.length;

  for (const id of winnerIds) {
    result[id] = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder--;
  }
  return result;
}
