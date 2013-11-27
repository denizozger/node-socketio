var express = require('express')
    , app = express()
    , server = require('http').createServer(app)
    , io = require('socket.io').listen(server)
    , request = require('request')
    , async = require('async')
    , _ = require('underscore')
    , logger = io.log;

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
    logger.info('Server listening on', port);
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

app.post('/broadcast/?*', function (request, response) {
    var resourceId = request.params[0];
    var newResourceData = request.body.newResourceData;

    if (!isValidRequest(request)) {
        return;
    }

    handleResourceDataReceived({
        id: resourceId,
        data: newResourceData
    });

    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end();
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

function handleResourceDataReceived(resource) {
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

function isValidRequest(request) {
    if (!isThisHTTPRequestAllowedToPostData(request) || !isValidBroadcastRequest(request)) {
        res.writeHead(403, {
            'Content-Type': 'text/plain'
        }); 
        res.shouldKeepAlive = false;
        res.end();

        return false;
    }

    return true;
}

function isThisHTTPRequestAllowedToPostData(request) {
    if (request.headers.authorization !== authorizationHeaderKey) {
        var ip = request.ip || request.connection.remoteAddress || request.socket.remoteAddress || request.connection.socket.remoteAddress;

        logger.warn('Unknown server (' + ip + ') tried to post resource data');
        return false;
    }

    return true;
}

function isValidBroadcastRequest(request) {
    var resourceId = request.params[0];
    var newResourceData = request.body.newResourceData;

    try {
        JSON.parse(newResourceData);
    } catch (ex) {
        logger.warn('Received resource data is not valid: ' + newResourceData);
        return false;
    }

    return true;
}

function getResourceId(clientConnection) {
    return clientConnection.handshake.query.resourceId;
}

function storeResourceData(resource) {
    logger.info('Received resource data for resource id (' + resource.id + ')');

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
        for (var i = 0, l = currentResourceObservers.length; i < l; i++) { 
            var thisObserver = currentResourceObservers[i];

            if (thisObserver) {
                if (!thisObserver.disconnected) {
                    sendResourceDataToObserver(thisObserver, resource);
                } else {
                    unobserveResource(currentResourceObservers, resourceId, i);
                }
            }
        };    
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
    clientConnection.emit('data', resource.data);
}

function requestResource(resourceId) {
    logger.debug('Requested resource (id: ' + resourceId + ') does not exist, sending a resource request');

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

/**
 * Logging
 */

function logNewObserver(clientConnection) {
    logger.debug('Requested resource id:', clientConnection.handshake.query.resourceId);
    logger.info('WebSocket connections size: ', io.rooms[''] ? io.rooms[''].length : 0);
}

function logAllResources() {
    if (debugMode) {
        logger.debug('Current resource data:');
        logger.debug(JSON.stringify(resourceData, null, 4));
    }
}

function logRemovedObserver() {
    logger.info('WebSocket connections size: ', io.rooms[''] ? io.rooms[''].length : 0);
    logResourceObservers();
}

function logResourceObservers() {
    if (debugMode) {
        for (var resourceId in resourceObservers) {
            if (resourceObservers.hasOwnProperty(resourceId)) {
                logger.info(resourceObservers[resourceId].length) + ' observers are watching ' + resourceId );
            }
        }
    }
}

