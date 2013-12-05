// npm install socket.io socket.io-client
var io = require("socket.io-client");

var sockets = [];
var maxSockets = process.argv[2] || 100;

function connectToWebSocket() {
	for (var i = 0; i < 10; i++) {
		var socket = io.connect('http://localhost:5000/?resourceId=matchesfeed/8/matchcentre', {transports : ['websocket'], 'force new connection':true});
  		sockets.push(socket);
	}

	console.log('Total sockets: ' + sockets.length);

	if (sockets.length < maxSockets) {
		setTimeout(connectToWebSocket, 1000);
	} 
};

connectToWebSocket();
