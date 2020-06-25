const python = require("node-calls-python").interpreter;
const process = require("child_process");
var Accessory, Service, Characteristic, UUIDGen;

module.exports = function(homebridge) {
    Accessory = homebridge.platformAccessory;
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    UUIDGen = homebridge.hap.uuid;

    homebridge.registerPlatform('homebridge-philips-air', 'philipsAir', philipsAir, true);
}

function philipsAir(log, config, api) {
    this.log = log;
    this.config = config;

    if (this.config.timeout_seconds) {
        this.timeout = this.config.timeout_seconds * 1000;
    } else {
        this.timeout = 5000;
    }

    this.accessories = [];
    this.timeouts = {};

    this.libpython = config.libpython;

    if (this.libpython == null) {
        var pyconfig = process.execSync('python3-config --libs').toString();
        var index = pyconfig.indexOf('-lpython');
        pyconfig = pyconfig.substr(index + 2);
        index = pyconfig.indexOf(' ');
        this.libpython = pyconfig.substr(0, index);
    }

    python.fixlink('lib' + this.libpython + '.so');

    this.httpClient = python.importSync('pyairctrl.http_client');
    this.plainCoapClient = python.importSync('pyairctrl.plain_coap_client');
    this.coapClient = python.importSync('pyairctrl.coap_client');

    if (this.httpClient == undefined) {
        throw new Error("py-air-control not found. Make sure to follow all steps at https://github.com/Sunoo/homebridge-philips-air#installation");
    }

    if (api) {
        this.api = api;
        this.api.on('didFinishLaunching', this.didFinishLaunching.bind(this));
    }
}

philipsAir.prototype.configureAccessory = function(accessory) {
    this.setService(accessory);
    this.accessories.push(accessory);
}

philipsAir.prototype.didFinishLaunching = function() {
    var ips = [];
    this.config.devices.forEach(device => {
        this.addAccessory.bind(this, device)();
        ips.push(device.ip);
    });

    var badAccessories = [];
    this.accessories.forEach(cachedAccessory => {
        if (!ips.includes(cachedAccessory.context.ip)) {
            badAccessories.push(cachedAccessory);
        }
    });
    this.removeAccessories(badAccessories);

    this.accessories.forEach(accessory => {
        this.updateFirmware(accessory);
        this.updateStatus(accessory);
        this.updateFilters(accessory);
    });
}

philipsAir.prototype.getClient = function(accessory, forceNew = false) {

    if (!accessory.context.lastclient || Date.now() - accessory.context.lastclient > 60 * 1000) {
        accessory.context.lastclient = Date.now();
        accessory.context.clientget = false;
        switch (accessory.context.protocol) {
            case "coap":
                accessory.context.client = python.createSync(this.coapClient, 'CoAPAirClient', accessory.context.ip);
                break;
            case "plain_coap":
                accessory.context.client = python.createSync(this.plainCoapClient, 'PlainCoAPAirClient', accessory.context.ip);
                break;
            case "http":
            default:
                accessory.context.client = python.createSync(this.httpClient, 'HTTPAirClient', accessory.context.ip);
        }
        if (accessory.context.client == null) {
            throw new Error("Error getting client.");
        }
    }

    return accessory.context.client;
}

philipsAir.prototype.setData = function(accessory, values) {
    try {
        var client = this.getClient(accessory);
        if (!accessory.context.clientget) {
            accessory.context.laststatus = null;
            this.updateStatus(accessory);
        }
        python.callSync(client, 'set_values', values);
    } catch (err) {
        this.log(err);
    }
}

philipsAir.prototype.fetchFirmware = function(accessory) {
    if (!accessory.context.lastfirmware || Date.now() - accessory.context.lastfirmware > 1000) {
        accessory.context.lastfirmware = Date.now();
        accessory.context.firmware = python.callSync(this.getClient(accessory), 'get_firmware');
        accessory.context.clientget = true;

        accessory.context.firmware.name = accessory.context.firmware.name.replace('_', '/');
    }

    return accessory.context.firmware;
}

