/* Combi-Quiz core: host game logic + player client logic.
   Shared by the browser app (index.html) and the Node E2E test.
   Transport-injected: both sides get a send(topic, payloadObj) callback
   and call handleMessage(topic, obj) on inbound traffic. */
(function (global) {
'use strict';

var PROTO = 'combiquiz/v1';

function topics(room) {
  return { inn: PROTO + '/' + room + '/in', out: PROTO + '/' + room + '/out' };
}

function makeRoomCode() {
  var chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var s = '';
  for (var i = 0; i < 9; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/* ---------------- Host ---------------- */

function HostGame(opts) {
  this.room = opts.room;
  this.stages = opts.stages;            // array of {id,title,formula,questions:[{q,options,correct}]}
  this.questionMs = opts.questionMs || 30000;
  this.revealMs = opts.revealMs || 6000;
  this.now = opts.now || function () { return Date.now(); };
  this.setTimeout = opts.setTimeout || function (fn, ms) { return setTimeout(fn, ms); };
  this.clearTimeout = opts.clearTimeout || function (id) { clearTimeout(id); };
  this.setIntervalRef = opts.setInterval || function (fn, ms) { return setInterval(fn, ms); };
  this.clearIntervalRef = opts.clearInterval || function (id) { clearInterval(id); };
  this.send = opts.send;                // send(outTopic, obj)
  this.onEvent = opts.onEvent || function () {}; // UI hook: (kind, data)
  this.players = {};                    // pid -> {pid,name,score,stageScore,answered,lastPing}
  this.state = 'lobby';                 // lobby|intro|question|reveal|stageEnd|final
  this.stageIdx = -1;
  this.qIdx = -1;
  this.questionStart = 0;
  this.questionEndsAt = 0;
  this.timer = null;
  this.hbTimer = null;
  this.topics = opts.topics || topics(this.room);
  var self = this;
  this.hbTimer = this.setIntervalRef(function () { self.heartbeat(); }, 4000);
}

HostGame.prototype.destroy = function () {
  if (this.timer) this.clearTimeout(this.timer);
  if (this.hbTimer) this.clearIntervalRef(this.hbTimer);
};

HostGame.prototype.broadcast = function (obj) { this.send(this.topics.out, obj); };

HostGame.prototype.roster = function () {
  var list = [];
  for (var pid in this.players) {
    var p = this.players[pid];
    list.push({ pid: pid, name: p.name, score: p.score });
  }
  list.sort(function (a, b) { return b.score - a.score; });
  return list;
};

HostGame.prototype.heartbeat = function () {
  this.broadcast({ t: 'hb', state: this.state, stage: this.stageNo(this.stageIdx), q: this.qIdx + 1 });
};

HostGame.prototype.handleMessage = function (topic, m) {
  if (topic !== this.topics.inn) return;
  if (m.t === 'join') this.onJoin(m);
  else if (m.t === 'answer') this.onAnswer(m);
  else if (m.t === 'ping') { var p = this.players[m.pid]; if (p) p.lastPing = this.now(); }
};

HostGame.prototype.onJoin = function (m) {
  if (!m.pid || !m.name) return;
  var isNew = !this.players[m.pid];
  if (isNew) {
    this.players[m.pid] = { pid: m.pid, name: String(m.name).slice(0, 20), score: 0, stageScore: 0, answered: false, lastPing: this.now() };
  } else {
    this.players[m.pid].name = String(m.name).slice(0, 20);
    this.players[m.pid].lastPing = this.now();
  }
  this.broadcast({ t: 'roster', players: this.roster() });
  // sync the joiner with current state
  var sync = { t: 'sync', state: this.state, stage: this.stageNo(this.stageIdx), q: this.qIdx + 1, players: this.roster() };
  if (this.state === 'question') {
    sync.question = this.currentPublicQuestion();
  }
  this.broadcast(sync);
  this.onEvent('join', { pid: m.pid, name: this.players[m.pid].name, isNew: isNew, count: Object.keys(this.players).length });
};

HostGame.prototype.startGame = function () {
  if (this.state !== 'lobby') return;
  this.startStage(0);
};

HostGame.prototype.startStage = function (idx) {
  this.stageIdx = idx;
  this.qIdx = -1;
  this.state = 'intro';
  for (var pid in this.players) { this.players[pid].stageScore = 0; }
  this.broadcast({ t: 'intro', stage: this.stageNo(idx), title: this.stages[idx].title, formula: this.stages[idx].formula || null });
  this.onEvent('intro', { stage: this.stageNo(idx) });
};

HostGame.prototype.introDone = function () { // host pressed skip / animation finished
  if (this.state !== 'intro') return;
  this.nextQuestion();
};

HostGame.prototype.stageNo = function (idx) { var st = this.stages[idx]; return (st && st.id) ? st.id : idx + 1; };
HostGame.prototype.currentStage = function () { return this.stages[this.stageIdx]; };

HostGame.prototype.currentPublicQuestion = function () {
  var q = this.currentStage().questions[this.qIdx];
  return { q: q.q, options: q.options, qi: this.qIdx + 1, total: this.currentStage().questions.length,
           stage: this.stageNo(this.stageIdx), stageTitle: this.currentStage().title,
           endsAt: this.questionEndsAt, dur: this.questionMs };
};

HostGame.prototype.nextQuestion = function () {
  var stage = this.currentStage();
  this.qIdx++;
  if (this.qIdx >= stage.questions.length) { this.endStage(); return; }
  this.state = 'question';
  for (var pid in this.players) { this.players[pid].answered = false; }
  this.questionStart = this.now();
  this.questionEndsAt = this.questionStart + this.questionMs;
  this.answers = {};
  this.broadcast(Object.assign({ t: 'question' }, this.currentPublicQuestion()));
  this.onEvent('question', { qi: this.qIdx + 1, total: stage.questions.length, q: stage.questions[this.qIdx].q });
  var self = this;
  if (this.timer) this.clearTimeout(this.timer);
  this.timer = this.setTimeout(function () { self.reveal(); }, this.questionMs);
};

HostGame.prototype.onAnswer = function (m) {
  if (this.state !== 'question') return;
  var p = this.players[m.pid];
  if (!p || p.answered) return;
  var recv = this.now();
  if (recv > this.questionEndsAt) return;
  var q = this.currentStage().questions[this.qIdx];
  var ok = (m.choice === q.correct);
  var elapsed = recv - this.questionStart;
  var gain = 0;
  if (ok) gain = 500 + Math.round(500 * (1 - elapsed / this.questionMs));
  p.answered = true;
  p.score += gain;
  p.stageScore += gain;
  this.answers[m.pid] = { ok: ok, gain: gain, choice: m.choice };
  this.onEvent('answer', { pid: m.pid, name: p.name, ok: ok, answered: Object.keys(this.answers).length, total: Object.keys(this.players).length });
  // if everyone answered, cut to reveal early
  var all = true;
  for (var id in this.players) if (!this.players[id].answered) { all = false; break; }
  if (all && Object.keys(this.players).length > 0) {
    if (this.timer) this.clearTimeout(this.timer);
    var self = this;
    this.timer = this.setTimeout(function () { self.reveal(); }, 400);
  }
};

HostGame.prototype.reveal = function () {
  if (this.state !== 'question') return;
  this.state = 'reveal';
  var q = this.currentStage().questions[this.qIdx];
  var results = {};
  for (var pid in this.players) {
    var a = this.answers[pid];
    results[pid] = a ? { ok: a.ok, gain: a.gain } : { ok: false, gain: 0, timeout: true };
  }
  this.broadcast({ t: 'reveal', correct: q.correct, qi: this.qIdx + 1, results: results, top: this.roster().slice(0, 5) });
  this.onEvent('reveal', { correct: q.correct, correctText: q.options[q.correct], top: this.roster().slice(0, 5) });
  // no auto-advance: the correct answer stays up until the host taps "next" (nextFromReveal)
};

HostGame.prototype.nextFromReveal = function () { // host taps "next question" after explaining
  if (this.state !== 'reveal') return;
  this.nextQuestion();
};

HostGame.prototype.endStage = function () {
  this.state = 'stageEnd';
  var board = [];
  for (var pid in this.players) {
    var p = this.players[pid];
    board.push({ pid: pid, name: p.name, stageScore: p.stageScore, score: p.score });
  }
  board.sort(function (a, b) { return b.stageScore - a.stageScore; });
  var winner = board.length ? board[0] : null;
  this.broadcast({ t: 'stageEnd', stage: this.stageNo(this.stageIdx), title: this.currentStage().title, winner: winner, board: board, top: this.roster().slice(0, 5) });
  this.onEvent('stageEnd', { stage: this.stageNo(this.stageIdx), winner: winner, board: board });
};

HostGame.prototype.hostContinue = function () { // host taps "next" on stageEnd / final screens
  if (this.state === 'stageEnd') {
    if (this.stageIdx + 1 >= this.stages.length) { this.finish(); }
    else this.startStage(this.stageIdx + 1);
  } else if (this.state === 'final') {
    // restart to lobby with scores cleared
    this.state = 'lobby';
    for (var pid in this.players) { this.players[pid].score = 0; this.players[pid].stageScore = 0; }
    this.stageIdx = -1; this.qIdx = -1;
    this.broadcast({ t: 'roster', players: this.roster(), reset: true });
    this.onEvent('lobby', {});
  }
};

HostGame.prototype.finish = function () {
  this.state = 'final';
  var board = this.roster();
  this.broadcast({ t: 'final', board: board });
  this.onEvent('final', { board: board });
};

/* ---------------- Player client ---------------- */

function PlayerClient(opts) {
  this.room = opts.room;
  this.pid = opts.pid;
  this.name = opts.name;
  this.send = opts.send;
  this.onState = opts.onState || function () {}; // (uiState)
  this.topics = opts.topics || topics(this.room);
  this.players = [];
  this.state = { screen: 'joining' }; // joining|lobby|intro|question|reveal|stageEnd|final|error
  var self = this;
  this.setIntervalRef = opts.setInterval || function (fn, ms) { return setInterval(fn, ms); };
  this.pingTimer = this.setIntervalRef(function () {
    self.send(self.topics.inn, { t: 'ping', pid: self.pid });
  }, 8000);
}

PlayerClient.prototype.join = function () {
  this.send(this.topics.inn, { t: 'join', pid: this.pid, name: this.name });
};

PlayerClient.prototype.answer = function (choice) {
  if (this.state.screen !== 'question' || this.state.answered) return;
  this.state.answered = true;
  this.send(this.topics.inn, { t: 'answer', pid: this.pid, q: this.state.qi, choice: choice });
  this.onState(this.state);
};

PlayerClient.prototype.handleMessage = function (topic, m) {
  if (topic !== this.topics.out) return;
  var s = this.state;
  if (m.t === 'roster') {
    this.players = m.players;
    if (s.screen === 'joining') s.screen = 'lobby';
    if (m.reset) s.screen = 'lobby';
    s.players = this.players;
  } else if (m.t === 'sync') {
    this.players = m.players || this.players;
    s.players = this.players;
    if (m.state === 'question' && m.question) {
      s.screen = 'question'; s.answered = false;
      s.q = m.question.q; s.options = m.question.options; s.qi = m.question.qi;
      s.total = m.question.total; s.stage = m.question.stage; s.stageTitle = m.question.stageTitle;
      s.endsAt = m.question.endsAt;
    } else if (m.state === 'lobby') { s.screen = 'lobby'; }
    else if (s.screen === 'joining') { s.screen = 'lobby'; }
  } else if (m.t === 'intro') {
    s.screen = 'intro'; s.stage = m.stage; s.introTitle = m.title; s.formula = m.formula; s.answered = false;
  } else if (m.t === 'question') {
    s.screen = 'question'; s.answered = false; s.lastGain = null; s.lastOk = null;
    s.q = m.q; s.options = m.options; s.qi = m.qi; s.total = m.total;
    s.stage = m.stage; s.stageTitle = m.stageTitle; s.endsAt = m.endsAt; s.dur = m.dur;
  } else if (m.t === 'reveal') {
    s.screen = 'reveal'; s.correct = m.correct; s.qi = m.qi;
    var r = m.results[this.pid] || { ok: false, gain: 0 };
    s.lastOk = r.ok; s.lastGain = r.gain; s.timeout = !!r.timeout;
    s.top = m.top;
    for (var i = 0; i < m.top.length; i++) if (m.top[i].pid === this.pid) { s.myRank = i + 1; s.myScore = m.top[i].score; }
    if (s.myRank === undefined || s.myScore === undefined) {
      // find me anywhere in the visible list only; host sends top5
      for (var j = 0; j < this.players.length; j++) if (this.players[j].pid === this.pid) { s.myScore = this.players[j].score; }
    }
    this.players = mergeScores(this.players, m.top);
    s.players = this.players;
  } else if (m.t === 'stageEnd') {
    s.screen = 'stageEnd'; s.stage = m.stage; s.stageTitle = m.title;
    s.winner = m.winner; s.board = m.board; s.top = m.top;
    s.myStageScore = null; s.myScore = null; s.myRank = null;
    for (var i = 0; i < m.board.length; i++) if (m.board[i].pid === this.pid) { s.myStageScore = m.board[i].stageScore; s.myScore = m.board[i].score; }
  } else if (m.t === 'final') {
    s.screen = 'final'; s.board = m.board;
    s.myRank = null; s.myScore = null;
    for (var i = 0; i < m.board.length; i++) if (m.board[i].pid === this.pid) { s.myRank = i + 1; s.myScore = m.board[i].score; }
  }
  this.onState(s);
};

function mergeScores(players, top) {
  var map = {};
  players.forEach(function (p) { map[p.pid] = p; });
  top.forEach(function (p) { map[p.pid] = p; });
  var list = [];
  for (var k in map) list.push(map[k]);
  list.sort(function (a, b) { return b.score - a.score; });
  return list;
}

var api = { topics: topics, makeRoomCode: makeRoomCode, HostGame: HostGame, PlayerClient: PlayerClient, PROTO: PROTO };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else global.CombiCore = api;

})(typeof window !== 'undefined' ? window : globalThis);
