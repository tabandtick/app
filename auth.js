// Signing in to Google. In the Chrome extension, Chrome does it; on the website,
// Google's script does. Each way offers the same five functions:
//   silent(done)   sign in without asking      login(done)  ask if need be
//   expired(done)  replace a refused token     token()      the token, or null
//   logout()       forget the token
// done is called with true or false, and the reason if false.

var SCOPE = 'https://www.googleapis.com/auth/tasks';
var CLIENT_ID = '146982777170-h1btpb05ltctf58n4f9foqof665i08j7.apps.googleusercontent.com';

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
    logout: function() { forget(function() {}); }
  };
}

// Google's token lasts about an hour. It is kept in this tab's session storage so
// that a refresh doesn't log you out; closing the tab forgets it.
function webAuth() {
  var KEY = 'tabandtick-token';
  var waiting = [];
  var ready = false;
  var saved = null; // {token, until}

  try {
    saved = JSON.parse(sessionStorage.getItem(KEY));
  } catch (e) { /* storage is blocked, or not ours */ }

  function keep(value) {
    saved = value;
    try {
      if (value) sessionStorage.setItem(KEY, JSON.stringify(value));
      else sessionStorage.removeItem(KEY);
    } catch (e) { /* storage is blocked */ }
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

  function login(done, choose, blocked) {
    if (blocked || waiting.failed) return done(false, 'Google\u2019s sign-in script was blocked');
    if (!ready) return waiting.push(function(blocked) { login(done, choose, blocked); });
    google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: function(response) {
        if (response.error) return done(false, response.error);
        if (!google.accounts.oauth2.hasGrantedAllScopes(response, SCOPE)) return done(false, 'access to tasks wasn\u2019t ticked');
        keep({ token: response.access_token, until: Date.now() + (response.expires_in - 60) * 1000 });
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
    logout: function() { keep(null); }
  };
}

var auth = window.chrome && chrome.identity && chrome.identity.getAuthToken ? extensionAuth() : webAuth();
