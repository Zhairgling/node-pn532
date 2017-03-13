'use strict';
//                  //          //     initiator

var util = require('util');
//var Promise = require('bluebird');
var EventEmitter = require('events').EventEmitter;

var setupLogging = require('./logs');
setupLogging(process.env.PN532_LOGGING);
var logger = require('winston').loggers.get('pn532');

var FrameEmitter = require('./frame_emitter').FrameEmitter;
var frame = require('./frame');
var DataFrame = frame.DataFrame;
var AckFrame = frame.AckFrame;
var c = require('./constants');

class PN532 extends EventEmitter {
    /*
        @constructor
        @param {object} hal - An instance of node-serialport's SerialPort or node-i2c's i2c
    */
    constructor(hal, options) {
        super();
        options = options || {};
        this.pollInterval = options.pollInterval || 1000;

        if (hal.constructor.name === 'SerialPort') {
            var PN532_UART = require('./pn532_uart');
            this.hal = new PN532_UART(hal);
        } else if (hal.constructor.name === 'i2c') {
            var PN532_I2C = require('./pn532_i2c');
            this.hal = new PN532_I2C(hal);
        } else {
            throw new Error('Unknown hardware type: ', hal.constructor.name);
        }

        this.frameEmitter = new FrameEmitter(this.hal);
        this.hal.init().then(() => {
            this.configureSecureAccessModule().then(() => this.emit('ready'));
        });

        this.on('newListener', (event) => {
            // TODO: Only poll once (for each event type)
            if (event === 'tag') {
                logger.debug('Polling for tag scans...');
                var scanTag = () => {
                    this.scanTag().then((tag) => {
                        this.emit('tag', tag);
                        setTimeout(() => scanTag(), this.pollInterval);
                    });
                };
                scanTag();
            }
        });
    }

    sendCommand(commandBuffer) {
        return new Promise((resolve, reject) => {

            var removeListeners = () => {
                logger.debug('Removing listeners');
                this.frameEmitter.removeListener('frame', onFrame);
                this.frameEmitter.removeListener('error', onError);
            };

            // Wire up listening to wait for response (or error) from PN532
            var onFrame = (frame) => {
                logger.debug('Response received for sendCommand', util.inspect(frame));
                // TODO: If no ACK after 15ms, resend? (page 40 of user guide, UART only)?

                if (frame instanceof AckFrame) {
                    logger.info('Command Acknowledged', util.inspect(frame));
                } else if (frame instanceof DataFrame) {
                    logger.info('Command Response', util.inspect(frame));
                    removeListeners();
                    resolve(frame);
                }
            };
            this.frameEmitter.on('frame', onFrame);

            var onError = (error) => {
                logger.error('Error received for sendCommand', error);
                removeListeners();
                reject(error);
            };
            this.frameEmitter.on('error', onError);

            // Send command to PN532
            var dataFrame = new DataFrame(commandBuffer);
            var buffer = dataFrame.toBuffer();
            logger.info('Sending buffer:', util.inspect(commandBuffer));
            logger.debug('Sending buffer:', util.inspect(buffer));
            this.hal.write(buffer);
        });
    }

    configureSecureAccessModule() {
        logger.info('Configuring secure access module (SAM)...');

        // TODO: Test IRQ triggered reads

        var timeout = 0x00;  // 0x00-0xFF (12.75 seconds).  Only valid for Virtual card mode (SAMCONFIGURATION_MODE_VIRTUAL_CARD)

        var commandBuffer = [
            c.COMMAND_SAMCONFIGURATION,
            c.SAMCONFIGURATION_MODE_NORMAL,
            timeout,
            c.SAMCONFIGURATION_IRQ_ON // Use IRQ pin
        ];
        return this.sendCommand(commandBuffer);
    }

    getFirmwareVersion() {
        logger.info('Getting firmware version...');

        return this.sendCommand([c.COMMAND_GET_FIRMWARE_VERSION])
            .then((frame) => {
                var body = frame.getDataBody();
                return {
                    IC: body[0],
                    Ver: body[1],
                    Rev: body[2],
                    Support: body[3]
                };
            });
    }

