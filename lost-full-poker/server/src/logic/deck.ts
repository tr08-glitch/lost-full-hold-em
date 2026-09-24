/**
 * 山札管理。
 * カードは "As", "Th", "9d", "2c" のような rank+suit の2文字表記(pokersolverの形式に合わせる)。
 * rank: A,K,Q,J,T,9,8,7,6,5,4,3,2 / suit: s,h,d,c
 *
 * ジョーカーは "JOKER1","JOKER2",... という専用の表記(通常カードと衝突しない)。
 * 役判定上は完全ワイルドカードとして扱う(server/src/logic/handEvaluator.ts側で解決する)。
 */

const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const SUITS = ["s", "h", "d", "c"];

export function isJokerCode(code: string): boolean {
  return code.startsWith("JOKER");
}

export class Deck {
  private cards: string[] = [];
  private discardPile: string[] = [];

  constructor(jokerCount: number = 0) {
    this.reset(jokerCount);
  }

  /** 標準52枚(+指定枚数のジョーカー)を作り直してシャッフルする(使用済み含め全て回収) */
  reset(jokerCount: number = 0): void {
    this.cards = [];
    for (const r of RANKS) {
      for (const s of SUITS) {
        this.cards.push(r + s);
      }
    }
    for (let i = 1; i <= jokerCount; i++) {
      this.cards.push("JOKER" + i);
    }
    this.discardPile = [];
    this.shuffle();
  }

  shuffle(): void {
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
    }
  }

  /** 残り枚数が足りない場合は使用済みカード置き場を回収してシャッフルし直す */
  ensureAvailable(count: number): void {
    if (this.cards.length < count) {
      this.cards = this.cards.concat(this.discardPile);
      this.discardPile = [];
      this.shuffle();
    }
  }

  draw(count: number): string[] {
    this.ensureAvailable(count);
    const drawn = this.cards.splice(0, count);
    return drawn;
  }

  /** ラウンド終了時、場に出ていたカードを使用済み置き場へ移動 */
  discard(cards: string[]): void {
    this.discardPile.push(...cards);
  }

  get remaining(): number {
    return this.cards.length;
  }

  get discarded(): number {
    return this.discardPile.length;
  }
}
