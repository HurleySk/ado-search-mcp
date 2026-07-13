import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface AdoSearchConfig {
  dataDir: string;
  adoSearchPath: string;
}

function readConfigFile(path: string): AdoSearchConfig {
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  if (!raw.dataDir || typeof raw.dataDir !== "string") {
    throw new Error(`Config file ${path} missing required "dataDir" string`);
  }
  return {
    dataDir: raw.dataDir,
    adoSearchPath: raw.adoSearchPath ?? "ado-search",
  };
}

export function loadConfig(): AdoSearchConfig {
  if (process.env.ADO_SEARCH_CONFIG) {
    return readConfigFile(process.env.ADO_SEARCH_CONFIG);
  }

  const serverDir = dirname(fileURLToPath(import.meta.url));
  const sidecar = join(serverDir, "..", "ado-search-mcp.json");
  if (existsSync(sidecar)) {
    return readConfigFile(sidecar);
  }

  if (process.env.ADO_DATA_DIR) {
    return {
      dataDir: process.env.ADO_DATA_DIR,
      adoSearchPath: "ado-search",
    };
  }

  throw new Error(
    "No config found. Set ADO_SEARCH_CONFIG env var, place ado-search-mcp.json next to the server, or set ADO_DATA_DIR.",
  );
}
