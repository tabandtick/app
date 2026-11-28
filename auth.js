// Signing in to Google. In the Chrome extension, Chrome does it; on the website,
// Google's script does. Each way offers the same five functions:
//   silent(done)   sign in without asking      login(done)  ask if need be
//   expired(done)  replace a refused token     token()      the token, or null
//   logout()       forget the token
// and, on the website, renew() and hint(email): see below. For more than one account:
//   canSwitch      whether it can be done here
//   remember(email)  keep the token as this account's   use(email, done)  switch to it
//   add(done)      ask Google for another account       forget(email)
// For shared lists:
//   canShare       whether they can be used here
//   cloudSession(email, interactive, done)  in the extension: a session with Tab &
//                  Tick's server, for lists kept there (the website gets one on login)
//   allowServer(email, done)  ask Google to let the server keep shared lists in this
//                  account's Google Tasks while you're away: done(ok)
// done is called with true or false, and the reason if false.

var SCOPE = 'https://www.googleapis.com/auth/tasks';
// Your name, email and picture, for the account button
var SCOPES = SCOPE + ' https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email';
var CLIENT_ID = '719894949389-8mfcps2du7nup1g0a14nfniul2fp812j.apps.googleusercontent.com';

// In the extension, the account Chrome is signed in to is Chrome's to look after, so it
// stays signed in. Other accounts you add sign in through Google's page for extensions,
// whose hour-long token can be renewed without asking, as long as that account is
// signed in to Google in Chrome.
function extensionAuth() {
  var token = null, granted = '', until = 0;
  var mainEmail = stored('tabandtick-main') || ''; // the email of Chrome's account
  var using = stored('tabandtick-using') || '';    // an added account in use, or '' for Chrome's
  var tokens = stored('tabandtick-tokens') || {};   // added accounts': { email: { token, until, scope } }
  var hint = '';

  function stored(key, value) {
    try {
      if (value !== undefined) localStorage.setItem(key, JSON.stringify(value));
      return JSON.parse(localStorage.getItem(key));
    } catch (e) { return value; }
  }

  // Chrome's account
  function chromeToken(interactive, done) {
    chrome.identity.getAuthToken({ interactive: interactive, scopes: SCOPES.split(' ') }, function(result) {
      var reason = chrome.runtime.lastError && chrome.runtime.lastError.message;
      if (reason) console.warn('Sign-in:', reason);
      token = (result && result.token) || (typeof result === 'string' && result) || null;
      granted = (result && result.grantedScopes || []).join(' ');
      until = Infinity; // Chrome renews it
      done(!!token, reason);
    });
  }

  function dropChromeToken(done) {
    var old = using ? null : token;
    if (!using) token = null;
    if (!old) return done();
    chrome.identity.removeCachedAuthToken({ token: old }, done);
  }

  // An added account, through Google's page: done(ok, reason). Not interactive, it
  // succeeds only if Google can answer without showing anything.
  function webToken(email, interactive, done, choose) {
    var params = {
      client_id: CLIENT_ID, response_type: 'token', redirect_uri: chrome.identity.getRedirectURL(),
      scope: SCOPES, include_granted_scopes: 'true'
    };
    if (email) params.login_hint = email;
    if (!interactive) params.prompt = 'none';
    else if (choose) params.prompt = 'select_account';
    chrome.identity.launchWebAuthFlow({ url: 'https://accounts.google.com/o/oauth2/v2/auth?' + $.param(params), interactive: interactive }, function(redirect) {
      var reason = chrome.runtime.lastError && chrome.runtime.lastError.message;
      var answer = new URLSearchParams(((redirect || '').split('#')[1]) || '');
      if (reason || !answer.get('access_token')) return done(false, reason || answer.get('error') || 'no token');
      token = answer.get('access_token');
      granted = answer.get('scope') || '';
      until = Date.now() + (Number(answer.get('expires_in')) - 60) * 1000;
      if (email) keep(email);
      done(true);
    });
  }

  // A session with Tab & Tick's server, for shared lists kept there: Google's page
  // gives an ID token saying who you are, which the server checks. The nonce ties
  // the token to this request.
  function cloudSession(email, interactive, done) {
    if (!window.cloud || !email) return done(false);
    if (cloud.has(email)) return done(true);
    var raw = Array.prototype.map.call(crypto.getRandomValues(new Uint8Array(16)), function(b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)).then(function(hash) {
      var nonce = Array.prototype.map.call(new Uint8Array(hash), function(b) { return ('0' + b.toString(16)).slice(-2); }).join('');
      var params = { client_id: CLIENT_ID, response_type: 'id_token', redirect_uri: chrome.identity.getRedirectURL(),
        scope: 'openid email profile', nonce: nonce, login_hint: email };
      if (!interactive) params.prompt = 'none';
      chrome.identity.launchWebAuthFlow({ url: 'https://accounts.google.com/o/oauth2/v2/auth?' + $.param(params), interactive: !!interactive }, function(redirect) {
        var reason = chrome.runtime.lastError && chrome.runtime.lastError.message;
        var idToken = new URLSearchParams(((redirect || '').split('#')[1]) || '').get('id_token');
        if (reason || !idToken) return done(false);
        cloud.withIdToken(email, idToken, raw, done);
      });
    }, function() { done(false); });
  }

  // Google's page, asking for a code the server swaps for lasting permission
  function allowServer(email, done) {
    if (!window.cloud) return done(false);
    var params = { client_id: CLIENT_ID, response_type: 'code', redirect_uri: chrome.identity.getRedirectURL(),
      scope: SCOPES, access_type: 'offline', prompt: 'consent', login_hint: email || '', include_granted_scopes: 'true' };
    chrome.identity.launchWebAuthFlow({ url: 'https://accounts.google.com/o/oauth2/v2/auth?' + $.param(params), interactive: true }, function(redirect) {
      var reason = chrome.runtime.lastError && chrome.runtime.lastError.message;
      var code = new URLSearchParams(((redirect || '').split('?')[1] || '').split('#')[0]).get('code');
      if (reason || !code) return done(false);
      cloud.allow(code, chrome.identity.getRedirectURL(), done);
    });
  }

  function keep(email) {
    tokens[email] = { token: token, until: until, scope: granted };
    stored('tabandtick-tokens', tokens);
  }

  function use(email, done) {
    hint = email;
    if (!email || email === mainEmail) { // Chrome's
      using = '';
      stored('tabandtick-using', '');
      return chromeToken(false, done);
    }
    using = email;
    stored('tabandtick-using', email);
    var kept = tokens[email];
    if (kept && kept.until > Date.now()) {
      token = kept.token; granted = kept.scope; until = kept.until;
      return done(true);
    }
    webToken(email, false, function(ok, reason) {
      if (ok) return done(true);
      webToken(email, true, done); // Google needs to ask
    });
  }

  return {
    silent: function(done) { using ? use(using, done) : chromeToken(false, done); },
    login: function(done) { use(using || mainEmail, function(ok, reason) { if (ok || using) return done(ok, reason); chromeToken(true, done); }); },
    expired: function(done) {
      if (!using) return dropChromeToken(function() { chromeToken(false, done); });
      delete tokens[using];
      webToken(using, false, done);
    },
    token: function() { return token && until > Date.now() ? token : null; },
    logout: function() {
      if (window.cloud && hint) cloud.signOut(hint);
      if (using) token = null;
      else dropChromeToken(function() {});
    },
    hint: function(email) { hint = email || ''; },
    canSwitch: true,
    // The token in use is this account's. Chrome's account is the one got from Chrome.
    remember: function(email) {
      hint = email || '';
      if (!email) return;
      if (!using) {
        mainEmail = email;
        stored('tabandtick-main', email);
      } else if (using !== email) { // Google's page was answered with another one
        delete tokens[using];
        using = email;
        stored('tabandtick-using', email);
        keep(email);
      }
    },
    use: use,
    add: function(done) {
      using = 'new';
      webToken('', true, function(ok, reason) {
        if (!ok) using = '';
        done(ok, reason);
      }, true);
    },
    forget: function(email) {
      if (window.cloud) cloud.signOut(email, true);
      delete tokens[email];
      stored('tabandtick-tokens', tokens);
      if (email === mainEmail) {
        mainEmail = '';
        stored('tabandtick-main', '');
      }
      if (using === email) {
        using = '';
        stored('tabandtick-using', '');
      }
    },
    canShare: true,
    cloudSession: cloudSession,
    allowServer: allowServer
  };
}