philipsAir.prototype.updateFirmware = function(accessory) {
    var accInfo = accessory.getService(Service.AccessoryInformation)
        .updateCharacteristic(Characteristic.Manufacturer, 'Philips')
        .updateCharacteristic(Characteristic.SerialNumber, accessory.context.ip);

    try {
        var firmware = this.fetchFirmware(accessory);
        accInfo.updateCharacteristic(Characteristic.Model, firmware.name)
            .updateCharacteristic(Characteristic.FirmwareRevision, firmware.version);
    } catch (err) {
        this.log("Unable to load firmware info: " + err);
    }
}

philipsAir.prototype.fetchFilters = function(accessory) {
    if (!accessory.context.lastfilters || Date.now() - accessory.context.lastfilters > 1000) {
        accessory.context.lastfilters = Date.now();
        accessory.context.filters = python.callSync(this.getClient(accessory), 'get_filters');
        accessory.context.clientget = true;

        accessory.context.filters.fltsts0change = accessory.context.filters.fltsts0 == 0;
        accessory.context.filters.fltsts0life = accessory.context.filters.fltsts0 / 360 * 100;
        accessory.context.filters.fltsts2change = accessory.context.filters.fltsts2 == 0;
        accessory.context.filters.fltsts2life = accessory.context.filters.fltsts2 / 2400 * 100;
        accessory.context.filters.fltsts1change = accessory.context.filters.fltsts1 == 0;
        accessory.context.filters.fltsts1life = accessory.context.filters.fltsts1 / 4800 * 100;
    }

    return accessory.context.filters;
}

philipsAir.prototype.updateFilters = function(accessory) {
    try {
        var filters = this.fetchFilters(accessory);
        accessory.getService('Pre-filter')
            .updateCharacteristic(Characteristic.FilterChangeIndication, filters.fltsts0change)
            .updateCharacteristic(Characteristic.FilterLifeLevel, filters.fltsts0life);
        accessory.getService('Active carbon filter')
            .updateCharacteristic(Characteristic.FilterChangeIndication, filters.fltsts2change)
            .updateCharacteristic(Characteristic.FilterLifeLevel, filters.fltsts2life);
        accessory.getService('HEPA filter')
            .updateCharacteristic(Characteristic.FilterChangeIndication, filters.fltsts1change)
            .updateCharacteristic(Characteristic.FilterLifeLevel, filters.fltsts1life);
    } catch (err) {
        this.log("Unable to load filter info: " + err);
    }
}

philipsAir.prototype.fetchStatus = function(accessory) {
    if (!accessory.context.laststatus || Date.now() - accessory.context.laststatus > 1000) {
        accessory.context.laststatus = Date.now();
        accessory.context.status = python.callSync(this.getClient(accessory), 'get_status');
        accessory.context.clientget = true;

        accessory.context.status.mode = !(accessory.context.status.mode == 'M');
        accessory.context.status.iaql = Math.ceil(accessory.context.status.iaql / 3);
        accessory.context.status.status = accessory.context.status.pwr * 2;

        if (accessory.context.status.pwr == '1') {
            if (!accessory.context.status.mode) {
                if (accessory.context.status.om == 't') {
                    accessory.context.status.om = 100;
                } else if (accessory.context.status.om == 's') {
                    accessory.context.status.om = 20;
                } else {
                    var divisor = 25;
                    var offset = 0;
                    if (accessory.context.sleep_speed) {
                        divisor = 20;
                        offset = 1;
                    }
                    accessory.context.status.om = (accessory.context.status.om + offset) * divisor;
                }
            } else {
                accessory.context.status.om = 0;
            }
        }
    }

    return accessory.context.status;
}

