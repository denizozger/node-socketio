require('nodetime').profile({
    accountKey: '7724d01175fed4cb54a011b85769b7b58a15bf6d', 
    appName: 'Node.js Application'
  });

var express = require('express')
  , app = express()
  , server = require('http').createServer(app)
  , io = require('socket.io').listen(server)
  , request = require('request')
  , async = require('async')
  , _ = require('underscore')
  , logger = io.log;

io.configure('production', function(){
	io.enable('browser client minification');  // send minified client
	io.enable('browser client etag');          // apply etag caching logic based on version number
	io.enable('browser client gzip');          // gzip the file
	io.set('log level', 2);                    // reduce logging. 0: error, 1: warn, 2: info, 3: debug

	io.set('transports', [
	    'websocket'
	  , 'flashsocket'
	  , 'htmlfile'
	  , 'xhr-polling'
	  , 'jsonp-polling'
	]);
  io.set('origins', 'http://node-socketio.herokuapp.com:*');
});

io.configure('development', function(){
  io.set('transports', ['websocket']);
});

app.use(express.static(__dirname + '/'));
app.use(express.json());
app.use(express.urlencoded());
app.enable('trust proxy');

app.use(function (err, req, res, next) {
  console.error(err.stack);
  res.send(500, 'Internal server error');
});

const port = process.env.PORT || 5000

server.listen(port, function() {
  logger.info('Server listening on', port);
});

// Infrastructure and security settings
const fetcherAddress = process.env.FETCHER_ADDRESS || 'http://node-fetcher.herokuapp.com/fetchlist/new/';
const authorizationHeaderKey = 'bm9kZS1mZXRjaGVy';
const nodeFetcherAuthorizationHeaderKey = 'bm9kZS13ZWJzb2NrZXQ=';

/**
 * Data models that hold resource -> resourcedata, and resource -> observers 
 */
var resourceData = {};
var resourceObservers = {};

/**
 * Public Endpoints
 */
app.get('/', function getIndex(req, res, next) {
  res.sendfile(__dirname + '/index.html');
});

io.sockets.on('connection', function onWebSocketConnection (webSocketClient) {
  handleNewClientConnection(webSocketClient); 
});

app.post('/broadcast/?*', function broadcast (req, res, next) {

  var resourceId = req.params[0];
  var newResourceData = req.body.newResourceData;

  // Security
  if (!isThisHTTPRequestAllowedToPostData(req) || !isValidBroadcastRequest(resourceId, newResourceData)) {
    res.writeHead(403, {
      'Content-Type': 'text/plain'
    }); 
    res.shouldKeepAlive = false;
    res.end();
    return;
  }

  storeAndBroadcastNewResourceData(resourceId, newResourceData);

  // Send success to data fetcher
  res.writeHead(200, {
    'Content-Type': 'text/plain'
  });
  res.end();
});

/**
 * Implementation of public endpoints
 */

function handleNewClientConnection(webSocketClient) {
  consoleLogNewConnection(webSocketClient);

  var resourceId = webSocketClient.handshake.query.resourceId;

  if (!isValidConnection(resourceId)) {
    webSocketClient.disconnect();
    return;
  }

  addClientAsAnObserverToThisResource(resourceId, webSocketClient);

  var existingResourceData = resourceData[resourceId];

  if (existingResourceData) {
    sendResourceDataToObserver(webSocketClient, existingResourceData);
  } else {
    requestResourceFromFetcherAsync(resourceId, function(val){
        requestResourceFromFetcherSync(val);
    });
  }
}

function addClientAsAnObserverToThisResource(resourceId, webSocketClient) {
  var requestedResourcesCurrentObservers = resourceObservers[resourceId];

  if (!requestedResourcesCurrentObservers) { // this is the first observer requesting this resource
    requestedResourcesCurrentObservers = [];
  }

   // add the new observer to current observers
  requestedResourcesCurrentObservers.push(webSocketClient);
  resourceObservers[resourceId] = requestedResourcesCurrentObservers;
  consoleLogResourceObservers();

  // Actions to take when client leaves
  webSocketClient.on('disconnect', function () {
    removeObserverFromResourceObservers(this);
    consoleLogLeavingObserverEvent(this);
  });
}

function requestResourceFromFetcherAsync(val, callback){
  process.nextTick(function() {
      callback(val);
      return;
  });  
}

function requestResourceFromFetcherSync(resourceId) {
    logger.debug('Requested resource (id: ' + resourceId + ') does not exist, broadcasting a resource request');

    request({
      uri: fetcherAddress + resourceId,
      method: 'GET',
      form: {
        resourceId: resourceId
      },
      headers: {
        Authorization: nodeFetcherAuthorizationHeaderKey
      }
    }, function(error, response, body) {
      if (!error && response.statusCode == 200) {
        logger.info('Successfully requested resource (id: ' + resourceId + ') from ' + fetcherAddress + 
          ', the response is ' + body); 
      } else {
        logger.error('Can not request resource from Fetcher (' + fetcherAddress + resourceId + '):', error);
      }
    });
}

