#!/usr/bin/env python3
"""Make the Chrome Web Store package.

    python3 tools/build-store.py OUT.zip [CLIENT_ID]

It differs from this folder in two ways. The website's sign-in is left out, as the
store doesn't allow code from other sites. The manifest has no key, as the store
gives the extension its own ID; CLIENT_ID is the OAuth client made for that ID.
"""
import json, re, sys, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = ['index.html', 'style.css', 'jquery.js', 'script.js', 'tasks.js',
         'icons/logo.svg', 'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png']


def extension_auth():
    text = (ROOT / 'auth.js').read_text()
    start = text.index("// Google's token lasts about an hour.")
    end = text.index('var auth = ')
    text = text[:start] + 'var auth = extensionAuth();\n'
    text = re.sub(r"var CLIENT_ID = .*\n", '', text)
    text = re.sub(r"\A(?://.*\n)+", "// Signing in to Google, which Chrome does. done is called with true or false, and\n// the reason if false.\n", text)
    text = re.sub(r"var SCOPE = .*\n", '', text)
    assert end > start and 'accounts.google.com' not in text and 'webAuth' not in text
    return text


def main():
    out = Path(sys.argv[1])
    manifest = json.loads((ROOT / 'manifest.json').read_text())
    del manifest['key']
    if len(sys.argv) > 2:
        manifest['oauth2']['client_id'] = sys.argv[2]
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('manifest.json', json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')
        z.writestr('auth.js', extension_auth())
        for name in FILES:
            z.write(ROOT / name, name)
    print(out, manifest['version'], manifest['oauth2']['client_id'])


main()
