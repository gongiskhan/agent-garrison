// A small, deterministic, dependency-free syntax highlighter.
//
// WHY NOT SHIKI. The brief names Shiki and diff2html as "candidate libraries",
// not requirements. Taking them would mean adding two root devDependencies plus a
// committed ~2 MB esbuild bundle inside the seed tree, and the seed tree is
// exactly where the setup-cwd-vs-runtime-cwd bug makes committed build output
// fragile. What the viewer actually needs is line gutters, per-line highlight
// classes, and token colours — a few hundred lines of regex. Zero dependencies
// means zero network at render time and nothing to re-bundle on a version bump.
//
// SAFETY. Text is HTML-escaped before any markup is added, and tokens are only
// ever wrapped in <span class="tok-*">. There is no path by which file content or
// model-authored text becomes live markup.
//
// Pure: same input always yields byte-identical output. The test suite depends on
// that, because "re-rendering is free" is only true if it is also reproducible.

export function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const KEYWORDS = new Set([
  "abstract", "as", "async", "await", "break", "case", "catch", "class", "const",
  "constructor", "continue", "debugger", "declare", "default", "delete", "do",
  "else", "enum", "export", "extends", "false", "finally", "for", "from",
  "function", "get", "if", "implements", "import", "in", "instanceof",
  "interface", "is", "keyof", "let", "namespace", "new", "null", "of",
  "private", "protected", "public", "readonly", "return", "satisfies", "set",
  "static", "super", "switch", "this", "throw", "true", "try", "type", "typeof",
  "undefined", "var", "void", "while", "yield",
]);

const SH_KEYWORDS = new Set([
  "case", "do", "done", "elif", "else", "esac", "fi", "for", "function", "if",
  "in", "local", "return", "then", "until", "while", "export", "source", "set",
  "echo", "cd", "mkdir", "rm", "cp", "mv", "exit", "test",
]);

const TYPES = new Set([
  "Array", "Boolean", "Buffer", "Date", "Error", "Map", "Number", "Object",
  "Promise", "RegExp", "Set", "String", "Symbol", "any", "bigint", "boolean",
  "never", "number", "object", "string", "symbol", "unknown",
]);

/**
 * Tokenise one line. Line-scoped by design: no highlighter state crosses a line
 * boundary, which keeps a windowed sample (which may start mid-block-comment)
 * from mis-colouring everything after it. The cost is that a multi-line comment's
 * body is not tinted; that is a fair trade for slice-independence.
 */
export function tokenizeLine(line, lang = "ts") {
  const tokens = [];
  const src = String(line ?? "");
  const isSh = lang === "sh";
  const isYaml = lang === "yaml";
  const isJson = lang === "json";
  const hashComments = isSh || isYaml || lang === "toml";
  const keywords = isSh ? SH_KEYWORDS : KEYWORDS;

  let i = 0;
  let pending = "";
  const flush = () => {
    if (pending) {
      tokens.push({ type: "plain", text: pending });
      pending = "";
    }
  };
  const push = (type, text) => {
    flush();
    tokens.push({ type, text });
  };

  while (i < src.length) {
    const rest = src.slice(i);

    if (hashComments) {
      const hash = /^#.*$/.exec(rest);
      if (hash) {
        push("comment", hash[0]);
        i += hash[0].length;
        continue;
      }
    }
    if (!isJson && !isYaml && !isSh) {
      const line2 = /^\/\/.*$/.exec(rest);
      if (line2) {
        push("comment", line2[0]);
        i += line2[0].length;
        continue;
      }
      const block = /^\/\*[\s\S]*?(\*\/|$)/.exec(rest);
      if (block) {
        push("comment", block[0]);
        i += block[0].length;
        continue;
      }
    }

    const str = /^(?:"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\.)*`?)/.exec(rest);
    if (str && str[0].length > 0) {
      push("string", str[0]);
      i += str[0].length;
      continue;
    }

    if (isYaml) {
      // A leading key is the most useful thing to colour in a manifest.
      const key = /^(\s*)([A-Za-z0-9_.-]+)(\s*:)/.exec(rest);
      if (key && i === 0) {
        pending += key[1];
        push("property", key[2]);
        push("punct", key[3]);
        i += key[0].length;
        continue;
      }
    }

    const num = /^(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(rest);
    if (num) {
      push("number", num[0]);
      i += num[0].length;
      continue;
    }

    if (isSh) {
      const varRef = /^\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|\d+)/.exec(rest);
      if (varRef) {
        push("variable", varRef[0]);
        i += varRef[0].length;
        continue;
      }
    }

    const word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest);
    if (word) {
      const w = word[0];
      const after = src.slice(i + w.length);
      if (isJson || isYaml) {
        if (/^\s*:/.test(after)) push("property", w);
        else if (w === "true" || w === "false" || w === "null") push("keyword", w);
        else push("plain", w);
      } else if (keywords.has(w)) {
        push("keyword", w);
      } else if (TYPES.has(w)) {
        push("type", w);
      } else if (/^\s*\(/.test(after)) {
        push("fn", w);
      } else if (/^[A-Z]/.test(w)) {
        push("type", w);
      } else {
        pending += w;
      }
      i += w.length;
      continue;
    }

    const punct = /^[{}()[\].,;:=+\-*/%<>!?&|^~]+/.exec(rest);
    if (punct) {
      push("punct", punct[0]);
      i += punct[0].length;
      continue;
    }

    pending += src[i];
    i += 1;
  }
  flush();
  return tokens;
}

/** Tokenise then escape, producing the inner HTML of one line. */
export function highlightLine(line, lang = "ts") {
  const tokens = tokenizeLine(line, lang);
  let out = "";
  for (const t of tokens) {
    const escaped = escapeHtml(t.text);
    out += t.type === "plain" ? escaped : `<span class="tok-${t.type}">${escaped}</span>`;
  }
  return out;
}

/**
 * Render a code sample as a table of numbered lines.
 *
 * `startLine` is the absolute file line of the first line of `text`, so the
 * gutter shows real file coordinates and `highlights` (also absolute) line up
 * without translation. Each row carries data-line so an agent can jump straight
 * to a location, per the brief's agent-readability requirement.
 */
export function renderCodeBlock(text, { startLine = 1, lang = "ts", highlights = [], file = "" } = {}) {
  const lines = String(text ?? "").split("\n");
  const rows = lines
    .map((line, i) => {
      const lineNo = startLine + i;
      const hit = highlights.some((p) => Array.isArray(p) && lineNo >= p[0] && lineNo <= p[1]);
      const cls = hit ? "code-line is-highlight" : "code-line";
      return (
        `<tr class="${cls}" data-line="${lineNo}">` +
        `<td class="ln" aria-hidden="true">${lineNo}</td>` +
        `<td class="lc"><code>${highlightLine(line, lang) || "&nbsp;"}</code></td>` +
        `</tr>`
      );
    })
    .join("");
  return (
    `<table class="code" data-file="${escapeHtml(file)}" data-start-line="${startLine}" ` +
    `data-end-line="${startLine + Math.max(lines.length - 1, 0)}" ` +
    `data-lang="${escapeHtml(lang)}"><tbody>${rows}</tbody></table>`
  );
}
