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
//   hasDrive()     whether the token can open them   drive(done)  ask for that
// done is called with true or false, and the reason if false.

var SCOPE = 'https://www.googleapis.com/auth/tasks';
// Your name, email and picture, for the account button
var SCOPES = SCOPE + ' https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email';
// Only the files Tab & Tick makes, or that you pick for it: for shared lists
var DRIVE = 'https://www.googleapis.com/auth/drive.file';
var CLIENT_ID = '719894949389-8mfcps2du7nup1g0a14nfniul2fp812j.apps.googleusercontent.com';

function extensionAuth() {
  var token = null;

  function get(interactive, done) {
    chrome.identity.getAuthToken({ interactive: interactive }, function(result) {
      var reason = chrome.runtime.lastError && chrome.runtime.lastError.message;
      if (reason) console.warn('Sign-in:', reason);
      token = (result && result.token) || (typeof result === 'string' && result) || null;
      done(!!token, reason);
    });
  }

  function forget(done) {
    var old = token;
    token = null;
    if (!old) return done();
    chrome.identity.removeCachedAuthToken({ token: old }, done);
  }

  return {
    silent: function(done) { get(false, done); },
    login: function(done) { get(true, done); },
    expired: function(done) { forget(function() { get(false, done); }); },
    token: function() { return token; },
    logout: function() { forget(function() {}); },
    canSwitch: false, // Chrome only gives an extension the account Chrome is signed in to
    canShare: false, // not yet: Google's file picker can't be loaded in an extension
    hasDrive: function() { return false; },
    drive: function(done) { done(false, 'not in the extension yet'); }
  };
}

// Google's token lasts about an hour. It is kept in this tab's session storage so
// that a refresh doesn't log you out; closing the tab forgets it.
function webAuth() {
  var KEY = 'tabandtick-token';
  var TOKENS = 'tabandtick-tokens'; // each account's, by email, to switch back without asking
  var waiting = [];
  var ready = false;
  var saved = null; // {token, until, scope}
  var tokens = {};
  var DRIVE_KEY = 'tabandtick-drive:'; // and the email: set once that account has let it use Drive

  try {
    saved = JSON.parse(sessionStorage.getItem(KEY));
    tokens = JSON.parse(sessionStorage.getItem(TOKENS)) || {};
  } catch (e) { /* storage is blocked, or not ours */ }

  function keep(value) {
    saved = value;
    try {
      if (value) sessionStorage.setItem(KEY, JSON.stringify(value));
      else sessionStorage.removeItem(KEY);
    } catch (e) { /* storage is blocked */ }
    if (value && hint) {
      tokens[hint] = value;
      keepTokens();
    }
  }

  function keepTokens() {
    try { sessionStorage.setItem(TOKENS, JSON.stringify(tokens)); } catch (e) { /* storage is blocked */ }
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

  function wantsDrive(value) {
    if (!hint) return false; // a new account hasn't
    try {
      if (value === true) localStorage.setItem(DRIVE_KEY + hint, '1');
      if (value === false) localStorage.removeItem(DRIVE_KEY + hint);
      return localStorage.getItem(DRIVE_KEY + hint) === '1';
    } catch (e) { return !!value; }
  }

  function hasDrive() {
    return !!(token() && saved.scope && saved.scope.split(' ').indexOf(DRIVE) >= 0);
  }

  function login(done, choose, blocked) {
    if (blocked || waiting.failed) return done(false, 'Google\u2019s sign-in script was blocked');
    if (!ready && window.google && google.accounts) ready = true;
    if (!ready) return waiting.push(function(blocked) { login(done, choose, blocked); });
    google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES + (wantsDrive() ? ' ' + DRIVE : ''),
      include_granted_scopes: true,
      hint: choose ? '' : hint,
      callback: function(response) {
        if (response.error) return done(false, response.error);
        if (!google.accounts.oauth2.hasGrantedAllScopes(response, SCOPE)) return done(false, 'access to tasks wasn\u2019t ticked');
        keep({ token: response.access_token, until: Date.now() + (response.expires_in - 60) * 1000, scope: response.scope || '' });
        done(true);
      },
      error_callback: function(error) { done(false, error && error.type); }
    }).requestAccessToken({ prompt: choose ? 'select_account' : '' });
  }

  return {
    silent: function(done) { done(!!token(), 'no token'); },
    login: function(done, choose) { login(done, choose); },
    expired: function(done) { // a new token needs a click
      keep(null);
      done(false, 'expired');
    },
    token: token,
    logout: function() { keep(null); },
    canSwitch: true,
    // The token just got is this account's: called once Google says whose it is.
    remember: function(email) {
      hint = email || '';
      try { // from when one account's Drive was set for the whole browser
        if (hint && localStorage.getItem('tabandtick-drive') === '1') {
          localStorage.setItem(DRIVE_KEY + hint, '1');
          localStorage.removeItem('tabandtick-drive');
        }
      } catch (e) { /* storage is blocked */ }
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
      login(done, false);
    },
    add: function(done) {
      hint = '';
      keep(null);
      login(done, true);
    },
    forget: function(email) {
      delete tokens[email];
      keepTokens();
      try { localStorage.removeItem(DRIVE_KEY + email); } catch (e) { /* storage is blocked */ }
    },
    canShare: true,
    hasDrive: hasDrive,
    drive: function(done) {
      wantsDrive(true);
      login(function(ok, reason) {
        if (ok && !hasDrive()) return done(false, 'access to Drive wasn\u2019t ticked');
        done(ok, reason);
      }, false);
    },
    // The token lasts an hour. Google's window can only open on a click or a key, so
    // in its last few minutes the next one renews it. Having agreed before, you
    // aren't asked again: the window closes by itself.
    renew: function() {
      if (renewing || !saved || !token() || saved.until - Date.now() > 5 * 60 * 1000) return;
      renewing = true;
      login(function() { renewing = false; }, false);
    },
    hint: function(email) { hint = email || ''; }
  };
}

var auth = window.chrome && chrome.identity && chrome.identity.getAuthToken ? extensionAuth() : webAuth();