philipsAir.prototype.updateStatus = function(accessory) {
    try {
        var status = this.fetchStatus(accessory);

        accessory.getService(Service.AirPurifier)
            .updateCharacteristic(Characteristic.Active, status.pwr)
            .updateCharacteristic(Characteristic.TargetAirPurifierState, status.mode)
            .updateCharacteristic(Characteristic.CurrentAirPurifierState, status.status)
            .updateCharacteristic(Characteristic.LockPhysicalControls, status.cl)
            .updateCharacteristic(Characteristic.RotationSpeed, status.om);

        accessory.getService(Service.AirQualitySensor)
            .updateCharacteristic(Characteristic.AirQuality, status.iaql)
            .updateCharacteristic(Characteristic.PM2_5Density, status.pm25);

        if (accessory.context.light_control) {
            accessory.getService(Service.Lightbulb)
                .updateCharacteristic(Characteristic.On, status.uil)
                .updateCharacteristic(Characteristic.Brightness, status.aqil);
        }
    } catch (err) {
        this.log("Unable to load status info: " + err);
        accessory.context.startup = false;
    }
}

philipsAir.prototype.setPower = function(accessory, state, callback) {
    try {
        var values = {}
        values.pwr = state.toString();

        this.setData(accessory, values);

        accessory.getService(Service.AirPurifier)
            .updateCharacteristic(Characteristic.CurrentAirPurifierState, state * 2);

        if (accessory.context.light_control) {
            if (state) {
                var lights = accessory.getService(accessory.context.name + " Lights");
                lights.updateCharacteristic(Characteristic.On, accessory.context.status.aqil > 0);
                lights.updateCharacteristic(Characteristic.Brightness, accessory.context.status.iaql);
                accessory.getService(accessory.context.name + " Buttons")
                    .updateCharacteristic(Characteristic.On, accessory.context.status.uil);
            } else {
                accessory.getService(accessory.context.name + " Lights")
                    .updateCharacteristic(Characteristic.On, false);
                accessory.getService(accessory.context.name + " Buttons")
                    .updateCharacteristic(Characteristic.On, false);
            }
        }

        callback();
    } catch (err) {
        callback(err);
    }
}

philipsAir.prototype.setLights = function(accessory, state, callback) {
    try {
        var values = {}
        values.aqil = state ? accessory.context.status.aqil : 0;

        this.setData(accessory, values);

        callback();
    } catch (err) {
        callback(err);
    }
}

philipsAir.prototype.setBrightness = function(accessory, state, callback) {
    try {
        var values = {}
        values.aqil = state;

        this.setData(accessory, values);

        callback();
    } catch (err) {
        callback(err);
    }
}

philipsAir.prototype.setButtons = function(accessory, state, callback) {
    try {
        var values = {}
        values.uil = state ? '1' : '0';

        this.setData(accessory, values);

        callback();
    } catch (err) {
        callback(err);
    }
}

philipsAir.prototype.setMode = function(accessory, state, callback) {
    try {
        var values = {}
        values.mode = state ? 'P' : 'M';

        if (state != 0) {
            accessory.getService(Service.AirPurifier)
                .updateCharacteristic(Characteristic.RotationSpeed, 0);
        }

        this.setData(accessory, values);

        callback();
    } catch (err) {
        callback(err);
    }
}

philipsAir.prototype.setLock = function(accessory, state, callback) {
    try {
        var values = {}
        values.cl = (state == 1);

        this.setData(accessory, values);

        callback();
    } catch (err) {
        callback(err);
    }
}

philipsAir.prototype.setFan = function(accessory, state, callback) {
    try {
        var divisor = 25;
        var offset = 0;
        if (accessory.context.sleep_speed) {
            divisor = 20;
            offset = 1;
        }
        var speed = Math.ceil(state / divisor);
        if (speed > 0) {

            var values = {}
            values.mode = 'M';
            if (offset == 1 && speed == 1) {
                values.om = 's';
            } else if (speed < 4 + offset) {
                values.om = (speed - offset).toString();
            } else {
                values.om = 't';
            }
            this.setData(accessory, values);

            var service = accessory.getService(Service.AirPurifier)
                .updateCharacteristic(Characteristic.TargetAirPurifierState, 0);

            if (this.timeouts[accessory.context.ip]) {
                clearTimeout(this.timeouts[accessory.context.ip]);
                this.timeouts[accessory.context.ip] = null;
            }
            this.timeouts[accessory.context.ip] = setTimeout(() => {
                service.updateCharacteristic(Characteristic.RotationSpeed, speed * divisor);
                this.timeouts[accessory.context.ip] = null;
            }, 1000);
        }
        callback();
    } catch (err) {
        callback(err);
    }
}

