var app = require('express')()
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
  // io.set('origins', 'http://example.com:*');
});

io.configure('development', function(){
  io.set('transports', ['websocket']);
  io.set('origins', 'http://localhost:*');
});

server.listen(80);

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
app.get('/', function (req, res) {
  res.sendfile(__dirname + '/index.html');
});

io.sockets.on('connection', function (webSocketClient) {
  handleNewClientConnection(webSocketClient); 
});

app.post('/broadcast/?*', function (req, res) {
  // Security
  if (!isThisHTTPRequestAllowedToPostData(req) || !isValidBroadcastRequest(req)) {
    res.writeHead(403, {
      'Content-Type': 'text/plain'
    }); 
    res.shouldKeepAlive = false;
    res.end();
    return;
  }

  var resourceId = req.params[0].substring(0, req.params[0].length - 1);
  var newResourceData = req.query['newResourceData'];

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
  logger.info('Received resource details (' + newResourceData + ') for resource id (' + resourceId + ')');
  
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
  } else {
    logger.warn('No observers watching this resource (' + observersWatchingThisResource + 
      ') or no new resource data (' + newResourceData + ')');
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

function isValidBroadcastRequest(req) {
	try {
		var resourceId = req.params[0].substring(0, req.params[0].length - 1);
	  	var newResourceData = req.query['newResourceData'];	

	  	try {
  			JSON.parse(newResourceData);
	  	} catch (ex) {
	  		logger.warn('Received resource data is not valid: ' + newResourceData);
	  		return false;
	  	}
  	} catch (e) {
  		logger.warn('Received resource id is not valid');
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
