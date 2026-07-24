#!/usr/bin/env bash
set -euo pipefail
TARGET="${1:-.}"
SOURCE="$(cd "$(dirname "$0")" && pwd)"

if [[ ! -d "$TARGET/public" ]]; then
  echo "Error: $TARGET does not look like the SmartJobs repository root (public/ missing)." >&2
  exit 1
fi

cp "$SOURCE/public/app.html" "$TARGET/public/app.html"
cp "$SOURCE/public/smartjobs-app.css" "$TARGET/public/smartjobs-app.css"
cp "$SOURCE/public/smartjobs-app.js" "$TARGET/public/smartjobs-app.js"
cp "$SOURCE/public/smartjobs-auth-guard.js" "$TARGET/public/smartjobs-auth-guard.js"
cp "$SOURCE/public/smartjobs-entry-redirect.js" "$TARGET/public/smartjobs-entry-redirect.js"
cp "$SOURCE/public/smartjobs-shell.css" "$TARGET/public/smartjobs-shell.css"
cp "$SOURCE/public/smartjobs-shell.js" "$TARGET/public/smartjobs-shell.js"

python3 - "$TARGET" <<'PY'
from pathlib import Path
import sys
root=Path(sys.argv[1])

def inject_before(text, marker, block):
    if block.strip() in text:
        return text
    if marker not in text:
        raise RuntimeError(f"Missing {marker}")
    return text.replace(marker, block + "\n" + marker, 1)

protected=["candidate.html","hr.html","job-agent.html"]
for name in protected:
    p=root/"public"/name
    if not p.exists():
        print(f"Warning: {name} not found; skipped")
        continue
    text=p.read_text(encoding="utf-8")
    text=inject_before(text,"</head>",'''  <script src="/smartjobs-auth-guard.js?v=1.0.0"></script>\n  <link rel="stylesheet" href="/smartjobs-shell.css?v=1.0.0">''')
    scripts=[]
    if "accounts.google.com/gsi/client" not in text:
        scripts.append('  <script src="https://accounts.google.com/gsi/client" async defer></script>')
    if "recruiter-auth.js" not in text:
        scripts.append('  <script src="/recruiter-auth.js?v=1.0.0" defer></script>')
    if "smartjobs-shell.js" not in text:
        scripts.append('  <script src="/smartjobs-shell.js?v=1.0.0" defer></script>')
    if scripts:
        text=inject_before(text,"</body>","\n".join(scripts))
    p.write_text(text,encoding="utf-8")

index=root/"public"/"index.html"
if index.exists():
    text=index.read_text(encoding="utf-8")
    if "smartjobs-entry-redirect.js" not in text:
        text=inject_before(text,"</head>",'  <script src="/smartjobs-entry-redirect.js?v=1.0.0"></script>')
    index.write_text(text,encoding="utf-8")
PY

echo "Unified SmartJobs UI applied to $TARGET"
echo "New login entry: /app.html"
