/* Combi-Quiz secure room channel (v2).
   Wraps the raw MQTT transport with:
   - opaque room id: the MQTT topic is derived from the room code by SHA-256,
     so someone listening to combiquiz/# cannot tell rooms apart or find them.
   - AES-GCM-256 encryption of every message: key derived from the room code
     with PBKDF2-SHA256 (120k iterations). Without the code, messages are noise.
   - ECDSA P-256 signatures on every host message: the host generates a key
     pair when the room opens; players pin the first public key they see (TOFU)
     and drop anything not signed by it, so another player cannot impersonate
     the host mid-game.
   - replay/timing guards: host messages carry a monotonic seq; player
     messages carry a per-player monotonic counter and a timestamp, and the
     host drops stale or replayed envelopes.
   Works in the browser (WebCrypto) and in Node 19+ (global crypto.subtle). */
(function (global) {
'use strict';

var subtle = global.crypto && global.crypto.subtle;
var te = new TextEncoder();

function utf8(s) { return te.encode(s); }

function b64encode(bytes) {
  var bin = '';
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return (typeof btoa !== 'undefined') ? btoa(bin) : Buffer.from(bytes).toString('base64');
}
function b64decode(s) {
  var bin = (typeof atob !== 'undefined') ? atob(s) : Buffer.from(s, 'base64').toString('binary');
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function hex(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/* code -> { roomId, encKey, topics } */
async function deriveRoom(code) {
  code = normalizeCode(code);
  var digest = await subtle.digest('SHA-256', utf8('combiquiz-v2/topic|' + code));
  var roomId = hex(new Uint8Array(digest)).slice(0, 16);
  var keyMat = await subtle.importKey('raw', utf8(code), 'PBKDF2', false, ['deriveBits']);
  var bits = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: utf8('combiquiz-v2/enc'), iterations: 120000 },
    keyMat, 256);
  var encKey = await subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return {
    roomId: roomId,
    encKey: encKey,
    topics: { inn: 'combiquiz/v2/' + roomId + '/in', out: 'combiquiz/v2/' + roomId + '/out' }
  };
}

async function encryptObj(encKey, obj) {
  var iv = global.crypto.getRandomValues(new Uint8Array(12));
  var ct = await subtle.encrypt({ name: 'AES-GCM', iv: iv }, encKey, utf8(JSON.stringify(obj)));
  return { iv: b64encode(iv), ct: b64encode(new Uint8Array(ct)) };
}

async function decryptObj(encKey, env) {
  try {
    var pt = await subtle.decrypt({ name: 'AES-GCM', iv: b64decode(env.iv) }, encKey, b64decode(env.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch (e) { return null; }
}

/* hooks.publish(topic, envelopeObj) - fire and forget. */
async function createHostChannel(code, hooks) {
  var r = await deriveRoom(code);
  var kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  var pubJwk = await subtle.exportKey('jwk', kp.publicKey);
  var seq = 0;
  var lastCtr = {};   // pid -> last accepted counter
  var SKEW_MS = 120000;
  return {
    topics: r.topics,
    roomId: r.roomId,
    send: function (topic, obj) { // fire and forget
      seq++;
      var inner = { seq: seq, ts: Date.now(), rid: r.roomId, m: obj };
      encryptObj(r.encKey, inner).then(async function (env) {
        try {
          var sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, utf8(env.iv + '.' + env.ct));
          env.v = 2; env.pub = pubJwk; env.sig = b64encode(new Uint8Array(sig));
          hooks.publish(topic, env);
        } catch (e) {}
      });
    },
    /* returns {topic, msg} or null */
    accept: async function (topic, raw) {
      if (topic !== r.topics.inn) return null;
      var env;
      try { env = (typeof raw === 'string') ? JSON.parse(raw) : raw; } catch (e) { return null; }
      if (!env || env.v !== 2) return null;
      var inner = await decryptObj(r.encKey, env);
      if (!inner || inner.rid !== r.roomId || !inner.m) return null;
      var m = inner.m;
      if (m.t === 'join' || m.t === 'answer' || m.t === 'ping') {
        var pid = m.pid;
        if (!pid) return null;
        if (typeof inner.ctr !== 'number' || inner.ctr <= (lastCtr[pid] || 0)) return null; // replay
        if (typeof inner.ts !== 'number' || Math.abs(Date.now() - inner.ts) > SKEW_MS) return null; // stale
        lastCtr[pid] = inner.ctr;
      }
      return { topic: topic, msg: m };
    }
  };
}

/* hooks.onTamper() optional: called when a signed check fails after pinning. */
async function createPlayerChannel(code, pid, hooks) {
  var r = await deriveRoom(code);
  var ctr = 0;
  var hostPubKey = null;  // pinned CryptoKey (TOFU)
  var hostSeq = 0;
  return {
    topics: r.topics,
    roomId: r.roomId,
    send: function (topic, obj) { // fire and forget
      ctr++;
      var inner = { ctr: ctr, ts: Date.now(), rid: r.roomId, m: obj };
      encryptObj(r.encKey, inner).then(function (env) {
        env.v = 2;
        hooks.publish(topic, env);
      }).catch(function () {});
    },
    accept: async function (topic, raw) {
      if (topic !== r.topics.out) return null;
      var env;
      try { env = (typeof raw === 'string') ? JSON.parse(raw) : raw; } catch (e) { return null; }
      if (!env || env.v !== 2 || !env.pub || !env.sig) return null;
      try {
        if (!hostPubKey) {
          hostPubKey = await subtle.importKey('jwk', env.pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        }
        var ok = await subtle.verify(
          { name: 'ECDSA', hash: 'SHA-256' }, hostPubKey, b64decode(env.sig), utf8(env.iv + '.' + env.ct));
        if (!ok) { if (hooks.onTamper) hooks.onTamper(); return null; }
      } catch (e) { return null; }
      var inner = await decryptObj(r.encKey, env);
      if (!inner || inner.rid !== r.roomId || typeof inner.seq !== 'number' || inner.seq <= hostSeq) return null;
      hostSeq = inner.seq;
      return { topic: topic, msg: inner.m };
    }
  };
}

var api = { deriveRoom: deriveRoom, createHostChannel: createHostChannel, createPlayerChannel: createPlayerChannel, normalizeCode: normalizeCode };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else global.CombiSecure = api;

})(typeof window !== 'undefined' ? window : globalThis);
