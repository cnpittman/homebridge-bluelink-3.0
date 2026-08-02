# Homebridge Hyundai Bluelink

[![npm version](https://badge.fury.io/js/homebridge-bluelink-3-0.svg)](https://badge.fury.io/js/homebridge-bluelink-3-0)
![Build Status)](https://img.shields.io/github/workflow/status/cnpittman/homebridge-bluelink-3.0/build/main)

This is a [Homebridge](https://homebridge.io) platform plugin that uses [bluelinky](https://github.com/Hacksore/bluelinky) to connect your Hyundai or Kia vehicle to HomeKit, letting you control your vehicle using Siri, shortcuts, or the Home app.

This is a maintained fork of [athal7/homebridge-hyundai-bluelink](https://github.com/athal7/homebridge-hyundai-bluelink), published as `homebridge-bluelink-3-0`.

This fork fixes remote commands on newer US vehicles, which do not work through bluelinky. See [US Region Command Reliability](#us-region-command-reliability).

Developed with the help of [Claude Code](https://claude.com/claude-code).

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

On newer US vehicles, lock/unlock/start/stop through bluelinky silently do nothing. Hyundai returns `200` and issues a transaction id, and the command then stays `PENDING` forever - never an error, and the vehicle never acts on it. Status reads work normally throughout, which makes the plugin look healthy while every control is dead.

**The cause is the `gen` header**, which tells Hyundai's backend which telematics generation to dispatch a command to. bluelinky's US controller does not read the real value; it derives one:

```js
generation: t.modelYear > 2016 ? '2' : '1'
```

That rule dates from when generation 2 was current, so every recent vehicle is announced as gen 2. A 2026 Sonata Hybrid is gen 3 (`ccNC Lite`). The backend accepts the command, queues it against generation 2, and the vehicle never answers on that path. Status reads do not depend on dispatch, which is why they are unaffected. bluelinky's *Canadian* controller reads the real value (`genType`); only the US path guesses.

Hyundai reports the true value as `vehicleGeneration` in the account's enrollment details. This fork reads it from there, caches it, and falls back to bluelinky's value only if it cannot be read. On the vehicle above this is the difference between a command that hangs indefinitely and one confirmed complete in about 20 seconds.

### Also fixed along the way

* **Confirmation.** bluelinky reports success when Hyundai *accepts* a request. This fork follows `rmt/getRunningStatus` until the vehicle reports `SUCCESS` or `ERROR`, so HomeKit reflects what the car did rather than what the queue accepted.
* **HomeKit timing.** HomeKit waits roughly ten seconds before showing "No Response", far less than a vehicle takes to act, so the command is acknowledged on acceptance and confirmed in the background.
* **Request shape.** Commands use the headers and JSON body Hyundai's own client sends (`accessToken`, `blueLinkServicePin`, `clientSecret`) rather than bluelinky's.
* **UTC offset.** bluelinky hardcodes `-5`; this computes it from the local clock.

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

This matters because forcing a status refresh is itself a remote request, not just a read. A refresh issued while a command is still queued is refused, and the cached, pre-command reading comes back instead - so a command cannot be confirmed by refreshing status, because the command being confirmed is what blocks the refresh. This plugin follows the command's transaction id via `rmt/getRunningStatus` instead, which queries the backend about the transaction rather than waking the vehicle and so is not blocked.

Hyundai also applies daily rate limits to remote requests (see [bluelinky#80](https://github.com/Hacksore/bluelinky/issues/80) and their [API Rate Limits](https://github.com/Hacksore/bluelinky/wiki/API-Rate-Limits) notes), so it is worth avoiding unnecessary requests regardless.

### Vehicle Auto-Relock

If a remote unlock is followed by the doors relocking a short time later without anything being sent, that is normally the vehicle's own security behavior - many Hyundais automatically relock if no door is opened within about 30 seconds of a remote unlock. Every command this plugin sends is logged before it goes out (`Locking Vehicle`, `Unlocking Vehicle`, and so on), so the log will show whether a relock actually came from Homebridge.