philipsAir.prototype.addAccessory = function(data) {
    this.log('Initializing platform accessory ' + data.name + '...');

    var accessory;
    this.accessories.forEach(cachedAccessory => {
        if (cachedAccessory.context.ip == data.ip) {
            accessory = cachedAccessory;
        }
    });

    if (!accessory) {
        var uuid = UUIDGen.generate(data.ip);
        accessory = new Accessory(data.name, uuid);

        accessory.context.name = data.name;
        accessory.context.ip = data.ip;
        accessory.context.protocol = data.protocol;
        accessory.context.sleep_speed = data.sleep_speed;
        accessory.context.light_control = data.light_control;

        accessory.addService(Service.AirPurifier, data.name);
        accessory.addService(Service.AirQualitySensor, data.name);

        if (accessory.context.light_control) {
            accessory.addService(Service.Lightbulb, data.name + " Lights")
                .addCharacteristic(Characteristic.Brightness);
            accessory.addService(Service.Lightbulb, data.name + " Buttons", data.name + " Buttons");
        }

        accessory.addService(Service.FilterMaintenance, 'Pre-filter', 'Pre-filter');
        accessory.addService(Service.FilterMaintenance, 'Active carbon filter', 'Active carbon filter');
        accessory.addService(Service.FilterMaintenance, 'HEPA filter', 'HEPA filter');

        this.setService(accessory);

        this.api.registerPlatformAccessories('homebridge-philips-air', 'philipsAir', [accessory]);

        this.accessories.push(accessory);
    } else {
        accessory.context.protocol = data.protocol;
        accessory.context.sleep_speed = data.sleep_speed;
        accessory.context.light_control = data.light_control;

        var lights = accessory.getService(data.name + " Lights");
        var buttons = accessory.getService(data.name + " Buttons");

        if (accessory.context.light_control) {
            if (lights == undefined) {
                lights = accessory.addService(Service.Lightbulb, data.name + " Lights", data.name + " Lights");
                lights.addCharacteristic(Characteristic.Brightness);
            }
            if (buttons == undefined) {
                buttons = accessory.addService(Service.Lightbulb, data.name + " Buttons", data.name + " Buttons");
            }
        } else {
            if (lights != undefined) {
                accessory.removeService(lights);
            }
            if (buttons != undefined) {
                accessory.removeService(buttons);
            }
        }
    }

    accessory.context.lastclient = null;
    this.getClient(accessory);
}

philipsAir.prototype.removeAccessories = function(accessories) {
    accessories.forEach(accessory => {
        this.log(accessory.context.name + ' is removed from HomeBridge.');
        this.api.unregisterPlatformAccessories('homebridge-philips-air', 'philipsAir', [accessory]);
        this.accessories.splice(this.accessories.indexOf(accessory), 1);
    });
}

