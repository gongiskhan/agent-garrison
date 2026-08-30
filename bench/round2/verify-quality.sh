#!/usr/bin/env bash
# Quality + scope, measured, nothing fixed. Split from the port/endpoint drive
# so it can run while another benchmark conversation holds port 3000.
#   usage: verify-quality.sh <dir> <label> <outfile>
set -u
DIR="$1"; LABEL="$2"; OUT="$3"
exec > >(tee "$OUT") 2>&1
echo "=================================================================="
echo "QUALITY + SCOPE — $LABEL"
echo "dir: $DIR"
echo "=================================================================="
cd "$DIR" || { echo "FATAL: no such directory"; exit 1; }
section() { echo; echo "------------------------------------------------------------------"; echo "## $1"; echo "------------------------------------------------------------------"; }

section "scope: what was produced"
find . -type f -not -path './.git/*' -not -path './node_modules/*' -not -path './dist/*' -not -name 'package-lock.json' | sort
echo; echo -n "file count: "
find . -type f -not -path './.git/*' -not -path './node_modules/*' -not -path './dist/*' -not -name 'package-lock.json' | wc -l
echo "lines of source (.ts/.js/.tsx):"
find . -type f \( -name '*.ts' -o -name '*.js' -o -name '*.tsx' \) -not -path './node_modules/*' -not -path './dist/*' -exec wc -l {} + | tail -1
echo "lines of TEST source:"
find . -type f \( -name '*.test.ts' -o -name '*.spec.ts' -o -name '*.test.js' \) -not -path './node_modules/*' -not -path './dist/*' -exec wc -l {} + | tail -1
echo
echo "dependencies declared:"
python3 -c "
import json
p=json.load(open('package.json'))
d=p.get('dependencies',{}); dev=p.get('devDependencies',{})
print('  runtime :', len(d), sorted(d))
print('  dev     :', len(dev), sorted(dev))
print('  total   :', len(d)+len(dev))
print('  scripts :', p.get('scripts'))
"
echo -n "packages installed (node_modules top level): "
ls node_modules 2>/dev/null | grep -v '^\.' | wc -l

section "npm install"
npm install --no-audit --no-fund 2>&1 | tail -8
echo "npm install exit: ${PIPESTATUS[0]}"

section "npm test"
npm test 2>&1 | tail -40
echo "npm test exit: ${PIPESTATUS[0]}"

section "typescript strict compile"
python3 -c "
import json,re
raw=open('tsconfig.json').read()
raw=re.sub(r'//.*','',raw); raw=re.sub(r'/\*.*?\*/','',raw,flags=re.S)
print('  strict =', json.loads(raw).get('compilerOptions',{}).get('strict'))
"
npx --no-install tsc --noEmit 2>&1 | tail -20
echo "tsc exit: ${PIPESTATUS[0]}"

section "README"
sed -n '1,25p' README.md 2>/dev/null || echo "(no README.md)"
echo; echo "END — $LABEL"
