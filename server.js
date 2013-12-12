'use strict';

const express = require('express'),
  app = express(),
  server = require('http').createServer(app),
  io = require('socket.io').listen(server),
  request = require('request'),
  logger = io.log,
  zmq = require('zmq'),
  stronglopp = require('strong-agent').profile(),
  memwatch = require('memwatch');

var storeHD;
var storeDiff;
var notifyHD;
var notifyDiff;

memwatch.on('leak', function(info) {

  // if (storeDiff && notifyDiff && resourceObservers['matchesfeed/1/matchcentre'].length === 150) {

    // logger.error('STORE HD: ' + JSON.stringify(storeDiff, null, 2));
    // logger.error('NOTIFY HD: ' + JSON.stringify(notifyDiff, null, 2));

    logger.error(JSON.stringify(info, null, 2));

    process.exit();
  // } else {
    // logger.error('Not there yet.. ' + resourceObservers['matchesfeed/1/matchcentre'].length + ' / 150');
  // }

});

memwatch.on('stats', function(stats) {
  logger.warn(stats);
});

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
  io.set('log level', 3);                    // reduce logging. 0: error, 1: warn, 2: info, 3: debug
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
 
io.sockets.on('connection', function (socket) {
  handleClientConnected(socket);
});

function handleClientConnected(clientConnection) {
  if (!isValidConnection(clientConnection)) {
    clientConnection.disconnect();
  }

  var resourceId = getResourceId(clientConnection);
  
  clientConnection.join(resourceId);
  logNewObserver(clientConnection, resourceId);

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

  // if (resourceObservers['matchesfeed/1/matchcentre'].length === 150) {
    // storeHD = new memwatch.HeapDiff();
  // }

  storeResourceData(resource);
  
  // if (resourceObservers['matchesfeed/1/matchcentre'].length === 150) {
    // storeDiff = storeHD.end();
    // notifyHD = new memwatch.HeapDiff();
  // }

  notifyObservers(resource.id);

  // if (resourceObservers['matchesfeed/1/matchcentre'].length === 150) {
    // notifyDiff = notifyHD.end();
  // }

  // console.log(JSON.stringify(diff, null, 2));
}

/**
 * Implementation of public endpoints
 */

var resourceData = {}; // key = resourceId, value = resourceData

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

function notifyObservers(resourceId) {
  var data = resourceData[resourceId];

  io.sockets.in(resourceId).emit('data', data);
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

function logNewObserver(clientConnection, resourceId) {
  logger.info('New connection for ' + resourceId + '. This resource\'s observers: ' + 
    io.sockets.clients(resourceId).length + ', Total observers : ' + (io.rooms[''] ? io.rooms[''].length : 0));
}

function logAllResources() {
  logger.debug('Total resources in memory: ' + Object.keys(resourceData).length);
  // logger.debug(JSON.stringify(resourceData, null, 4));
}

function closeAllSockets() {
  resourceRequiredPublisher.close();
  resourceUpdatedSubscriber.close(); 
}

process.on('uncaughtException', function (err) {
  logger.error('Caught exception: ' + err.stack);    
  closeAllSockets();
  process.exit(1);
}); 

process.on('SIGINT', function() {
  closeAllSockets
  process.exit();
});

