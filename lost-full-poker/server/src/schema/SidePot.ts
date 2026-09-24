import { Schema, type, ArraySchema } from "@colyseus/schema";

/**
 * サイドポット1個分の情報。
 * eligiblePlayerIds: このポットを獲得する権利があるプレイヤーのid一覧
 * (オールインした額に応じて複数のサイドポットに分割される)
 */
export class SidePot extends Schema {
  @type("number") amount: number = 0;
  @type(["string"]) eligiblePlayerIds = new ArraySchema<string>();
}
