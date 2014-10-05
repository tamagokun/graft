'use strict';

var expect    = require('must');
var after     = require('after');
var graft     = require('../graft');
var through   = require('through2');
var Readable  = require('readable-stream').Readable;

module.exports = function allTransportTests(buildServer, buildClient) {
  var instance;
  var client;

  beforeEach(function() {
    instance = buildServer();
    client = buildClient(instance);
  });

  afterEach(function closeServer(done) {
    instance.close(function() {
      done();
    });
  });

  afterEach(function closeClient(done) {
    client.close(function() {
      done();
    });
  });

  it('should receive a message', function(done) {
    instance.pipe(through.obj(function(msg, enc, cb) {
      expect(msg.hello).to.eql('world');
      expect(msg._session).to.exist();
      expect(msg._channel).to.exist();
      cb();
      done();
    }));

    client.write({ hello: 'world' });
  });

  it('should receive 50 messages', function(done) {
    var max = 50;

    var allDone = after(max, done);

    instance.pipe(through.obj(function(req, enc, cb) {
      cb();
      allDone();
    }));

    for (var i = 0; i < max; i++) {
      client.write({ hello: 'world' });
    }
  });

  it('should pass the same session', function(done) {
    var session;

    instance.pipe(through.obj(function(req, enc, cb) {
      if (!session) {
        session = req._session;
      } else {
        expect(req._session).to.be(session);
        done();
      }
      cb();
    }));

    client.write({ hello: 'world' });
    client.write({ hello: 'world' });
  });

  it('should support a return channel', function(done) {
    var returnChannel = client.ReadChannel();

    instance.pipe(through.obj(function(msg, enc, cb) {
      var chan = msg.returnChannel;
      delete msg.returnChannel;
      chan.end(msg, cb);
    }));

    client.write({
      hello: 'world',
      returnChannel: returnChannel
    });

    returnChannel.pipe(through.obj(function(msg, enc, cb) {
      expect(msg.hello).to.eql('world');
      cb();
      done();
    }));
  });

  it('should support a second write channel', function(done) {
    var moreChannel = client.WriteChannel();

    instance.pipe(through.obj(function(msg, enc, cb) {
      var chan = msg.moreChannel;
      chan.pipe(through.obj(function(msg, enc, cb) {
        expect(msg.more).to.eql('message');
        cb();
        done();
      }));
      cb();
    }));

    client.write({
      hello: 'world',
      moreChannel: moreChannel
    });

    moreChannel.write({ 'more': 'message' });
  });

  it('should be pipeable in another graft instance', function(done) {
    var instance2 = graft();
    var session;
    var channel;

    instance2
      .pipe(through.obj(function(msg, enc, cb) {
        expect(msg.hello).to.eql('world');
        expect(msg._session).to.be(session);
        expect(msg._channel).to.be(channel);
        done();
        cb();
      }));

    instance
      .pipe(through.obj(function(msg, enc, cb) {
        session = msg._session;
        channel = msg._channel;
        this.push(msg);
        cb();
      }))
      .pipe(instance2);


    client.write({ hello: 'world' });
  });

  it('should support sending a Readable to the other side', function(done) {
    var readable = new Readable();

    readable._read = function() {
      this.push('hello world');
      this.push(null);
    };

    client.write({ readable: readable });

    instance.pipe(through.obj(function(msg, enc, cb) {
      msg.readable.pipe(through(function(chunk, enc, cb) {
        expect(chunk.toString()).to.eql('hello world');
        done();
        cb();
      }));
      cb();
    }));
  });

  describe('embedded channels', function() {
    it('pipe the same on both sides', function(done) {
      var max     = 10;
      var writes  = client.WriteChannel();
      var allDone = after(2, done);

      function countAllWrites(msg, enc, cb) {
        msg.writes.pipe(countDone(allDone));
        cb();
      }

      function countDone(cb) {
        var allDone = after(max, cb);
        return through.obj(function(msg, enc, cb)  {
          cb();
          allDone();
        });
      }

      instance.pipe(through.obj(countAllWrites));
      client.pipe(through.obj(countAllWrites));

      client.write({ writes: writes });

      for (var i = 0; i < max; i++) {
        writes.write({ value : i });
      }
    });

    it('echoed messages pipe the same on both sides', function(done) {
      var max           = 10;
      var writes        = client.WriteChannel();
      var returnChannel = client.ReadChannel();
      var allDone       = after(2, done);
      var intercept     = through.obj();

      function countDone(logKey, cb) {
        var allDone = after(max, cb);
        return through.obj(function(msg, enc, cb)  {
          console.log(logKey, msg)
          cb();
          allDone();
        });
      }

      intercept.pipe(writes);
      intercept.pipe(countDone('before-send', allDone));

      instance.pipe(through.obj(function(msg, enc, cb) {
        msg.returnChannel.end(msg);
        cb();
      }));

      returnChannel.pipe(through.obj(function(msg, enc, cb) {
        console.log('back!!')
        msg.writes.pipe(countDone('echo', allDone));
        cb();
      }));

      client.write({
        returnChannel: returnChannel,
        writes: writes
      });

      for (var i = 0; i < max; i++) {
        intercept.write({ value : i });
      }
    });
  });
};
