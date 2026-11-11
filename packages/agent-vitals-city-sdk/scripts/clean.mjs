import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
await rm(`${packageRoot}/dist`, { recursive: true, force: true });
