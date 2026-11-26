#!/usr/bin/env python3
"""Make the Chrome Web Store package.

    python3 tools/build-store.py OUT.zip

It differs from this folder in two ways. The website's sign-in is left out, as the
store doesn't allow code from other sites. The manifest has no key, as the store
gives the extension its own ID, and CLIENT_ID is the OAuth client made for that ID.
"""
import json, re, sys, zipfile
from pathlib import Path

# for amidicalcieolbecimlogomhnokopigp, its ID in the store
CLIENT_ID = '719894949389-d5vjqvhj7iv0du78j9ml0cf8s783niso.apps.googleusercontent.com'

ROOT = Path(__file__).resolve().parent.parent
FILES = ['index.html', 'style.css', 'jquery.js', 'script.js', 'tasks.js', 'shared.js',
         'icons/logo.svg', 'icons/LICENSE-material-symbols.txt', 'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png']


def extension_auth():
    text = (ROOT / 'auth.js').read_text()
    start = text.index("// Google's token lasts about an hour.")
    end = text.index('var auth = ')
    text = text[:start] + 'var auth = extensionAuth();\n'
    text = re.sub(r"var CLIENT_ID = .*\n", '', text)
    text = re.sub(r"\A(?://.*\n)+", "// Signing in to Google, which Chrome does. done is called with true or false, and\n// the reason if false.\n", text)
    text = re.sub(r"(// Your name.*\n)?var SCOPES? = .*\n", '', text)
    text = re.sub(r"// Only the files Tab & Tick makes.*\nvar DRIVE = .*\n", '', text)
    assert end > start and 'accounts.google.com' not in text and 'webAuth' not in text and 'SCOPE' not in text
    return text


def extension_shared():
    # Google's file picker is a script from another site, which the store doesn't
    # allow, and the extension doesn't open shared lists yet anyway
    text = (ROOT / 'shared.js').read_text()
    start = text.index('  var pickerReady')
    end = text.index('  return self;')
    text = text[:start] + "  function pick() {\n    showMessage('Shared lists open on the website: tabandtick.github.io/app', null, null, 8000);\n  }\n\n" + text[end:]
    assert 'apis.google.com' not in text and 'gapi' not in text
    return text


def main():
    out = Path(sys.argv[1])
    manifest = json.loads((ROOT / 'manifest.json').read_text())
    del manifest['key']
    manifest['oauth2']['client_id'] = CLIENT_ID
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('manifest.json', json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')
        z.writestr('auth.js', extension_auth())
        z.writestr('shared.js', extension_shared())
        for name in FILES:
            if name == 'shared.js':
                continue
            z.write(ROOT / name, name)
    print(out, manifest['version'], manifest['oauth2']['client_id'])


main()
