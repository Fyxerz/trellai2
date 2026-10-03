/** Load ./.env (TRELLAI_DATABASE_URL and friends) before anything reads process.env. */
import { existsSync } from "node:fs";

if (existsSync(".env") && !process.env.TRELLAI_NO_DOTENV) {
  try {
    process.loadEnvFile(".env");
  } catch (err) {
    console.warn("[trellai] no pude leer .env:", (err as Error).message);
  }
}
