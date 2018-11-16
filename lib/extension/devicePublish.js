
const settings = require('../util/settings');
const zigbeeShepherdConverters = require('zigbee-shepherd-converters');
const Queue = require('queue');
const logger = require('../util/logger');
const topicRegex = new RegExp(`^${settings.get().mqtt.base_topic}/.+/(set|get)$`);
const postfixes = ['left', 'right', 'center', 'bottom_left', 'bottom_right', 'top_left', 'top_right'];

class DevicePublish {
    constructor(zigbee, mqtt, state, mqttPublishDeviceState) {
        this.zigbee = zigbee;
        this.mqtt = mqtt;
        this.state = state;

        // TODO -> remove this; move to publish device state method to mqtt.js
        this.mqttPublishDeviceState = mqttPublishDeviceState;

        /**
         * Setup command queue.
         * The command queue ensures that only 1 command is executed at a time.
         * When executing multiple commands at the same time, some commands may fail.
         */
        this.queue = new Queue();
        this.queue.concurrency = 1;
        this.queue.autostart = true;

        // Subscribe to topics.
        const maxDepth = 20;
        for (let step = 1; step < maxDepth; step++) {
            const topic = `${settings.get().mqtt.base_topic}/${'+/'.repeat(step)}`;
            this.mqtt.subscribe(`${topic}set`);
            this.mqtt.subscribe(`${topic}get`);
        }
    }

    stop() {
        this.queue.stop();
    }

    parseTopic(topic) {
        if (!topic.match(topicRegex)) {
            return null;
        }

        // Remove base from topic
        topic = topic.replace(`${settings.get().mqtt.base_topic}/`, '');

        // check for non json topic key-value style e.g <BASE>/<DEVICE>/setkv/key
        if (topic.lastIndexOf('/setkv/') > 0)
        {   const type = "setkv";
            const kv_k= topic.substr(topic.lastIndexOf('/') + 1, topic.length);  
            // schima todo set type and key
           
        }
        
        
        // Parse type from topic
        const type = topic.substr(topic.lastIndexOf('/') + 1, topic.length);

        // Remove type from topic
        topic = topic.replace(`/${type}`, '');

        // Check if we have to deal with a postfix.
        let postfix = null;
        if (postfixes.find((p) => topic.endsWith(p))) {
            postfix = topic.substr(topic.lastIndexOf('/') + 1, topic.length);

            // Remove postfix from topic
            topic = topic.replace(`/${postfix}`, '');
        }

        const deviceID = topic;

        return {type: type, deviceID: deviceID, postfix: postfix};
    }

    handleMQTTMessage(topic, message) {
        topic = this.parseTopic(topic);

        if (!topic) {
            return false;
        }

        // Map friendlyName to ieeeAddr if possible.
        const ieeeAddr = settings.getIeeAddrByFriendlyName(topic.deviceID) || topic.deviceID;

        // Get device
        const device = this.zigbee.getDevice(ieeeAddr);
        if (!device) {
            logger.error(`Failed to find device with ieeAddr: '${ieeeAddr}'`);
            return;
        }

        // Map device to a model
        const model = zigbeeShepherdConverters.findByZigbeeModel(device.modelId);
        if (!model) {
            logger.warn(`Device with modelID '${device.modelId}' is not supported.`);
            logger.warn(`Please see: https://github.com/Koenkk/zigbee2mqtt/wiki/How-to-support-new-devices`);
            return;
        }

        // Convert the MQTT message to a Zigbee message.
        let json = null;
        try {
            json = JSON.parse(message);
        } catch (e) {
            // Cannot be parsed to JSON, assume state message.
            json = {state: message.toString()};
        }

        // Determine endpoint to publish to.
        const endpoint = model.hasOwnProperty('ep') && model.ep.hasOwnProperty(topic.postfix) ?
            model.ep[topic.postfix] : null;

        // For each key in the JSON message find the matching converter.
        Object.keys(json).forEach((key) => {
            const converter = model.toZigbee.find((c) => c.key === key);
            if (!converter) {
                logger.error(`No converter available for '${key}' (${json[key]})`);
                return;
            }

            // Converter didn't return a result, skip
            const converted = converter.convert(json[key], json, topic.type);
            if (!converted) {
                return;
            }

            // Add job to queue
            this.queue.push((queueCallback) => {
                this.zigbee.publish(
                    ieeeAddr,
                    converted.cid,
                    converted.cmd,
                    converted.cmdType,
                    converted.zclData,
                    converted.cfg,
                    endpoint,
                    (error, rsp) => {
                        // Devices do not report when they go off, this ensures state (on/off) is always in sync.
                        if (topic.type === 'set' && !error && (key.startsWith('state') || key === 'brightness')) {
                            const msg = {};
                            const _key = topic.postfix ? `state_${topic.postfix}` : 'state';
                            msg[_key] = key === 'brightness' ? 'ON' : json['state'];
                            this.mqttPublishDeviceState(device, msg, true);
                        }

                        queueCallback();
                    }
                );
            });
        });

        return true;
    }
}

module.exports = DevicePublish;
