'use strict';

const express = require('express'),
  app = express(),
  server = require('http').createServer(app),
  io = require('socket.io').listen(server),
  request = require('request'),
  async = require('async'),
  logger = io.log,
  zmq = require('zmq'),
  stronglopp = require('strong-agent').profile();

/**
 * Server setup
 */

io.configure('production', function(){
  io.enable('browser client minification');  // send minified client
  io.enable('browser client etag');          // apply etag caching logic based on version number
  io.enable('browser client gzip');          // gzip the file
  io.set('log level', 1);                    // reduce logging. 0: error, 1: warn, 2: info, 3: debug

  io.set('transports', [
    'websocket'
    , 'flashsocket'
    , 'homlfile'
    , 'xhr-polling'
    , 'jsonp-polling'
  ]);
  // io.set('origins', 'http://www.example.com:*');
});

io.configure('development', function(){
  io.set('transports', ['websocket']);
  io.set('log level', 2);                    // reduce logging. 0: error, 1: warn, 2: info, 3: debug
});

// io.set('heartbeat timeout', 180); // default: 60
// io.set('heartbeat interval', 60); // default: 25

app.use(express.static(__dirname + '/'));
app.use(express.json());
app.use(express.urlencoded());
app.enable('trust proxy');

const port = process.env.PORT || 5000

server.listen(port, function() {
  logger.info('Server ' + process.pid + ' listening on', port);
});

/**
 * Infrastructure and security settings
 */
const fetcherAddress = process.env.FETCHER_ADDRESS;
const debugMode = process.env.NODE_ENV === 'development';

/**
 * Public Endpoints
 */
 
io.sockets.on('connection', function (webSocketClient) {
  handleClientConnected(webSocketClient);
});

function handleClientConnected(clientConnection) {
  if (!isValidConnection(clientConnection)) {
    clientConnection.disconnect();
  }

  var resourceId = getResourceId(clientConnection);
  observeResource(clientConnection, resourceId);

  var existingResourceData = resourceData.resourceId;

  if (existingResourceData) {
    sendResourceDataToObserver(clientConnection, resourceId);
  } else {
    requestResource(resourceId);
  }
}

const resourceRequiredPublisher = zmq.socket('pub').bind('tcp://*:5432', function(err) {
  if (err) {
    throw Error(err);
  }
  logger.info('Resource Required Publisher listening for subscribers..');
});

const resourceUpdatedSubscriber = zmq.socket('sub').connect('tcp://localhost:5433');
resourceUpdatedSubscriber.subscribe('');

resourceUpdatedSubscriber.on('message', function (data) {
  handleResourceDataReceived(data);
});

function handleResourceDataReceived(data) {
  var resource = JSON.parse(data); 

  logger.debug('Received resource data for resource id (' + resource.id + ')');

  storeResourceData(resource);
  notifyObservers(resource.id);

  // resource.data = null;
}

/**
 * Implementation of public endpoints
 */

var resourceData = {}; // key = resourceId, value = resourceData
var resourceObservers = {}; // key = resourceId, value = clientConnection[]

function isValidConnection(clientConnection) {
  var resourceId = getResourceId(clientConnection);

  if (!resourceId) {
    logger.warn('Bad resource id (' + resourceId + ') is requested, closing the socket connection');
    return false;
  }

  return true;
}

function getResourceId(clientConnection) {
  return clientConnection.handshake.query.resourceId;
}

function storeResourceData(resource) {
  resourceData[resource.id] = resource.data;

  logAllResources();
}

function observeResource(clientConnection, resourceId) {
  var currentResourceObservers = resourceObservers[resourceId] || [];

  currentResourceObservers.push(clientConnection);
  resourceObservers[resourceId] = currentResourceObservers;

  logNewObserver(clientConnection);
}

function notifyObservers(resourceId) {
  var currentResourceObservers = resourceObservers[resourceId];
  var data = resourceData[resourceId];

  if (currentResourceObservers) {

    async.forEach(currentResourceObservers, function(thisObserver){

      if (!thisObserver.disconnected) {
        sendResourceDataToObserver(thisObserver, data);
      } else {
        // We need to find the index ourselves, see https://github.com/caolan/async/issues/144
        // Discussion: When a resource terminates, and all observers disconnect, 
          // currentResourceObservers will still be full.
        var i = getTheIndexOfTheObserver(currentResourceObservers, thisObserver);

        unobserveResource(currentResourceObservers, resourceId, i);
      }
    },
    function(err){
      logger.error('Cant broadcast resource data to watching observer:', err);  
    });        
  } else {
    logger.warn('No observers watching this resource');
  }
}

function getTheIndexOfTheObserver(observersWatchingThisResource, observerToFind) {
  for (var i = 0; i < observersWatchingThisResource.length; i++) {
    var observer = observersWatchingThisResource[i];

    if (observer === observerToFind) {
      return i;
    }
  }
}

function unobserveResource(observersWatchingThisResource, resourceId, indexOfTheObserver) {
  observersWatchingThisResource.splice(indexOfTheObserver, 1);

  if (observersWatchingThisResource.length === 0) { 
    removeResource(resourceId);
  } 
  
  logRemovedObserver();
}

function removeResource(resourceId) {
  logger.debug('Removing resource ( ' + resourceId + ') from memory');

  delete resourceObservers[resourceId];
  delete resourceData[resourceId]; 
}

function sendResourceDataToObserver(clientConnection, resourceData) {
  clientConnection.emit('data', resourceData);
}

function requestResource(resourceId) {
  logger.debug('Requested resource (id: ' + resourceId + ') does not exist, sending a resource request');

  resourceRequiredPublisher.send(JSON.stringify({id: resourceId}));
}

/**
 * Logging
 */

function logNewObserver(clientConnection) {
  logger.debug('Requested resource id:', getResourceId(clientConnection));
  logger.info('New connection. WebSocket connections size: ', io.rooms[''] ? io.rooms[''].length : 0);
}

function logAllResources() {
  if (debugMode) {
    logger.debug('Current resource data:');
    logger.debug(JSON.stringify(resourceData, null, 4));
  }
}

function logRemovedObserver() {
  logger.info('Connection closed. WebSocket connections size: ', io.rooms[''] ? io.rooms[''].length : 0);
  logResourceObservers();
}

function logResourceObservers() {
  if (debugMode) {
    for (var resourceId in resourceObservers) {
      if (resourceObservers.hasOwnProperty(resourceId)) {
        logger.info(resourceObservers[resourceId].length + ' observers are watching ' + resourceId );
      }
    }
  }
}

function closeAllSockets() {
  resourceRequiredPublisher.close();
  resourceUpdatedSubscriber.close(); 
}

process.on('uncaughtException', function (err) {
  logger.error('Uncaught Exception: ' + err.stack);    
  closeAllSockets();
  process.exit(1);
}); 

process.on('SIGINT', function() {
  closeAllSockets
  process.exit();
});

