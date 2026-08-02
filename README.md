# Homebridge Hyundai Bluelink

[![npm version](https://badge.fury.io/js/homebridge-bluelink-3-0.svg)](https://badge.fury.io/js/homebridge-bluelink-3-0)
![Build Status)](https://img.shields.io/github/workflow/status/cnpittman/homebridge-bluelink-3.0/build/main)

This is a [Homebridge](https://homebridge.io) platform plugin that uses [bluelinky](https://github.com/Hacksore/bluelinky) to connect your Hyundai or Kia vehicle to HomeKit, letting you control your vehicle using Siri, shortcuts, or the Home app.

This is a maintained fork of [athal7/homebridge-hyundai-bluelink](https://github.com/athal7/homebridge-hyundai-bluelink), published as `homebridge-bluelink-3-0`. It adds a more reliable lock/unlock/start/stop path for US-region vehicles - see [US Region Command Reliability](#us-region-command-reliability) below.

## Installation

This plugin can be installed from the Homebridge web console:
1. Log in to the console and go to the `Plugins` tab
2. Search for `homebridge-bluelink-3-0` and install it
3. Edit the settings in the UI, or directly in the `config.json` file following the schema below

## Configuration

### Sample

```json
"platforms": [
    {
        "credentials": {
            "username": "your username / email",
            "password": "your password",
            "region": "US / CA / EU",
            "brand": "Hyundai / Kia",
            "pin": "your pin"
        },
        "vehicles": [
            {
                "vin": "your VIN",
                "maxRange": 500
            }
        ],
        "remoteStart": {
            "airCtrl": false,
            "heating1": false,
            "defrost": false,
            "airTempvalue": 72,
            "igniOnDuration": 10
        },
        "platform": "Hyundai"
    }
],
```

### Notes
* `vehicles.maxRange` is optional
* `remoteStart.airCtrl` controls whether the HVAC is turned on
* `remoteStart.airTempvalue` is the temperature in Fahrenheit
* `remoteStart.igniOnDuration` must be between 1 and 10, otherwise remote start will fail

## US Region Command Reliability

For `region: "US"`, bluelinky's lock/unlock/start/stop calls only confirm that Hyundai's backend accepted the request into its queue, not that the vehicle actually executed it. On newer vehicles this can leave a command stuck "pending" while HomeKit shows it as successful.

For US vehicles, this fork routes those four commands through its own client instead, which:
* sends the request in the exact form Hyundai's API expects (bluelinky's own lock/unlock calls use a form-encoded body, not JSON - sending JSON gets a `200` response but silently does nothing)
* polls the vehicle's real status afterward and waits for the door lock / ignition state to actually change before reporting success back to HomeKit
* gives up after 10 poll attempts or 30 seconds, whichever comes first, and simply reports the vehicle's current state rather than erroring - HomeKit's own request will typically have already timed out well before that point anyway

Other regions (CA/EU) are unaffected and continue to use bluelinky's built-in methods.

## Known Issues

### SSL Key too Small

Log:

```
[Hyundai] Client Error GotError [RequestError]: write EPROTO 1995553232:error:141A318A:SSL routines:tls_process_ske_dhe:dh key too small:../deps/openssl/openssl/ssl/statem/statem_clnt.c:2158:
```

This happens because the Bluelink API used has insecure SSL settings.

Workaround: Edit `/etc/ssl/openssl.cnf`, change the line `CipherString = DEFAULT@SECLEVEL=2` to `CipherString = DEFAULT@SECLEVEL=1` (change 2 to 1 at end of line)

Source: https://github.com/FreshRSS/FreshRSS/issues/3029

### Status Refresh Delay

Due to Hyundai's [API Rate Limits](https://github.com/Hacksore/bluelinky/wiki/API-Rate-Limits), the car status (locked, on/off, range) is only updated once per hour. Actions taken from homebridge get automatically refreshed, but actions taken elsewhere (e.g. bluelink app, key fab) may not display in homebridge for up to an hour.

### Daily Command Quota

Hyundai's US backend enforces a hard daily quota on remote commands (reportedly around 10 lock actions and 30 remote requests total per day - see [bluelinky#80](https://github.com/Hacksore/bluelinky/issues/80)). Once exhausted, commands keep returning a "success" response but stop actually reaching the vehicle, and this won't be limited to Homebridge - the official Bluelink app will show the same stuck behavior until the quota resets. If lock/unlock suddenly stops working after a lot of testing in a short window, this is the most likely cause; just wait for the quota to reset rather than retrying repeatedly.
