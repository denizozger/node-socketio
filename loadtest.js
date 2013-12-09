// npm install socket.io socket.io-client
var io = require("socket.io-client");

var sockets = [];
var maxSockets = process.argv[2] || 1000;
var connectionAttempts = 0;

function connectToWebSocket() {
	for (var i = 1; i < 100; i++) {
		connectionAttempts++;
		
		var resourceId = Math.ceil(i / 10);

		// var socket = io.connect('http://localhost:5000/?resourceId=matchesfeed/' + resourceId + '/matchcentre', {transports : ['websocket'], 'force new connection':true});
		var socket = io.connect('http://localhost:5000/?resourceId=matchesfeed/8/matchcentre', {transports : ['websocket'], 'force new connection':true});

		socket.on('connect', function () {
	  	sockets.push(socket);  
	  });		

	  console.log('Open sockets: ' + sockets.length + ' / ' + maxSockets + '. Total attempts: ' + connectionAttempts);
	}

	if (sockets.length < maxSockets) {
		setTimeout(connectToWebSocket, 1000);
	} 
};

connectToWebSocket();
