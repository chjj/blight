'use strict';

var EventEmitter = require('events').EventEmitter;
var bcoin = require('bcoin');
var utils = bcoin.utils;
var assert = utils.assert;
var constants = bcoin.constants;
var wire = require('./wire');

function Parser(options) {
  if (!(this instanceof Parser))
    return new Parser(options);

  if (!options)
    options = {};

  EventEmitter.call(this);

  this.network = bcoin.network.get(options.network);

  this.pending = [];
  this.total = 0;
  this.waiting = 12;
  this.cmd = -1;
  this.payload = null;

  this._init();
}

utils.inherits(Parser, EventEmitter);

Parser.prototype._init = function _init(str) {
};

Parser.prototype._error = function _error(str) {
  this.emit('error', new Error(str));
};

Parser.prototype.feed = function feed(data) {
  var chunk, off, len;

  this.total += data.length;
  this.pending.push(data);

  while (this.total >= this.waiting) {
    chunk = new Buffer(this.waiting);
    off = 0;
    len = 0;

    while (off < chunk.length) {
      len = this.pending[0].copy(chunk, off);
      if (len === this.pending[0].length)
        this.pending.shift();
      else
        this.pending[0] = this.pending[0].slice(len);
      off += len;
    }

    assert.equal(off, chunk.length);

    this.total -= chunk.length;
    this.parse(chunk);
  }
};

Parser.prototype.parse = function parse(chunk) {
  var checksum;

  if (chunk.length > constants.MAX_MESSAGE) {
    this.waiting = 12;
    this.cmd = -1;
    return this._error('Packet too large: %dmb.', utils.mb(chunk.length));
  }

  if (this.cmd === -1) {
    this.cmd = this.parseHeader(chunk);
    return;
  }

  this.payload = chunk;

  try {
    this.payload = this.parsePayload(this.cmd, this.payload);
  } catch (e) {
    this.emit('error', e);
    this.waiting = 12;
    this.cmd = -1;
    return;
  }

  this.emit('packet', this.payload);
  this.waiting = 12;
  this.cmd = -1;
};

Parser.prototype.parseHeader = function parseHeader(h) {
  var magic = h.readUInt32BE(0, true);
  var cmd = h.readUInt32BE(4, true);
  var size = h.readUInt32BE(8, true);

  if (magic !== this.network.magic)
    return this._error('Invalid magic value: ' + magic.toString(16));

  if (size > constants.MAX_MESSAGE) {
    this.waiting = 12;
    return this._error('Packet length too large: %dmb', utils.mb(size));
  }

  this.waiting = size;

  return cmd;
};

Parser.prototype.parsePayload = function parsePayload(cmd, data) {
  return wire.fromRaw(cmd, data);
};

function Peer(myID, addr, lnid, network) {
  var self = this;
  EventEmitter.call(this);
  this.myID = myID;
  this.addr = addr;
  this.lnid = lnid;
  this.network = network || bcoin.network.get();
  this.conn = new Connection();
  this.parser = new Parser(this);
  this.conn.on('connect', function() {
    self.emit('connect');
  });
  this.conn.on('data', function(data) {
    self.parser.feed(data);
  });
  this.conn.on('error', function(err) {
    self.emit('error', err);
  });
  this.parser.on('packet', function(msg) {
    console.log(msg);
    self.emit('packet', msg);
  });
}

utils.inherits(Peer, EventEmitter);

Peer.prototype.connect = function connect() {
  this.conn.connect(this.myID, this.addr, this.lnid);
};

Peer.prototype.send = function send(msg) {
  return this.write(msg.cmd, msg.toRaw());
};

Peer.prototype.frame = function frame(cmd, payload) {
  var packet = new Buffer(12 + payload.length);
  packet.writeUInt32BE(this.network.magic, 0, true);
  packet.writeUInt32BE(cmd, 4, true);
  packet.writeUInt32BE(payload.length, 8, true);
  payload.copy(packet, 12);
  return packet;
};

Peer.prototype.write = function write(cmd, payload) {
  return this.conn.write(this.frame(cmd, payload));
};

module.exports = Parser;
