import xterm from "@xterm/headless";

// Claude renders spaces and line breaks with cursor movements. Removing ANSI
// sequences joins the token to the following "Store" instruction. Read the
// actual terminal cells instead, joining only the terminal's soft wraps.
export class SetupTokenOutput {
  constructor({ cols = 200, rows = 50 } = {}) {
    this.term = new xterm.Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
  }

  write(chunk) {
    return new Promise((resolve) => this.term.write(chunk, resolve));
  }

  text() {
    const buffer = this.term.buffer.active;
    let text = "";
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (i > 0 && !line.isWrapped) text += "\n";
      // Keep the last cell of a soft-wrapped line: it may be a real space.
      const wraps = buffer.getLine(i + 1)?.isWrapped;
      text += line.translateToString(!wraps);
    }
    return text.trimEnd();
  }

  token({ exitedSuccessfully = false } = {}) {
    const text = this.text();
    // A PTY chunk can stop anywhere in the token. Wait for the completion
    // instructions (or successful CLI exit), never the first matching prefix.
    if (!exitedSuccessfully && !/Store this token securely|Use this token by setting/.test(text)) {
      return null;
    }
    return text.match(/\bsk-ant-oat01-[A-Za-z0-9_-]{20,}(?=\s|$)/)?.[0] ?? null;
  }

  redactedText() {
    // Redact even a partial prefix while the token is still being printed.
    return this.text().replace(/sk-ant-[A-Za-z0-9_-]*/g, "sk-ant-…redacted…");
  }

  dispose() {
    this.term.dispose();
  }
}
