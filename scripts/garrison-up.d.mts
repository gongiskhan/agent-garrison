// Type declaration for the garrison-up CLI's pure, testable arg parser. The CLI
// itself is an .mjs (it must run under plain `node` before re-execing under tsx),
// so this sits beside it to give TypeScript importers (the unit test) types
// without turning on allowJs.
export function parseGarrisonUpArgs(argv: string[]): { composition: string | null; help: boolean };