philipsAir.prototype.setService = function(accessory) {
    accessory.on('identify', (paired, callback) => {
        this.log(accessory.context.name + ' identify requested!');
        callback();
    });

    accessory.getService(Service.AirPurifier)
        .getCharacteristic(Characteristic.Active)
        .on('set', this.setPower.bind(this, accessory))
        .on('get', callback => {
            try {
                var status = this.fetchStatus(accessory);
                callback(null, status.pwr);
            } catch (err) {
                callback(err);
            }
        });

    accessory.getService(Service.AirPurifier)
        .getCharacteristic(Characteristic.TargetAirPurifierState)
        .on('set', this.setMode.bind(this, accessory))
        .on('get', callback => {
            try {
                var status = this.fetchStatus(accessory);
                callback(null, status.mode);
            } catch (err) {
                callback(err);
            }
        });

    accessory.getService(Service.AirPurifier)
        .getCharacteristic(Characteristic.CurrentAirPurifierState)
        .on('get', callback => {
            try {
                var status = this.fetchStatus(accessory);
                callback(null, status.status);
            } catch (err) {
                callback(err);
            }
        });

    accessory.getService(Service.AirPurifier)
        .getCharacteristic(Characteristic.LockPhysicalControls)
        .on('set', this.setLock.bind(this, accessory))
        .on('get', callback => {
            try {
                var status = this.fetchStatus(accessory);
                callback(null, status.cl);
            } catch (err) {
                callback(err);
            }
        });

    accessory.getService(Service.AirPurifier)
        .getCharacteristic(Characteristic.RotationSpeed)
        .on('set', this.setFan.bind(this, accessory))
        .on('get', callback => {
            try {
                var status = this.fetchStatus(accessory);
                callback(null, status.om);
            } catch (err) {
                callback(err);
            }
        });

    accessory.getService(Service.AirQualitySensor)
        .getCharacteristic(Characteristic.AirQuality)
        .on('get', callback => {
            try {
                var status = this.fetchStatus(accessory);
                callback(null, status.iaql);
            } catch (err) {
                callback(err);
            }
        });

    accessory.getService(Service.AirQualitySensor)
        .getCharacteristic(Characteristic.PM2_5Density)
        .on('get', callback => {
            try {
                var status = this.fetchStatus(accessory);
                callback(null, status.pm25);
            } catch (err) {
                callback(err);
            }
        });

    if (accessory.context.light_control) {
        accessory.getService(accessory.context.name + " Lights")
            .getCharacteristic(Characteristic.On)
            .on('set', this.setLights.bind(this, accessory))
            .on('get', callback => {
                try {
                    var status = this.fetchStatus(accessory);
                    callback(null, (status.aqil > 0));
                } catch (err) {
                    callback(err);
                }
            });

        accessory.getService(accessory.context.name + " Lights")
            .getCharacteristic(Characteristic.Brightness)
            .on('set', this.setBrightness.bind(this, accessory))
            .on('get', callback => {
                try {
                    var status = this.fetchStatus(accessory);
                    callback(null, status.aqil);
                } catch (err) {
                    callback(err);
                }
            });

        accessory.getService(accessory.context.name + " Buttons")
            .getCharacteristic(Characteristic.On)
            .on('set', this.setButtons.bind(this, accessory))
            .on('get', callback => {
                try {
                    var status = this.fetchStatus(accessory);
                    callback(null, status.uil);
                } catch (err) {
                    callback(err);
                }
            });
    }

    accessory.getService('Pre-filter')
        .getCharacteristic(Characteristic.FilterChangeIndication)
        .on('get', callback => {
            try {
                var filters = this.fetchFilters(accessory);
                callback(null, filters.fltsts0change);
            } catch (err) {
                callback(err);
            }
        });

    accessory.getService('Pre-filter')
        .getCharacteristic(Characteristic.FilterLifeLevel)
        .on('get', callback => {
            try {
                var filters = this.fetchFilters(accessory);
                callback(null, filters.fltsts0life);
            } catch (err) {
                callback(err);
            }
        });

    accessory.getService('Active carbon filter')
        .getCharacteristic(Characteristic.FilterChangeIndication)
        .on('get', callback => {
            try {
                var filters = this.fetchFilters(accessory);
                callback(null, filters.fltsts2change);
            } catch (err) {
                callback(err);
            }
        });

    accessory.getService('Active carbon filter')
        .getCharacteristic(Characteristic.FilterLifeLevel)
        .on('get', callback => {
            try {
                var filters = this.fetchFilters(accessory);
                callback(null, filters.fltsts2life);
            } catch (err) {
                callback(err);
            }
        });

    accessory.getService('HEPA filter')
        .getCharacteristic(Characteristic.FilterChangeIndication)
        .on('get', callback => {
            try {
                var filters = this.fetchFilters(accessory);
                callback(null, filters.fltsts1change);
            } catch (err) {
                callback(err);
            }
        });

    accessory.getService('HEPA filter')
        .getCharacteristic(Characteristic.FilterLifeLevel)
        .on('get', callback => {
            try {
                var filters = this.fetchFilters(accessory);
                callback(null, filters.fltsts1life);
            } catch (err) {
                callback(err);
            }
        });
}