function sendResourceDataToObserver(webSocketClient, resourceData) {
  webSocketClient.emit('data', JSON.parse(resourceData));
}

/**
 * Receiving new resource data and pushing it to observers who are connected to that resource's stream.
 * This method processes a basic HTTP post with form data sumitted as JSON.
 * Form data should contain resource data.
 */
function storeAndBroadcastNewResourceData(resourceId, newResourceData) {
  logger.info('[Received] resource details (' + newResourceData + ') for resource id (' + resourceId + ')');
  
  // store new data
  resourceData[resourceId] = newResourceData;

  // notify observers
  var observersWatchingThisResource = resourceObservers[resourceId];
  broadcastMessageToObserversWatchingThisResourceAsync(observersWatchingThisResource, newResourceData);

  consoleLogResource();
}  

function broadcastMessageToObserversWatchingThisResourceAsync(observersWatchingThisResource, newResourceData) {
  if (observersWatchingThisResource && newResourceData) {
    async.forEach(observersWatchingThisResource, function(watchingClient){
        if (_.isObject(watchingClient)) {
          sendResourceDataToObserver(watchingClient, newResourceData);
        } else {
          logger.error('Cant send new resource data to watching observer - watching observer is not an object');
        }   
    },
    function(err){
      logger.error('Cant broadcast resource data to watching observer:', err);  
    });

    logger.info('[Sent] Client size: ', observersWatchingThisResource ? observersWatchingThisResource.length : 0);
  } else {
    if (! observersWatchingThisResource) {
      logger.warn('No observers watching this resource');
    } else {
      logger.warn('No new resource data (' + newResourceData + ')');
    }
  }
}

function removeObserverFromResourceObservers(leavingClient) {
    for (var resourceId in resourceObservers) {      
      
      if(resourceObservers.hasOwnProperty(resourceId)){
        var observersWatchingThisResource = resourceObservers[resourceId];

          for (var i = 0; i < observersWatchingThisResource.length; i++) {
            var observer = observersWatchingThisResource[i];

            if (observer && observer === leavingClient) {
              observersWatchingThisResource.splice(i, 1);
              logger.debug('Removed the leaving observer from ResourceClients object');

              // If this was the last observer watching this resource, remove the resource from ResourceClients and ResourceData
              if (observersWatchingThisResource.length === 0) { 
                logger.debug('This was the last observer watching this resource, removing the resource from memory');
                delete resourceObservers[resourceId];
                delete resourceData[resourceId];
              } 
            }
          }
      }
    }
}

function isThisHTTPRequestAllowedToPostData(req) {
  if (req.headers.authorization !== authorizationHeaderKey) {
    var ip = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || req.connection.socket.remoteAddress;

    logger.warn('Unknown server (' + ip + ') tried to post resource data');
    return false;
  }
  return true;
}

function isValidConnection(resourceId) {
  if (!resourceId) {
    logger.warn('Bad resource id (' + resourceId + ') is requested, closing the socket connection');
    return false;
  }

  return true;
}

function isValidBroadcastRequest(resourceId, newResourceData) {
	try {
		JSON.parse(newResourceData);
	} catch (ex) {
		logger.warn('Received resource data is not valid: ' + newResourceData);
		return false;
	}

	if (!resourceId) {
		logger.warn('Corrupt resource id');
	}

	return true;
}

function consoleLogNewConnection(webSocketClient) {
  if (_.isObject(webSocketClient)) {
    logger.debug('Requested resource id:', webSocketClient.handshake.query.resourceId);
    logger.debug('WebSocket connections size: ', io.rooms[''].length > 0 ? io.rooms[''].length - 1 : 0);
  } else {
    logger.error('New WebSocketClient is not passed as a parameter');
  }
}

function consoleLogResource() {
  logger.debug('Current resource data:');
  logger.debug(JSON.stringify(resourceData, null, 4));
}

function consoleLogLeavingObserverEvent(webSocketClient) {
  logger.debug('WebSocket connections size: ', io.rooms[''].length > 0 ? io.rooms[''].length - 1 : 0);
  consoleLogResourceObservers();
}

function consoleLogResourceObservers() {
  for (var resourceId in resourceObservers) {
    if (resourceObservers.hasOwnProperty(resourceId)) {
      logger.debug('Current resource observer count for resourceId ' + resourceId + ' is ' + resourceObservers[resourceId].length);
    }
  }
}
