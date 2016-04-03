/*
 * (C) Copyright 2014-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var path = require('path');
var url = require('url');
var cookieParser = require('cookie-parser')
var express = require('express');
var session = require('express-session')
var minimist = require('minimist');
var ws = require('ws');
var kurento = require('kurento-client');
var fs    = require('fs');
var https = require('https');
var $q = require('q');

var argv = minimist(process.argv.slice(2), {
    default: {
        as_uri: 'https://localhost:8443/',
        ws_uri: 'ws://localhost:8888/kurento'
    }
});

var options =
{
  key:  fs.readFileSync('keys/server.key'),
  cert: fs.readFileSync('keys/server.crt')
};

var app = express();

/*
 * Management of sessions
 */
app.use(cookieParser());

var sessionHandler = session({
    secret : 'none',
    rolling : true,
    resave : true,
    saveUninitialized : true
});

app.use(sessionHandler);
app.use(express.static(path.join(__dirname, 'static')));
/*
 * Definition of global variables.
 */
var sessions = {};
var candidatesQueue = {};
var kurentoClient = null;

/*
 * Server startup
 */
var asUrl = url.parse(argv.as_uri);
var port = asUrl.port;
var server = https.createServer(options, app).listen(port, function() {
    console.log('Kurento Tutorial started');
    console.log('Open ' + url.format(asUrl) + ' with a WebRTC capable browser');
});

var wss = new ws.Server({
    server : server,
    path : '/helloworld'
});


var onIceCandidate = function (sessionId, _candidate) {
    var candidate = kurento.register.complexTypes.IceCandidate(_candidate);

    if (sessions[sessionId]) {
        console.info('Sending candidate');
        var webRtcEndpoint = sessions[sessionId].webRtcEndpoint;
        webRtcEndpoint.addIceCandidate(candidate);
    }
    else {
        console.info('Queueing candidate');
        if (!candidatesQueue[sessionId]) {
            candidatesQueue[sessionId] = [];
        }
        candidatesQueue[sessionId].push(candidate);
    }
},
makeClient = function() {
    var deferer = $q.defer();
    if (kurentoClient !== null) {
        $q.timeout()
            .then(function(){
                deferer.resolve({kurentoClient : kurentoClient});
            });
    }

    kurento(argv.ws_uri, function(error, _kurentoClient) {
        var msg;
        if (error) {
            msg = "Could not find media server at address" + argv.ws_uri
                    + ". Exiting with error " + error;
            deferer.reject(msg);
        } else {
            kurentoClient = _kurentoClient;
            deferer.resolve({kurentoClient : kurentoClient});
        }
    });
    return deferer.promise;
},
start = function(sessionId, ws, sdpOffer) {
    return makeClient()
        .then(function(docs) {
            var deferer = $q.defer();
            docs.kurentoClient.create('MediaPipeline', function(error, pipeline) {
                if (error) {
                    deferer.reject(error);
                } else {
                    docs.pipeline = pipeline
                    deferer.resolve(docs);
                }
            });
            return deferer.promise;
        })
        .then(function(docs){
            var deferer = $q.defer();
            docs.pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
                if (error) {
                    deferer.reject(error, docs);
                } else {
                    docs.webRtcEndpoint = webRtcEndpoint;
                    deferer.resolve(docs);
                }
            });
            return deferer.promise;
        })
        .then(function(docs){
            var webRtcEndpoint = docs.webRtcEndpoint;
            var deferer = $q.defer();

            webRtcEndpoint.on('OnIceCandidate', function(event) {
                var candidate = kurento.register.complexTypes.IceCandidate(event.candidate);
                ws.send(JSON.stringify({
                    id : 'iceCandidate',
                    candidate : candidate
                }));
            });

            webRtcEndpoint.processOffer(sdpOffer, function(error, sdpAnswer) {
                if (error) {
                    deferer.reject(error, docs);
                } else {
                    sessions[sessionId] = {
                        'pipeline' : docs.pipeline,
                        'webRtcEndpoint' : docs.webRtcEndpoint
                    }
                    docs.sdpAnswer = sdpAnswer;
                    deferer.resolve(docs);
                }
            });

            webRtcEndpoint.gatherCandidates(function(error) {
                if (error) {
                    deferer.reject(error);
                }
            });

            return deferer.promise;
        })
        .then(function(docs){
            var deferer = $q.defer();

            if (candidatesQueue[sessionId]) {
                while(candidatesQueue[sessionId].length) {
                    var candidate = candidatesQueue[sessionId].shift();
                    docs.webRtcEndpoint.addIceCandidate(candidate);
                }
            }

            docs.webRtcEndpoint.connect(docs.webRtcEndpoint, function(error) {
                if (error) {
                    deferer.reject(error);
                } else {
                    deferer.resolve(docs);
                }
            });
            return deferer.promise;
        })
        .then(function(docs){
            var deferer = $q.defer();
            docs.pipeline.create('RtpEndpoint', function(err, rtpEndPoint){
                if(err) {
                    deferer.reject(err, docs);
                } else {
                    docs.rtpEndPoint = rtpEndPoint;
                    deferer.resolve(docs);
                }
            });
            return deferer.promise;
        })
        .then(function(docs){
            var deferer = $q.defer();
            var wowzaSdpOffer = '' +
                'v=0\n' +
                'o=- 0 0 IN IP4 192.168.0.2\n' +
                's= \n' +
                'c=IN IP4 192.168.0.2\n' +
                't=0 0 \n' +
                'm=video 15000 RTP/AVP 100 \n' +
                'a=rtpmap:100 H264/90000\n' +
                'a=recvonly\n';
            docs.rtpEndPoint.processOffer(wowzaSdpOffer, function(err, sdpAnswer){
                console.log('RtpEndPoint error \n' + err);
                console.log('RtpEndPoint : \n' + sdpAnswer);
            });

            docs.webRtcEndpoint.connect(docs.rtpEndPoint, function(error) {
                if (error) {
                    console.log('rtpEndPoint err' + error);
                    deferer.reject(error);
                } else {
                    deferer.resolve(docs);
                }
            });

            return deferer.promise;
        })
        .catch(function(err, docs){
            if(docs && docs.pipeline) {
                docs.pipeline.release();
            }
            console.log(err);
        });

},
stop = function(sessionId) {
    if (sessions[sessionId]) {
        var pipeline = sessions[sessionId].pipeline;
        console.info('Releasing pipeline');
        pipeline.release();

        delete sessions[sessionId];
        delete candidatesQueue[sessionId];
    }
};


