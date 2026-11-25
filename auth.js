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

function webAuth() {
  var waiting = [];
  var ready = false;

  window.googleReady = function() {
    ready = true;
    $.each(waiting.splice(0), function(i, f) { f(); });
  };
  var script = document.createElement('script');
  script.src = 'https://apis.google.com/js/client.js?onload=googleReady';
  document.head.appendChild(script);

  function authorize(options, done) {
    if (!ready) return waiting.push(function() { authorize(options, done); });
    gapi.auth.authorize($.extend({ client_id: CLIENT_ID, scope: SCOPE }, options), function(result) {
      done(!!(result && !result.error), result && (result.error_subtype || result.error));
    });
  }

  return {
    silent: function(done) { authorize({ immediate: true }, done); },
    login: function(done, choose) { authorize(choose ? { immediate: false, prompt: 'select_account' } : { immediate: false }, done); },
    expired: function(done) { authorize({ immediate: true }, done); },
    token: function() {
      var token = ready && gapi.auth.getToken();
      return (token && token.access_token) || null;
    },
    logout: function() { if (ready) gapi.auth.setToken(null); }
  };
}

var auth = window.chrome && chrome.identity && chrome.identity.getAuthToken ? extensionAuth() : webAuth();
