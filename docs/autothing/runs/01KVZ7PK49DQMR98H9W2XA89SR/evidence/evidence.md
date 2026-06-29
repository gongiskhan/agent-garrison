# Evidence — Rename Automatizar label

## What changed

**File:** `~/dev/ekoa-site/index.html` line 361

```diff
-            motor escolhido: Automatizar
+            motor escolhido: Automático
```

## Verification

```bash
$ grep -c 'motor escolhido: Automatizar' ~/dev/ekoa-site/index.html
0   # old text absent

$ grep -c 'motor escolhido: Automático' ~/dev/ekoa-site/index.html
1   # new text present

$ python3 -c "from html.parser import HTMLParser; V=HTMLParser(); V.feed(open('index.html').read()); print('ok')"
ok  # HTML parses cleanly
```

## Screenshot

`after.png` — ekoa home page rendered via `http://localhost:7301/`.
The hero composer section shows `motor escolhido: Automático` with accent.