/*
 * Management of WebSocket messages
 */
wss.on('connection', function(ws) {
    var sessionId = null;
    var request = ws.upgradeReq;
    var response = {
        writeHead : {}
    };

    sessionHandler(request, response, function(err) {
        sessionId = request.session.id;
        console.log('Connection received with sessionId ' + sessionId);
    });

    ws.on('error', function(error) {
        console.log('Connection ' + sessionId + ' error');
        stop(sessionId);
    });

    ws.on('close', function() {
        console.log('Connection ' + sessionId + ' closed');
        stop(sessionId);
    });

    ws.on('message', function(_message) {
        var message = JSON.parse(_message);
        // console.log('Connection ' + sessionId + ' received message ', message);
        console.log('Connection ' + sessionId + ' received message ');

        switch (message.id) {
        case 'start':
            sessionId = request.session.id;

            if (!sessionId) {
                console.log('Cannot use undefined sessionId');
            }

            start(sessionId, ws, message.sdpOffer)
                .then(function(docs){
                    ws.send(JSON.stringify({
                        id : 'startResponse',
                        sdpAnswer : docs.sdpAnswer
                    }));
                })
                .catch(function(err){
                    ws.send(JSON.stringify({
                        id : 'error',
                        message : error
                    }));
                });
            break;

        case 'stop':
            stop(sessionId);
            break;

        case 'onIceCandidate':
            onIceCandidate(sessionId, message.candidate);
            break;

        default:
            ws.send(JSON.stringify({
                id : 'error',
                message : 'Invalid message ' + message
            }));
            break;
        }

    });
});