    getGeneralStatus() {
        logger.info('Getting general status...');

        return this.sendCommand([c.COMMAND_GET_GENERAL_STATUS])
            .then((frame) => {
                var body = frame.getDataBody();
                return body;
            });
    }

    scanTag() {
        logger.info('Scanning tag...');

        var maxNumberOfTargets = 0x01;
        var baudRate = c.CARD_ISO14443A;

        var commandBuffer = [
            c.COMMAND_IN_LIST_PASSIVE_TARGET,
            maxNumberOfTargets,
            baudRate
        ];

        return this.sendCommand(commandBuffer)
            .then((frame) => {
                var body = frame.getDataBody();
                logger.debug('body', util.inspect(body));

                var numberOfTags = body[0];
                if (numberOfTags === 1) {
                    var tagNumber = body[1];
                    var uidLength = body[5];

                    var uid = body.slice(6, 6 + uidLength)
                                  .toString('hex')
                                  .match(/.{1,2}/g)
                                  .join(':');

                    return {
                        ATQA: body.slice(2, 4), // SENS_RES
                        SAK: body[4],           // SEL_RES
                        uid: uid
                    };
                }
            });
    }

    readBlock(options) {
        logger.info('Reading block...');

        var options = options || {};

        var tagNumber = options.tagNumber || 0x01;
        var blockAddress = options.blockAddress || 0x01;

        var commandBuffer = [
            c.COMMAND_IN_DATA_EXCHANGE,
            tagNumber,
            c.MIFARE_COMMAND_READ,
            blockAddress,
        ];

        return this.sendCommand(commandBuffer)
            .then((frame) => {
                var body = frame.getDataBody();
                logger.debug('Frame data from block read:', util.inspect(body));

                var status = body[0];

                if (status === 0x13) {
                    logger.warn('The data format does not match to the specification.');
                }
                var block = body.slice(1, body.length - 1); // skip status byte and last byte (not part of memory)
                // var unknown = body[body.length];

                return block;
        });
    }

    readNdefData() {
        logger.info('Reading data...');

        return this.readBlock({blockAddress: 0x04})
            .then((block) => {
                logger.debug('block:', util.inspect(block));

                // Find NDEF TLV (0x03) in block of data - See NFC Forum Type 2 Tag Operation Section 2.4 (TLV Blocks)
                var ndefValueOffset = null;
                var ndefLength = null;
                var blockOffset = 0;

                while (ndefValueOffset === null) {
                    logger.debug('blockOffset:', blockOffset, 'block.length:', block.length);
                    if (blockOffset >= block.length) {
                        throw new Error('Unable to locate NDEF TLV (0x03) byte in block:', block)
                    }

                    var type = block[blockOffset];       // Type of TLV
                    var length = block[blockOffset + 1]; // Length of TLV
                    logger.debug('blockOffset', blockOffset);
                    logger.debug('type', type, 'length', length);

                    if (type === c.TAG_MEM_NDEF_TLV) {
                        logger.debug('NDEF TLV found');
                        ndefLength = length;                  // Length proceeds NDEF_TLV type byte
                        ndefValueOffset = blockOffset + 2;    // Value (NDEF data) proceeds NDEV_TLV length byte
                        logger.debug('ndefLength:', ndefLength);
                        logger.debug('ndefValueOffset:', ndefValueOffset);
                    } else {
                        // Skip TLV (type byte, length byte, plus length of value)
                        blockOffset = blockOffset + 2 + length;
                    }
                }

                var ndefData = block.slice(ndefValueOffset, block.length);
                var additionalBlocks = Math.ceil((ndefValueOffset + ndefLength) / 16) - 1;
                logger.debug('Additional blocks needing to retrieve:', additionalBlocks);

                // Sequentially grab each additional 16-byte block (or 4x 4-byte pages) of data, chaining promises
                var self = this;
                var allDataPromise = (function retrieveBlock(blockNum) {
                    if (blockNum <= additionalBlocks) {
                        var blockAddress = 4 * (blockNum + 1);
                        logger.debug('Retrieving block:', blockNum, 'at blockAddress:', blockAddress);
                        return self.readBlock({blockAddress: blockAddress})
                            .then(function(block) {
                                blockNum++;
                                ndefData = Buffer.concat([ndefData, block]);
                                return retrieveBlock(blockNum);
                            });
                    }
                })(1);

                return allDataPromise.then(() => ndefData.slice(0, ndefLength));
            })
            .catch(function(error) {
                logger.error('ERROR:', error);
            });
    }

