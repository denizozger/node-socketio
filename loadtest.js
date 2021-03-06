// npm install socket.io socket.io-client npmlog
var io = require("socket.io-client");
var log = require('npmlog');

log.level = 'verbose';

var sockets = [];
var maxSockets = 140; // max is below 130
var connectionAttempts = 0;

function connectToWebSocket() {
  connectionAttempts++;

  // var socket = io.connect('http://localhost:5000/?resourceId=matchesfeed/' + Math.floor((Math.random()*5)+1) + '/matchcentre', {transports : ['websocket'], 'force new connection':true});
  var socket = io.connect('http://localhost:5000/?resourceId=matchesfeed/1/matchcentre', 
    {
      transports : ['websocket'], 
      'force new connection' :true
    });

  // console.log(JSON.stringify(this.socket, censor(this.socket), 4));

  socket.on('connecting', function () {
    log.verbose('Connecting ' + this.socket.sessionid);
  });

  socket.on('connect', function () {
    log.info('Connected ' + this.socket.sessionid); 

    socket.on('disconnect'), function() {
      log.warn('Disconnected ' + this.socket.sessionid);  
    }
  });   

  socket.on('connect_failed', function () {
    log.warn('Connect failed ' + this.socket.sessionid);
  });

  socket.on('error', function (error) {
    log.error('Error:' + error + ' id:' + this.socket.sessionid);
  });

  socket.on('reconnect_failed', function () {
    log.warn('Reconnect failed ' + this.socket.sessionid);
  });

  socket.on('reconnect', function () {
    log.info('Reconnected ' + this.socket.sessionid);
  });

  socket.on('reconnecting', function () {
    log.verbose('Reconnecting ' + this.socket.sessionid);
  });

  sockets.push(socket);

  if (connectionAttempts < maxSockets) {
    setTimeout(connectToWebSocket, 500);
  } 

};

connectToWebSocket();

function censor(censor) {
  return (function() {
    var i = 0;

    return function(key, value) {
      if(i !== 0 && typeof(censor) === 'object' && typeof(value) == 'object' && censor == value) 
        return '[Circular]'; 

      if(i >= 29) // seems to be a harded maximum of 30 serialized objects?
        return '[Unknown]';

      ++i; // so we know we aren't using the original object anymore

      return value;  
    }
  })(censor);
}

/**

Order of Client Events

When you first connect:
connecting
connect

When you momentarily lose connection:
disconnect
reconnecting (1 or more times)
connecting
reconnect
connect

Losing connection completely:
disconnect
reconnecting (repeatedly)

*/