// Google gives a website a token that lasts an hour. Logging in gets a one-time code
// instead, which Tab & Tick Cloud (cloud.js) swaps for the token and keeps a refresh
// token, so a fresh one comes quietly from there before each hour is up. Without the
// cloud (if it can't be reached, or for an account logged in before it), the next
// click or key near the end of the hour opens Google's window to renew it: see renew().
// The token is kept in the browser, so closing the tab doesn't log you out.
function webAuth() {
  var KEY = 'tabandtick-token';
  var TOKENS = 'tabandtick-tokens'; // each account's, by email, to switch back without asking
  var waiting = [];
  var ready = false;
  var saved = null; // {token, until, scope}
  var tokens = {};

  try {
    saved = JSON.parse(localStorage.getItem(KEY));
    tokens = JSON.parse(localStorage.getItem(TOKENS)) || {};
  } catch (e) { /* storage is blocked, or not ours */ }

  var timer = null;

  function keep(value) {
    saved = value;
    clearTimeout(timer);
    // Renew it quietly a few minutes before it runs out
    if (value && value.until > Date.now() && hint && cloud.has(hint)) {
      timer = setTimeout(function() { fromCloud(function() {}); }, Math.max(0, value.until - Date.now() - 4 * 60 * 1000));
    }
    try {
      if (value) localStorage.setItem(KEY, JSON.stringify(value));
      else localStorage.removeItem(KEY);
    } catch (e) { /* storage is blocked */ }
    if (value && hint) {
      tokens[hint] = value;
      keepTokens();
    }
  }

  function keepTokens() {
    try { localStorage.setItem(TOKENS, JSON.stringify(tokens)); } catch (e) { /* storage is blocked */ }
  }

  function token() {
    return saved && saved.token && saved.until > Date.now() ? saved.token : null;
  }

  var script = document.createElement('script');
  script.src = 'https://accounts.google.com/gsi/client';
  script.onload = function() {
    ready = true;
    $.each(waiting.splice(0), function(i, f) { f(); });
  };
  script.onerror = function() {
    waiting.failed = true;
    $.each(waiting.splice(0), function(i, f) { f('blocked'); });
  };
  document.head.appendChild(script);

  var hint = ''; // the account's email, so renewing doesn't ask which account
  var renewing = false;

  // A fresh token from Tab & Tick Cloud, for the account in use
  var fetching = null;
  function fromCloud(done) {
    if (!hint || !cloud.has(hint)) return done(false, 'not kept');
    if (fetching) return fetching.push(done);
    fetching = [done];
    var email = hint;
    cloud.token(email, function(answer, reason) {
      var waiting = fetching;
      fetching = null;
      if (answer && email === hint) keep({ token: answer.access_token, until: Date.now() + (answer.expires_in - 60) * 1000, scope: answer.scope || '' });
      $.each(waiting, function(i, f) { f(!!answer && email === hint, reason); });
    });
  }

  // ask: ask again (prompt=consent), which is what makes Google give the server lasting
  // permission once it's been given before
  function login(done, choose, blocked, ask) {
    if (blocked || waiting.failed) return done(false, 'Google\u2019s sign-in script was blocked');
    if (!ready && window.google && google.accounts) ready = true;
    if (!ready) return waiting.push(function(blocked) { login(done, choose, blocked, ask); });
    google.accounts.oauth2.initCodeClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      // With what you've agreed to before. (The server won't keep a sign-in that has
      // more than Tab & Tick asks for: see ALLOWED in supabase/functions/_shared/common.ts.)
      include_granted_scopes: true,
      ux_mode: 'popup',
      select_account: !!choose,
      prompt: ask ? 'consent' : undefined,
      login_hint: choose ? '' : hint,
      callback: function(response) {
        if (response.error) return done(false, response.error);
        if (!google.accounts.oauth2.hasGrantedAllScopes(response, SCOPE)) return done(false, 'access to tasks wasn\u2019t ticked');
        cloud.signIn(response.code, function(answer, email) {
          if (!answer) return done(false, email); // the reason, then
          if (email) hint = email; // whichever account was chosen in Google's window
          keep({ token: answer.access_token, until: Date.now() + (answer.expires_in - 60) * 1000, scope: answer.scope || '' });
          done(true, '', answer.kept);
        });
      },
      error_callback: function(error) { done(false, error && error.type); }
    }).requestCode();
  }

  return {
    silent: function(done) {
      if (token()) return done(true);
      fromCloud(function(ok, reason) { done(ok, reason || 'no token'); });
    },
    login: function(done, choose) { login(done, choose); },
    expired: function(done) {
      if (saved) keep($.extend({}, saved, { until: 0 }));
      fromCloud(function(ok) { done(ok, ok ? '' : 'expired'); }); // without it, a new token needs a click: see renew()
    },
    token: token,
    logout: function() {
      if (hint) cloud.signOut(hint);
      keep(null);
    },
    canSwitch: true,
    // The token just got is this account's: called once Google says whose it is.
    remember: function(email) {
      hint = email || '';
      if (hint && token()) {
        $.each(tokens, function(other, kept) { // got for another, if Google's window was answered with this one
          if (other !== hint && kept.token === saved.token) delete tokens[other];
        });
        tokens[hint] = saved;
        keepTokens();
      }
    },
    // Switch to an account added before: at once if its token is fresh, or Google's
    // window, which closes by itself as that account agreed before.
    use: function(email, done) {
      hint = email;
      var kept = tokens[email];
      if (kept && kept.until > Date.now()) {
        keep(kept);
        return done(true);
      }
      keep(null);
      if (cloud.has(email)) return fromCloud(function(ok) { ok ? done(true) : login(done, false); });
      login(done, false);
    },
    add: function(done) {
      hint = '';
      keep(null);
      login(done, true);
    },
    forget: function(email) {
      cloud.signOut(email, true);
      delete tokens[email];
      keepTokens();
    },
    canShare: true,
    allowServer: function(email, done) {
      login(function(ok, reason, kept) { done(!!ok && !!kept); }, false, false, true);
    },
    // The token lasts an hour. Google's window can only open on a click or a key, so
    // in its last few minutes, or once it has gone, the next one renews it. Having
    // agreed before, you aren't asked again: the window closes by itself. done(ok).
    renew: function(done) {
      if (renewing || !saved || !hint || saved.until - Date.now() > 5 * 60 * 1000) return;
      if (cloud.has(hint)) return fromCloud(function(ok) { if (done) done(ok); }); // quietly, no window
      renewing = true;
      login(function(ok) {
        renewing = false;
        if (done) done(ok);
      }, false);
    },
    hint: function(email) { hint = email || ''; }
  };
}

var auth = window.chrome && chrome.identity && chrome.identity.getAuthToken ? extensionAuth() : webAuth();