    writeBlock(block, options) {
        logger.info('Writing block...');

        var options = options || {};

        var tagNumber = options.tagNumber || 0x01;
        var blockAddress = options.blockAddress || 0x01;

        var commandBuffer = [].concat([
            c.COMMAND_IN_DATA_EXCHANGE,
            tagNumber,
            c.MIFARE_COMMAND_WRITE_4,
            blockAddress
        ],  block);

        return this.sendCommand(commandBuffer)
            .then((frame) => {
                var body = frame.getDataBody();
                logger.debug('Frame data from block write:', util.inspect(body));

                var status = body[0];

                if (status === 0x13) {
                    logger.warn('The data format does not match to the specification.');
                }
                var block = body.slice(1, body.length - 1); // skip status byte and last byte (not part of memory)
                // var unknown = body[body.length];

                return block;
            });
    }

    writeNdefData(data) {
        logger.info('Writing data...');

        // Prepend data with NDEF type and length (TLV) and append terminator TLV
        var block = [].concat([
            c.TAG_MEM_NDEF_TLV,
            data.length
        ],  data, [
            c.TAG_MEM_TERMINATOR_TLV
        ]);

        logger.debug('block:', util.inspect(new Buffer(block)));

        var PAGE_SIZE = 4;
        var totalBlocks = Math.ceil(block.length / PAGE_SIZE);

        // Sequentially write each additional 4-byte pages of data, chaining promises
        var self = this;
        var allPromises = (function writeBlock(blockNum) {
            if (blockNum < totalBlocks) {
                var blockAddress = 0x04 + blockNum;
                var pageData = block.splice(0, PAGE_SIZE);

                if (pageData.length < PAGE_SIZE) {
                    pageData.length = PAGE_SIZE; // Setting length will make sure NULL TLV (0x00) are written at the end of the page
                }

                logger.debug('Writing block:', blockNum, 'at blockAddress:', blockAddress);
                logger.debug('pageData:', util.inspect(new Buffer(pageData)));
                return self.writeBlock(pageData, {blockAddress: blockAddress})
                .then(function(block) {
                    blockNum++;
                    // ndefData = Buffer.concat([ndefData, block]);
                    return writeBlock(blockNum);
                });
            }
        })(0);

        // return allDataPromise.then(() => ndefData.slice(0, ndefLength));
        return allPromises;
    }

