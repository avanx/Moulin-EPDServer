import { Type, type Static } from "@sinclair/typebox";

export const HealthResponseSchema = Type.Object(
  {
    status: Type.Literal("ok"),
    database: Type.Literal("ok"),
    scheduler: Type.Boolean(),
    version: Type.String(),
    gitSha: Type.String(),
    buildTime: Type.String(),
  },
  { $id: "HealthResponse" },
);

export type HealthResponse = Static<typeof HealthResponseSchema>;
