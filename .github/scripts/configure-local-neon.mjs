import { neonConfig } from "../../packages/persistence/node_modules/@neondatabase/serverless/index.mjs";

const databaseUrl = new URL(process.env.DATABASE_URL);
if (databaseUrl.hostname !== "db.localtest.me") {
  throw new Error("The local Neon proxy preload requires DATABASE_URL host db.localtest.me");
}

neonConfig.fetchEndpoint = "http://db.localtest.me:4444/sql";
neonConfig.useSecureWebSocket = false;
neonConfig.wsProxy = "db.localtest.me:4444/v1";
