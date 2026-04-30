import path from "node:path";

export const ROOT_DIR = process.cwd();
export const DATA_DIR = path.join(ROOT_DIR, "data");
export const COMPOSITIONS_DIR = path.join(ROOT_DIR, "compositions");
export const COMPONENTS_DIR = path.join(ROOT_DIR, "components");
export const SEED_COMPONENTS_DIR = path.join(COMPONENTS_DIR, "seed");
export const LIBRARY_PATH = path.join(DATA_DIR, "library.json");
export const RATINGS_PATH = path.join(DATA_DIR, "ratings.json");
export const VAULT_PATH = path.join(DATA_DIR, "vault.json");
