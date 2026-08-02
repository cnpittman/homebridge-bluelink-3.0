# Homebridge Hyundai Bluelink

[![npm version](https://badge.fury.io/js/homebridge-bluelink-3-0.svg)](https://badge.fury.io/js/homebridge-bluelink-3-0)
![Build Status)](https://img.shields.io/github/workflow/status/cnpittman/homebridge-bluelink-3.0/build/main)

This is a [Homebridge](https://homebridge.io) platform plugin that uses [bluelinky](https://github.com/Hacksore/bluelinky) to connect your Hyundai or Kia vehicle to HomeKit, letting you control your vehicle using Siri, shortcuts, or the Home app.

This is a maintained fork of [athal7/homebridge-hyundai-bluelink](https://github.com/athal7/homebridge-hyundai-bluelink), published as `homebridge-bluelink-3-0`.

## ⚠️ Work In Progress

**US remote commands are under active repair and unverified.** Reading status (lock state, ignition, range, battery) has always worked reliably. Sending lock, unlock, start, or stop did not: Hyundai's API accepted the request and returned `200`, but the vehicle never carried it out - confirmed on a 2026 Sonata Hybrid, where the same commands worked normally from the official Bluelink app.

As of 2.1.0 the cause looks identified. bluelinky sends the access token and PIN as `access_token` and `bluelinkservicepin` and omits `clientSecret` entirely, while Hyundai's own client sends `accessToken`, `blueLinkServicePin` and `clientSecret`, with a JSON body rather than a form-encoded one. A PIN header the backend does not recognise matches the observed behaviour exactly: the request authenticates and queues, but the command is never authorised, so the vehicle ignores it. The command path now mirrors the actively maintained Python implementation ([HyundaiBlueLinkApiUSA.py](https://github.com/Hyundai-Kia-Connect/hyundai_kia_connect_api/blob/master/hyundai_kia_connect_api/HyundaiBlueLinkApiUSA.py)) instead of bluelinky.

This has not yet been confirmed working on a vehicle. See [US Region Command Reliability](#us-region-command-reliability) for what was ruled out along the way.

This fork is being developed with the help of [Claude Code](https://claude.com/claude-code).

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

### What has been ruled out

On a 2026 Sonata Hybrid, with the request confirmed byte-for-byte equivalent to what bluelinky sends, `POST /ac/v2/rcs/rdo/on` returns `200` and the vehicle does not unlock. The following were investigated and are **not** the cause:

* **Request encoding.** Both a form-encoded body (matching bluelinky) and a JSON one return `200` and change nothing on their own.
* **Rate limiting.** A quota would not let the official app keep working normally minutes later, which it does.
* **Confirmation timing.** The command is not merely slow - the vehicle never carries it out, confirmed against the official app's own status.
* **Plugin-side interference.** Aggressive status polling was making things worse and has been removed, but removing it did not make commands work.

What this left was the request's headers, and comparing against the maintained Python implementation showed bluelinky's differ substantially - most importantly `access_token` vs `accessToken`, `bluelinkservicepin` vs `blueLinkServicePin`, and a missing `clientSecret`. The endpoint itself (`/ac/v2/rcs/rdo/on`) is the same one that implementation uses successfully, so the endpoint was never the problem.

### What the plugin does

For US vehicles, this fork routes those four commands through its own client instead, which:
* sends the headers and JSON body Hyundai's own client uses (`accessToken`, `blueLinkServicePin`, `clientSecret`) rather than bluelinky's, which the backend appears not to accept as authorisation for a command
* polls the vehicle's real status afterward and waits for the door lock / ignition state to actually change before reporting success back to HomeKit
* reports success back to HomeKit as soon as Hyundai accepts the command - HomeKit only waits about ten seconds before showing "No Response", while the vehicle routinely takes longer than that to act, so waiting for confirmation before answering guaranteed a "No Response" no matter what the car did
* verifies the result once afterwards, after the command has had time to clear Hyundai's queue, and updates the state HomeKit shows from that reading

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

This matters because forcing a status refresh is itself a remote request, not just a read. A refresh issued while a command is still queued is refused, and the cached, pre-command reading comes back instead - so a command cannot be confirmed by polling for it, because the command being confirmed is what blocks the poll. This plugin therefore waits for the queue to clear before checking the result once, rather than polling.

Hyundai also applies daily rate limits to remote requests (see [bluelinky#80](https://github.com/Hacksore/bluelinky/issues/80) and their [API Rate Limits](https://github.com/Hacksore/bluelinky/wiki/API-Rate-Limits) notes), so it is worth avoiding unnecessary requests regardless.

### Vehicle Auto-Relock

If a remote unlock is followed by the doors relocking a short time later without anything being sent, that is normally the vehicle's own security behavior - many Hyundais automatically relock if no door is opened within about 30 seconds of a remote unlock. Every command this plugin sends is logged before it goes out (`Locking Vehicle`, `Unlocking Vehicle`, and so on), so the log will show whether a relock actually came from Homebridge.
