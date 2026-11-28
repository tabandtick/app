// Tab & Tick Cloud (Supabase), which keeps the website signed in. It keeps each Google
// account's refresh token, so a fresh hour-long Google token can be had without
// Google's window. Your Google Tasks never go through it: they go between your browser
// and Google, as before. Lists you share are kept on it: see cloudlists.js. See
// supabase/ for its functions and tables.
//
//   signIn(code, done)    after Google's window: done(answer, email) or done(null, reason)
//   token(email, done)    a fresh Google token: done(answer) or done(null, reason)
//   has(email)            whether that account has a Tab & Tick session here
//   signOut(email)        forget it, here and on the server
//   db(email)             the Supabase client for that account, for shared lists
// An answer is Google's { access_token, expires_in, scope }.

var cloud = (function() {
  var URL = 'https://kmaekpihwhuzsbumlafb.supabase.co';
  var KEY = 'sb_publishable_RNkKyMnnza-258qdH5Wb5Q_j18x80t1'; // public: it only names the project
  var clients = {};

  function storageKey(email) {
    return 'tabandtick-session:' + email;
  }

  // One Supabase session per Google account, kept side by side
  function client(email) {
    if (!window.supabase) return null;
    return clients[email] || (clients[email] = supabase.createClient(URL, KEY, {
      auth: { storageKey: storageKey(email), persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
    }));
  }

  // done(status, body); status 0 when the server couldn't be reached
  function call(name, body, jwt, done) {
    fetch(URL + '/functions/v1/' + name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': KEY, 'Authorization': 'Bearer ' + (jwt || KEY) },
      body: JSON.stringify(body || {})
    }).then(function(response) {
      return response.json().catch(function() { return {}; }).then(function(json) { done(response.status, json); });
    }).catch(function() { done(0, {}); });
  }

  function emailOf(idToken) {
    try {
      return JSON.parse(atob(idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).email || '';
    } catch (e) { return ''; }
  }

  function session(email, done) {
    var c = client(email);
    if (!c) return done(null);
    c.auth.getSession().then(function(result) { done(result.data && result.data.session); }, function() { done(null); });
  }

  return {
    signIn: function(code, done) {
      call('google-sign-in', { code: code }, null, function(status, answer) {
        if (status !== 200 || !answer.access_token) return done(null, answer.reason || answer.error || (status ? 'error ' + status : 'no connection'));
        var email = emailOf(answer.id_token), c = email && client(email);
        if (!c) return done(answer, email);
        // With the session, the server can renew this account's Google token later. If
        // it can't be had, the token still works for its hour.
        c.auth.signInWithIdToken({ provider: 'google', token: answer.id_token }).then(function(result) {
          if (result.error) console.warn('Tab & Tick Cloud:', result.error.message);
          done(answer, email);
        }, function() { done(answer, email); });
      });
    },

    token: function(email, done) {
      session(email, function(s) {
        if (!s) return done(null, 'signed_out');
        call('google-token', {}, s.access_token, function(status, answer) {
          if (status === 200 && answer.access_token) return done(answer);
          if (status === 401) forget(email);
          done(null, status === 401 ? 'signed_out' : status ? 'error ' + status : 'no connection');
        });
      });
    },

    db: client,

    has: function(email) {
      try { return !!(email && localStorage.getItem(storageKey(email))); } catch (e) { return false; }
    },

    signOut: function(email) {
      session(email, function(s) {
        if (s) call('google-sign-out', {}, s.access_token, function() {});
        forget(email);
      });
    }
  };

  function forget(email) {
    var c = clients[email];
    if (c) c.auth.signOut({ scope: 'local' }).catch(function() {});
    try { localStorage.removeItem(storageKey(email)); } catch (e) { /* storage is blocked */ }
  }
})();
