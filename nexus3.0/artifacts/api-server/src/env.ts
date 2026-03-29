/**
 * Load `.env` before the rest of the app (ESM import order).
 * Tries `Nexus3,0/.env` then `nexus3.0/.env` relative to this file.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));

config({ path: resolve(__dirname, "../../../../.env") });
config({ path: resolve(__dirname, "../../../.env") });

/**
 * Default API port. Parent shells (IDEs) sometimes set PORT=5173 for Vite; never bind the API to that.
 */
if (
  process.env.PORT === undefined ||
  process.env.PORT === "" ||
  process.env.PORT === "5173"
) {
  process.env.PORT = "8080";
}
