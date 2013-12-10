// npm install socket.io socket.io-client
var io = require("socket.io-client");
var log = require('npmlog');

log.level = 'silly';

var sockets = [];
var maxSockets = 10;
var connectionAttempts = 0;

function connectToWebSocket() {
	for (var i = 1; i < maxSockets + 1; i++) {
		connectionAttempts++;
		
		// var socket = io.connect('http://localhost:5000/?resourceId=matchesfeed/' + Math.floor((Math.random()*5)+1) + '/matchcentre', {transports : ['websocket'], 'force new connection':true});
		var socket = io.connect('http://localhost:5000/?resourceId=matchesfeed/1/matchcentre', {transports : ['websocket'], 'force new connection':true});

		socket.on('connecting', function () {
	  	log.verbose('Connecting');
	  });

		socket.on('connect', function () {
	  	log.info('Connected'); //Open sockets: ' + sockets.length + ' / ' + maxSockets + '. Total attempts: ' + connectionAttempts
	  });		

		socket.on('connect_failed', function () {
	  	log.warn('Connect failed');
	  });

	  socket.on('error', function () {
	  	log.error('Error');
	  });

	  socket.on('reconnect_failed', function () {
	  	log.warn('Reconnect failed');
	  });

	  socket.on('reconnect', function () {
	  	log.info('Reconnected');
	  });

	  socket.on('reconnecting', function () {
	  	log.verbose('Reconnecting');
	  });

	  sockets.push(socket);
	}
};

connectToWebSocket();

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