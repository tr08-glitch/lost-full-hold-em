declare module "pokersolver" {
  export class Hand {
    cards: any[];
    name: string;
    rank: number;
    descr: string;
    static solve(cards: string[], game?: string): Hand;
    static winners(hands: Hand[]): Hand[];
  }
}
