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
* reports success back to HomeKit as soon as Hyundai accepts the command, then keeps confirming in the background - HomeKit only waits about ten seconds before showing "No Response", while the vehicle routinely takes longer than that to act, so waiting for confirmation before answering guaranteed a "No Response" no matter what the car did
* gives up confirming after 10 poll attempts or 30 seconds, whichever comes first, and simply lets the next status refresh report the vehicle's real state rather than erroring

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

### Pending Requests Block Each Other

Hyundai's backend only tracks one outstanding remote request per vehicle. While one is queued, further commands are refused - the official Bluelink app reports `Unable to send your request because a previous request is pending. [HT_533]`. A queued command can take a minute or more to clear, especially if the vehicle is asleep.

This matters because forcing a status refresh is itself a remote request, not just a read. Rapidly polling for confirmation with `REFRESH: true` can therefore queue up behind - and block - the very command it is trying to confirm. This plugin forces at most one refresh per command and reads Hyundai's cached status for the rest.

Hyundai also applies daily rate limits to remote requests (see [bluelinky#80](https://github.com/Hacksore/bluelinky/issues/80) and their [API Rate Limits](https://github.com/Hacksore/bluelinky/wiki/API-Rate-Limits) notes), so it is worth avoiding unnecessary requests regardless.

### Vehicle Auto-Relock

If a remote unlock is followed by the doors relocking a short time later without anything being sent, that is normally the vehicle's own security behavior - many Hyundais automatically relock if no door is opened within about 30 seconds of a remote unlock. Every command this plugin sends is logged before it goes out (`Locking Vehicle`, `Unlocking Vehicle`, and so on), so the log will show whether a relock actually came from Homebridge.
