'use strict';

const express = require('express'),
  app = express(),
  server = require('http').createServer(app),
  io = require('socket.io').listen(server),
  request = require('request'),
  async = require('async'),
  _ = require('underscore'),
  logger = io.log,
  zmq = require('zmq');

/**
 * Server setup
 */

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
  // io.set('origins', 'http://node-socketio.herokuapp.com:*');
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
  logger.info('Server ' + process.pid + ' listening on', port);
});

/**
 * Infrastructure and security settings
 */
const fetcherAddress = process.env.FETCHER_ADDRESS || 'http://node-fetcher.herokuapp.com/fetchlist/new/';
const authorizationHeaderKey = 'bm9kZS1mZXRjaGVy';
const nodeFetcherAuthorizationHeaderKey = 'bm9kZS13ZWJzb2NrZXQ=';
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

  logger.info('Resource Required Publisher listening for subscribers...');
});

const resourceUpdatedSubscriber = zmq.socket('sub').connect('tcp://localhost:5433');
resourceUpdatedSubscriber.subscribe('');

resourceUpdatedSubscriber.on('message', function (data) {
  var resource = JSON.parse(data); 

  handleResourceDataReceived(resource);
});

function handleResourceDataReceived(resource) {
  logger.info('Received resource data for resource id (' + resource.id + ')');

  storeResourceData(resource);
  notifyObservers(resource.id);
}


/**
 * Implementation of public endpoints
 */

var resourceData = {}; // key = resourceId, value = resource
var resourceObservers = {}; // key = resourceId, value = clientConnection[]

function isValidConnection(clientConnection) {
  var resourceId = clientConnection.handshake.query.resourceId;

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
  resourceData[resource.id] = resource;

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
  var resource = resourceData[resourceId];

  if (currentResourceObservers) {

    async.forEach(currentResourceObservers, function(thisObserver){

      if (thisObserver) {
        if (!thisObserver.disconnected) {
          sendResourceDataToObserver(thisObserver, resource);
        } else {
          // We need to find the index ourselves, see https://github.com/caolan/async/issues/144
          var i = getTheIndexOfTheObserver(currentResourceObservers, thisObserver);

          unobserveResource(currentResourceObservers, resourceId, i);
        }
      }
    },
    function(err){
      logger.error('Cant broadcast resource data to watching observer:', err);  
    });        
  } else {
    if (!currentResourceObservers) {
      logger.warn('No observers watching this resource');
    } else {
      logger.warn('No new resource data (' + resource + ')');
    }
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

function sendResourceDataToObserver(clientConnection, resource) {
  clientConnection.emit('data', resource);
}

function requestResource(resourceId) {
  logger.debug('Requested resource (id: ' + resourceId + ') does not exist, sending a resource request');

  resourceRequiredPublisher.send(JSON.stringify({id: resourceId}));
}

/**
 * Logging
 */

function logNewObserver(clientConnection) {
  logger.debug('Requested resource id:', clientConnection.handshake.query.resourceId);
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

