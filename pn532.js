'use strict';
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

            // var status = body[0];
            // var tagData = body.slice(1, body.length);

            // return {
            //     status: status.toString(16),
            //     tagData: tagData
            // };
        });
    }

     emulateTag() {
        logger.info('Emulating tag...');
        var commAsTarget= 0x8C;
        var mode = 0x05; // PICC only, Passive Only
        var sens_res = [0x04, 0x00];
        var nfcId1t = [0x00, 0x00, 0x00];
        var sel_res = [0x20];
        var mifareParams = [].concat(sens_res, nfcId1t, sel_res);

        var felicaParams = [0x01,0xFE,0xA2,0xA3,0xA4,0xA5,0xA6,0xA7,
                           0xC0,0xC1,0xC2,0xC3,0xC4,0xC5,0xC6,0xC7,
                           0xFF,0xFF];

        var nfcId3t = [0xAA,0x99,0x88,0x77,0x66,0x55,0x44,0x33,0x22,0x11];
        var generalBytesLength = 0;
        var historicalBytesLength =  0;
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
            console.log('mode', mode);
            logger.debug('mode', mode);
             var initiatorCommand = 0x88;
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
    
    emulateGetData() {
        logger.info('Emulate get data...');

        return this.sendCommand([c.TG_GET_DATA])//0x86
        .then((frame) => {
            var body = frame.getDataBody();
            logger.debug('Frame data from emulate get data read:', util.inspect(body));
            var status = body[0];
            if (status === 0x13) {
                logger.warn('The data format does not match to the specification.');
            }
            // var dataIn = body.slice(1, body.length - 1); // skip status byte and last byte (not part of memory)
            // 00 00 a4 04 00 07 d2 76 00 00 85 01 01 00 26
            var cla = body[1]
            var instruction = body[2];
            var parameter1 = body[3];
            var parameter2 = body[4];
            var commandLength = body[5];
            var data = body.slice(6, commandLength);
            logger.debug('status', status);

            logger.debug('instruction', instruction);
            logger.debug('parameter1', parameter1);
            logger.debug('parameter2', parameter2);
            logger.debug('commandLength', commandLength);
            logger.debug('data', util.inspect(data));
            logger.debug('Final data read : '+data);


  switch(instruction) {
                case c.ISO7816_SELECT_FILE:
                    logger.info('Select file');
                    if (parameter1 === 0x00) {
                        logger.info('Select by Id');
                    }
                    if (parameter1 === 0x04) {
                        logger.info('Select by name');
                    }
                case c.C_APDU_P1_SELECT_BY_ID:
                        if(parameter2 != 0x0c){
                          //  DMSG("C_APDU_P2 != 0x0c\n");
                           // setResponse(COMMAND_COMPLETE, rwbuf, &sendlen);
                        } else if(lc == 2 && rwbuf[c.C_APDU_DATA] == 0xE1 && (rwbuf[c.C_APDU_DATA+1] == 0x03 || rwbuf[c.C_APDU_DATA+1] == 0x04)){
                         //   setResponse(COMMAND_COMPLETE, rwbuf, &sendlen);
                            if(rwbuf[C_APDU_DATA+1] == 0x03){
                                currentFile = CC;
                            } else if(rwbuf[C_APDU_DATA+1] == 0x04){
                                currentFile = NDEF;
                            }
                        } else {
                          //  setResponse(TAG_NOT_FOUND, rwbuf, &sendlen);
                        }
                        break;
                case c.C_APDU_P1_SELECT_BY_NAME:
                        logger.info('c la ==============================================');
                     //   const uint8_t ndef_tag_application_name_v2[] = {0, 0x7, 0xD2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01 };
                        //if(0 == memcmp(ndef_tag_application_name_v2, rwbuf + c.C_APDU_P2, sizeof(ndef_tag_application_name_v2))){
                        logger.info('ca passe');

                          //  setResponse(COMMAND_COMPLETE, rwbuf, &sendlen);
                        return  this.sendCommand([c.R_APDU_SW1_COMMAND_COMPLETE,c.R_APDU_SW2_COMMAND_COMPLETE]);
                       // } else{
                       //     DMSG("function not supported\n");
                           // setResponse(FUNCTION_NOT_SUPPORTED, rwbuf, &sendlen);
                       // }
                        break;
                    break;
                case c.ISO7816_READ_BINARY:
                    logger.info('Read binary');
                    break;
                case c.ISO7816_UPDATE_BINARY:
                    logger.info('Update binary');
                    break;
                default:
                    logger.warn('Command not supported');
            }



            return data;
        });
    }


///////////////////////////////////////////////////////////
/*
emulate(tgInitAsTargetTimeout){

  // http://www.nxp.com/documents/application_note/AN133910.pdf
  var command = [{
      c.PN532_COMMAND_TGINITASTARGET,
      0x00,                  // MODE: PICC only, Passive only

      0x00, 0x00,         // SENS_RES
      0x00, 0x00, 0x00,   // NFCID1
      0x40,               // SEL_RES

      0x01, 0xFE,         // Parameters to build POL_RES
      0x0F, 0xBB, 0xBA,
      0xA6, 0xC9, 0x89,
      0x00, 0x00, 0x00,
      0x00, 0x00, 0x00,
      0x00, 0x00, 0xFF,
      0xFF,
      0x01, 0xFE, 0x0F, //NFCID3t (10 bytes)
      0xBB, 0xBA, 0xA6, 0xC9,
      0x89, 0x00, 0x00,

      0x0a, 0x46, 0x66, 0x6D, 0x01, 0x01, 0x10, 0x02, 0x02, 0x00, 0x80, 0x00 

  }];

  if(uidPtr != 0){  // if uid is set copy 3 bytes to nfcid1
    memcpy(command + 4, uidPtr, 3);
  }

  if(1 != this.sendCommand([command)){
    DMSG("tgInitAsTarget failed or timed out!");
    return false;
  }

  uint8_t compatibility_container[] = {
    0, 0x0F,
    0x20,
    0, 0x54,
    0, 0xFF,
    0x04,       // T
    0x06,       // L
    0xE1, 0x04, // File identifier
    ((NDEF_MAX_LENGTH & 0xFF00) >> 8), (NDEF_MAX_LENGTH & 0xFF), // maximum NDEF file size
    0x00,       // read access 0x0 = granted
    0x00        // write access 0x0 = granted | 0xFF = deny
  };

  if(tagWriteable == false){
    compatibility_container[14] = 0xFF;
  }

  tagWrittenByInitiator = false;

  uint8_t rwbuf[128];
  uint8_t sendlen;
  int16_t status;
  tag_file currentFile = NONE;
  uint16_t cc_size = sizeof(compatibility_container);
  bool runLoop = true;

  while(runLoop){
    status = pn532.tgGetData(rwbuf, sizeof(rwbuf));
    if(status < 0){
      DMSG("tgGetData failed!\n");
      pn532.inRelease();
      return true;
    }

    uint8_t p1 = rwbuf[C_APDU_P1];
    uint8_t p2 = rwbuf[C_APDU_P2];
    uint8_t lc = rwbuf[C_APDU_LC];
    uint16_t p1p2_length = ((int16_t) p1 << 8) + p2;

    switch(rwbuf[C_APDU_INS]){
    case ISO7816_SELECT_FILE:
      switch(p1){
      case C_APDU_P1_SELECT_BY_ID:
	if(p2 != 0x0c){
	  DMSG("C_APDU_P2 != 0x0c\n");
	  setResponse(COMMAND_COMPLETE, rwbuf, &sendlen);
	} else if(lc == 2 && rwbuf[C_APDU_DATA] == 0xE1 && (rwbuf[C_APDU_DATA+1] == 0x03 || rwbuf[C_APDU_DATA+1] == 0x04)){
	  setResponse(COMMAND_COMPLETE, rwbuf, &sendlen);
	  if(rwbuf[C_APDU_DATA+1] == 0x03){
	    currentFile = CC;
	  } else if(rwbuf[C_APDU_DATA+1] == 0x04){
	    currentFile = NDEF;
	  }
	} else {
	  setResponse(TAG_NOT_FOUND, rwbuf, &sendlen);
	}
	break;
      case C_APDU_P1_SELECT_BY_NAME: 
        const uint8_t ndef_tag_application_name_v2[] = {0, 0x7, 0xD2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01 };
	if(0 == memcmp(ndef_tag_application_name_v2, rwbuf + C_APDU_P2, sizeof(ndef_tag_application_name_v2))){
	  setResponse(COMMAND_COMPLETE, rwbuf, &sendlen);
	} else{
	  DMSG("function not supported\n");
	  setResponse(FUNCTION_NOT_SUPPORTED, rwbuf, &sendlen);
	} 
	break;
      }
      break;
    case ISO7816_READ_BINARY:
      switch(currentFile){
      case NONE:
	setResponse(TAG_NOT_FOUND, rwbuf, &sendlen);
	break;
      case CC:
	if( p1p2_length > NDEF_MAX_LENGTH){
	  setResponse(END_OF_FILE_BEFORE_REACHED_LE_BYTES, rwbuf, &sendlen);
	}else {
	  memcpy(rwbuf,compatibility_container + p1p2_length, lc);
	  setResponse(COMMAND_COMPLETE, rwbuf + lc, &sendlen, lc);
	}
	break;
      case NDEF:
	if( p1p2_length > NDEF_MAX_LENGTH){
	  setResponse(END_OF_FILE_BEFORE_REACHED_LE_BYTES, rwbuf, &sendlen);
	}else {
	  memcpy(rwbuf, ndef_file + p1p2_length, lc);
	  setResponse(COMMAND_COMPLETE, rwbuf + lc, &sendlen, lc);
	}
	break;
      }
      break;    
    case ISO7816_UPDATE_BINARY:
      if(!tagWriteable){
	  setResponse(FUNCTION_NOT_SUPPORTED, rwbuf, &sendlen);
      } else{      
	if( p1p2_length > NDEF_MAX_LENGTH){
	  setResponse(MEMORY_FAILURE, rwbuf, &sendlen);
	}
	else{
	  memcpy(ndef_file + p1p2_length, rwbuf + C_APDU_DATA, lc);
	  setResponse(COMMAND_COMPLETE, rwbuf, &sendlen);
	  tagWrittenByInitiator = true;
      
      uint16_t ndef_length = (ndef_file[0] << 8) + ndef_file[1];
      if ((ndef_length > 0) && (updateNdefCallback != 0)) {
        updateNdefCallback(ndef_file + 2, ndef_length);
      }
	}
      }
      break;
    default:
      DMSG("Command not supported!");
      DMSG_HEX(rwbuf[C_APDU_INS]);
      DMSG("\n");
      setResponse(FUNCTION_NOT_SUPPORTED, rwbuf, &sendlen);
    }
    status = pn532.tgSetData(rwbuf, sendlen);
    if(status < 0){
      DMSG("tgSetData failed\n!");
      pn532.inRelease();
      return true;
    }
  }
  pn532.inRelease();
  return true;
}
*/

///////////////////////////////////////////////////////



    emulateSetData(data) {
        logger.info('Writing data... bon code');
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
        // }
    }
    
}

exports.PN532 = PN532;
exports.I2C_ADDRESS = c.I2C_ADDRESS;
