/** Load ./.env (TRELLAI_DATABASE_URL and friends) before anything reads process.env. */
import { existsSync } from "node:fs";

// `npm start` passes --production instead of NODE_ENV=production, which cmd.exe (Maitre) can't run.
if (process.argv.includes("--production")) process.env.NODE_ENV = "production";

if (existsSync(".env") && !process.env.TRELLAI_NO_DOTENV) {
  try {
    process.loadEnvFile(".env");
  } catch (err) {
    console.warn("[trellai] no pude leer .env:", (err as Error).message);
  }
}
