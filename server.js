'use strict';

const express = require('express'),
  app = express(),
  server = require('http').createServer(app),
  io = require('socket.io').listen(server),
  request = require('request'),
  logger = io.log,
  zmq = require('zmq'),
  strongloop = require('strong-agent').profile(),
  memwatch = require('memwatch');

require('nodetime').profile({
  accountKey: '7724d01175fed4cb54a011b85769b7b58a15bf6d', 
  appName: 'WSS1'
});

/**
 * Server setup
 */
io.configure('production', function(){
  io.set('log level', 1); // reduce logging. 0: error, 1: warn, 2: info, 3: debug

  io.set('transports', [
    'websocket',
    'flashsocket',
    'homlfile',
    'xhr-polling',
    'jsonp-polling'
  ]);
  // io.set('origins', 'http://www.example.com:*');
});

io.configure('development', function(){
  io.set('transports', ['websocket']);
  io.set('log level', 2); // reduce logging. 0: error, 1: warn, 2: info, 3: debug
});

io.enable('browser client minification'); // send minified client
io.enable('browser client etag'); // apply etag caching logic based on version number
io.enable('browser client gzip'); // gzip the file
// io.set('heartbeat timeout', 180); // default: 60
// io.set('heartbeat interval', 60); // default: 25

app.use(express.static(__dirname + '/'));
app.use(express.json());
app.use(express.urlencoded());
app.enable('trust proxy');

const port = process.env.PORT || 5000;

server.listen(port, function() {
  logger.info('Server ' + process.pid + ' listening on', port);
});

/**
 * Infrastructure and security settings
 */
const fetcherAddress = process.env.FETCHER_ADDRESS;
var resourceData = {}; // key = resourceId, value = resourceData

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

// Publish a resource request for a resrouce that we don't have in memory (ie. in resourceData)
const resourceRequiredPublisher = zmq.socket('pub').bind('tcp://*:5432');
// Receive new resource data
const resourceUpdatedSubscriber = zmq.socket('sub').connect('tcp://localhost:5433');
resourceUpdatedSubscriber.subscribe('');

resourceUpdatedSubscriber.on('message', function (data) {
  handleResourceDataReceived(data);
});

var hd = {};
var diff = {};

function handleResourceDataReceived(data) {
  var resource = JSON.parse(data); 
  logger.debug('Received resource data for resource id (' + resource.id + ')');

  storeResourceData(resource);

  notifyObservers(resource.id);
}

/**
 * Implementation of public endpoints
 */

function sendResourceDataToObserver(clientConnection, resourceData) {
  clientConnection.emit('data', resourceData);
}

function requestResource(resourceId) {
  logger.debug('Requested resource (id: ' + resourceId + ') does not exist, sending a resource request');

  resourceRequiredPublisher.send(JSON.stringify({id: resourceId}));
}

function storeResourceData(resource) {
  resourceData[resource.id] = resource.data;

  logAllResources();
}

function notifyObservers(resourceId) {
  var data = resourceData[resourceId];

  if (getTotalObserverCount() === 130) {
    hd = new memwatch.HeapDiff();
  }

  io.sockets.in(resourceId).emit('data', data);

  if (getTotalObserverCount() === 130) {
    diff = hd.end(); 
    console.log(JSON.stringify(diff, null, 2));
  }
}

function getResourceId(clientConnection) {
  return clientConnection.handshake.query.resourceId;
}

function isValidConnection(clientConnection) {
  var resourceId = getResourceId(clientConnection);

  if (!resourceId) {
    logger.warn('Bad resource id (' + resourceId + ') is requested, closing the socket connection');
    return false;
  }

  return true;
}

/**
 * Monitoring / debugging
 */
 memwatch.on('leak', function(info) {
  logger.error('Memory Leak detected:');
  logger.error(JSON.stringify(info, null, 2));

  // process.exit();
});

memwatch.on('stats', function(stats) {
  logger.warn(stats);
});

/**
 * Logging
 */

function logNewObserver(clientConnection, resourceId) {
  logger.info('New connection for ' + resourceId + '. This resource\'s observers: ' + 
    io.sockets.clients(resourceId).length + ', Total observers : ' + getTotalObserverCount());
  logger.debug('This client is present in these rooms: ' + 
    JSON.stringify(io.sockets.manager.roomClients[clientConnection.id], null, 4));
}

function getTotalObserverCount() {
  return io.rooms[''] ? io.rooms[''].length : 0;
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
  closeAllSockets();
  process.exit();
});

