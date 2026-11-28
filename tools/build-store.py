#!/usr/bin/env python3
"""Make the Chrome Web Store package.

    python3 tools/build-store.py OUT.zip

It differs from this folder in two ways. The website's sign-in and Google's file
picker are left out, as the store doesn't allow code from other sites. The manifest has no key, as the store
gives the extension its own ID, and CLIENT_ID is the OAuth client made for that ID.
"""
import json, re, sys, zipfile
from pathlib import Path

# for amidicalcieolbecimlogomhnokopigp, its ID in the store
CLIENT_ID = '719894949389-d5vjqvhj7iv0du78j9ml0cf8s783niso.apps.googleusercontent.com'

ROOT = Path(__file__).resolve().parent.parent
FILES = ['index.html', 'style.css', 'jquery.js', 'script.js', 'tasks.js', 'shared.js', 'supabase.js', 'cloud.js',
         'icons/logo.svg', 'icons/LICENSE-material-symbols.txt', 'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png',
         'app.webmanifest', 'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png']


def extension_auth():
    # Without the website's sign-in, which loads Google's script from another site.
    # CLIENT_ID stays: added accounts sign in through it, on Google's page for extensions.
    text = (ROOT / 'auth.js').read_text()
    start = text.index("// Google gives a website a token that lasts an hour")
    end = text.index('var auth = ')
    text = text[:start] + 'var auth = extensionAuth();\n'
    assert end > start and 'gsi/client' not in text and 'webAuth' not in text
    return text


def extension_page():
    # The same page: Tab & Tick's server (supabase.js, cloud.js) keeps shared lists in
    # the extension too, though Chrome keeps it signed in
    return (ROOT / 'index.html').read_text()


def main():
    out = Path(sys.argv[1])
    manifest = json.loads((ROOT / 'manifest.json').read_text())
    del manifest['key']
    manifest['oauth2']['client_id'] = CLIENT_ID
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('manifest.json', json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')
        z.writestr('auth.js', extension_auth())
        z.writestr('index.html', extension_page())
        for name in FILES:
            if name == 'index.html':
                continue
            z.write(ROOT / name, name)
    print(out, manifest['version'], manifest['oauth2']['client_id'])


main()
