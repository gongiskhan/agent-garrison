import path from "node:path";

export const ROOT_DIR = process.cwd();
export const DATA_DIR = path.join(ROOT_DIR, "data");
export const COMPOSITIONS_DIR = path.join(ROOT_DIR, "compositions");
export const FITTINGS_DIR = path.join(ROOT_DIR, "fittings");
export const SEED_FITTINGS_DIR = path.join(FITTINGS_DIR, "seed");
export const LIBRARY_PATH = path.join(DATA_DIR, "library.json");
export const RATINGS_PATH = path.join(DATA_DIR, "ratings.json");
export const VAULT_PATH = path.join(DATA_DIR, "vault.json");