    // WIP
    authenticateBlock(uid, options) {
        logger.info('Authenticating block...');

        var options = options || {};

        var blockAddress = options.blockAddress || 0x04;
        var authType = options.authType || c.MIFARE_COMMAND_AUTH_A
        var authKey = options.authKey || [0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
        var tagNumber = options.tagNumber || 0x01;
        var uidArray = uid.split(':').map(s => Number('0x' + s));

        var commandBuffer = [
            c.COMMAND_IN_DATA_EXCHANGE,
            tagNumber,
            authType,
            blockAddress
        ].concat(authKey).concat(uidArray);

        return this.sendCommand(commandBuffer)
        .then((frame) => {
            var body = frame.getDataBody();
            logger.info('Frame data from mifare classic authenticate', util.inspect(body));

            console.log('body', body);
            return body;
        });
    }


    inJumpForDep(){
        logger.info('inJumpForDep ...');

        var command = 0x56;
        var optFieldPresent = [].concat(0x00, 0xFF, 0xFF);
        var payloadFieldForPolling = [].concat(0x00, 0x00);

        var next = 0x06;
        var commandBuffer = [].concat(
            command,
            0x01,//mode
            0x02,//baudRate
            0x01,
           // next
            
            optFieldPresent,
            payloadFieldForPolling
            );

          return this.sendCommand(commandBuffer)
            .then((frame) => {
            var body = frame.getDataBody();
            logger.debug('body', util.inspect(body));
            
            var status = body[0];
            var targetNumber = body[1];
            var atr_res = [].concat(body[2], body[3], body[4], body[5], body[6],
                                    body[7], body[8], body[9], body[10], body[11],
                                    body[12], body[13], body[14], body[15], body[16], body[17]);
            //logger.info('response', response);
            logger.info('status', status);
            logger.info('targetNumber', targetNumber);
            logger.info('atr_res', atr_res);
            });
    }
   getGeneralStatus() {
        logger.info('Getting general status...');

        return this.sendCommand([c.COMMAND_GET_GENERAL_STATUS])
            .then((frame) => {
                var body = frame.getDataBody();
                return body;
            });
    }
        setParameters(){
                logger.info('setParameters ...');

        var command = 0x12;
        var flags = 0x04;
        var commandBuffer = [].concat(
            command,
            flags
            );

          return this.sendCommand(commandBuffer)
            .then((frame) => {
            var body = frame.getDataBody();
            logger.debug('body', util.inspect(body));
            });
    }

    emulateTag() {
        logger.info('Emulating tag...');
        var commAsTarget= 0x8C;
        var mode = 0x00; // PICC only, Passive Only
        var sens_res = [0x08, 0x00];
        var nfcId1t = [0x12, 0x34, 0x56];
        var sel_res = [0x40];
        var mifareParams = [].concat(sens_res, nfcId1t, sel_res);

        var felicaParams = [0x01,0xFE,0xA2,0xA3,0xA4,0xA5,0xA6,0xA7,
                           0xC0,0xC1,0xC2,0xC3,0xC4,0xC5,0xC6,0xC7,
                           0xFF,0xFF];

        var nfcId3t = [0xAA,0x99,0x88,0x77,0x66,0x55,0x44,0x33,0x22,0x11];
        var generalBytesLength = 0x00;
        var historicalBytesLength =  0x00;
        var commandBuffer = [].concat(
            commAsTarget,
            mode,
            mifareParams,
            felicaParams,
            nfcId3t,
            generalBytesLength,
            historicalBytesLength
        );
        console.log('commandBuffer : '+ commandBuffer);
        return this.sendCommand(commandBuffer)
        .then((frame) => {
            var body = frame.getDataBody();
            logger.debug('body', util.inspect(body));
            var mode = body[0];
            var command = [].concat(body[1], body[2], body[3], body[4], body[5], body[6],
                                    body[7], body[8]);

            logger.debug('mode', mode);
            logger.debug('initiatorCommand', command);
       
            return command; 
        });
    }
    tgSetGeneralBytes(command) {
        logger.info('Setting general bytes...');
        var TgSetGeneralBytes = 0x92;

        var commandBuffer = [].concat(
            TgSetGeneralBytes,
            command);

        return this.sendCommand(commandBuffer)
        .then((frame)=>{
            var body = frame.getDataBody();
            logger.debug('body', util.inspect(body));
            var cmdReturn = body[0];
            var status = body[1];

            logger.debug('cmdReturn', cmdReturn);
            logger.debug('status', status);
        });
    }

    tgGetTargetStatus(){
           logger.info('Getting Target Status ================...');
        var tgGetTargetStatus = 0x8A;
        var commandBuffer=[].concat(tgGetTargetStatus);

        return this.sendCommand(commandBuffer)
        .then((frame)=>{
            var body = frame.getDataBody();
            logger.debug('body', util.inspect(body));
            var State = body[0];
            var BRit = body[1];

            logger.debug('State', State);
            logger.debug('BRit', BRit);
        });
    }
    
    emulateGetData() {
        logger.info('Emulate get data...');
        var cmd = 0x86;
       var commandBuffer=[].concat(cmd);

           return this.sendCommand(commandBuffer)
        .then((frame) => {
            var body = frame.getDataBody();
            logger.debug('Frame data from emulate get data read:', util.inspect(body));
            var status = body[0];
            var dataIn= body.slice(1);
            logger.debug('status', status);
            logger.debug('dataIn', dataIn);
            return dataIn;
        });
        
    }
    emulateSetData(dataIn) {
        logger.info('Emulate set data...');

        var cmd= 0x8E;
        var data = [].concat(dataIn) ;
        var commandBuffer=[].concat(cmd, data);

            console.log('============================================================== mon buffer');

console.log(commandBuffer);
        return this.sendCommand(commandBuffer)
        .then((frame) => {
            var body = frame.getDataBody();
            logger.debug('Frame data from emulate get data read:', util.inspect(body));
            var status = body[0];
            logger.debug('status', status);
            return status;

        });
    }

    powerDown() {
        logger.info('Powering down rfid...');

        var cmd= 0x16;
        var wakeUpEnable = 0x10;
        var commandBuffer=[].concat(cmd, wakeUpEnable);

        return this.sendCommand(commandBuffer)
        .then((frame) => {
            var body = frame.getDataBody();
            logger.debug('Frame data from emulate get data read:', util.inspect(body));
            var status = body[0];
            logger.debug('status', status);
            return status;

        });
    }
    inDeselect(){
        logger.info('inDeselect ...');

        var command = 0x44;
        var commandBuffer = [].concat(
            command,
            0x01//target nb
            );

          return this.sendCommand(commandBuffer)
            .then((frame) => {
            var body = frame.getDataBody();
            logger.debug('body', util.inspect(body));
            
            var status = body[0];
            var targetNumber = body[1];
          
            logger.info('status', status);
           
            });
}
inRelease(){
        logger.info('inRelease ...');

        var command = 0x52;
        var commandBuffer = [].concat(
            command,
            0x01//target nb
            );

          return this.sendCommand(commandBuffer)
            .then((frame) => {
            var body = frame.getDataBody();
            logger.debug('body', util.inspect(body));
            
            var status = body[0];
            var targetNumber = body[1];
          
            logger.info('status', status);
           
            });
}
  inJumpForPsl(){
        logger.info('inJumpForPsl ...');


        var command = 0x46;
        var ActPass = 0x00;
        var BR = 0x02;
        var next = 0x02;
        var nfcId3t = [0xAA,0x99,0x88,0x77,0x66,0x55,0x44,0x33,0x22,0x11];


        var commandBuffer = [].concat(
            command,
            ActPass,
            BR,
            next,
            nfcId3t);

            return this.sendCommand(commandBuffer)
             .then((frame) => {
            var body = frame.getDataBody();
            logger.debug('body', util.inspect(body));
         
            var status = body[0];
            var targetNumber = body[1];
           
            logger.info('status', status);
            logger.info('targetNumber', targetNumber);
            console.log('atr_res', atr_res);
            logger.info('atr_res', atr_res);
           
            }); 
    }

    InListPassivTargets(){
        logger.info('InListPassivTargets ...');


        var command = 0x4A;
        var maxTarget = 0x01;
        var BR = 0x01;
        var next = 0x02;
        var nfcId3t = [0xAA,0x99,0x88,0x77,0x66,0x55,0x44,0x33,0x22,0x11];


    }



    inDataExchange(dataToSend){
        logger.info('inDataExchange ...');
        var command = 0x40;
        var target = 0x01;
        logger.info('datatosend : ',dataToSend);


var commandBuffer= [].concat(command, target, dataToSend);
 return this.sendCommand(commandBuffer)
            .then((frame) => {
             var body = frame.getDataBody();

             logger.debug('body', util.inspect(body));
            
            var status = body[0];
            var dataIn= body.slice(1);
            logger.info('status', status);
            logger.info('data', dataIn);
return dataIn;
            });
    }
}

exports.PN532 = PN532;
exports.I2C_ADDRESS = c.I2C_ADDRESS;
