# Homebridge Hyundai Bluelink

[![npm version](https://badge.fury.io/js/homebridge-bluelink-3-0.svg)](https://www.npmjs.com/package/homebridge-bluelink-3-0)
[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://homebridge.io)

A [Homebridge](https://homebridge.io) plugin that connects your Hyundai or Kia to HomeKit, so you can lock, unlock, and remote start from the Home app or Siri.

**Install:** [homebridge-bluelink-3-0 on npm](https://www.npmjs.com/package/homebridge-bluelink-3-0) · current version **2.4.0**

## Credits

* [athal7/homebridge-hyundai-bluelink](https://github.com/athal7/homebridge-hyundai-bluelink) — the original plugin this is forked from.
* [Hacksore/bluelinky](https://github.com/Hacksore/bluelinky) — the Bluelink/UVO API library this is built on.
* [Hyundai-Kia-Connect/hyundai_kia_connect_api](https://github.com/Hyundai-Kia-Connect/hyundai_kia_connect_api) — the actively maintained Python implementation. Comparing against its `HyundaiBlueLinkApiUSA.py` is what identified the fixes below.

## Installation

1. In the [Homebridge](https://homebridge.io) UI, open the **Plugins** tab
2. Search for `homebridge-bluelink-3-0` and install it
3. Configure it in the UI, or in `config.json` as below

## Configuration

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

* `vehicles.maxRange` is optional
* `remoteStart.airCtrl` turns on the HVAC; `airTempvalue` is in Fahrenheit
* `remoteStart.igniOnDuration` must be 1–10, or remote start fails

### Keeping status current

Two optional settings control polling:

| Setting | Default | What it does |
| --- | --- | --- |
| `statusInterval` | `15` min | Reads Hyundai's **cached** status. Never contacts the car, so it costs no battery. Min 5. |
| `forceRefreshInterval` | `0` (off) | **Wakes the car** over cellular for a live reading. Uses its 12V battery and counts against Hyundai's daily limits. Min 60 when enabled. |

If HomeKit lags behind the Bluelink app, lower `statusInterval` — not the other one. The car reports to Hyundai on its own whenever something happens to it (fob, doors, ignition), so the fresh data is usually already sitting in the cache waiting to be read. Forced refreshes are rarely worth their cost; leave them off unless you specifically need readings from a car that's been parked untouched for a long time.

Failed requests back off exponentially up to an hour, so an outage doesn't turn into a retry storm.

## What's Fixed in 2.4.0

Verified on a 2026 Sonata Hybrid with Homebridge v2.

| Bug | Fix |
| --- | --- |
| **Remote commands silently did nothing** on newer US vehicles. Hyundai returned `200` with a transaction id that stayed `PENDING` forever. bluelinky guesses the car's telematics generation as `modelYear > 2016 ? '2' : '1'` — a rule from when gen 2 was current — so recent cars (gen 3 / `ccNC`) get commands queued to a generation they never answer on. Status reads don't use dispatch, so they kept working and the plugin looked healthy. | Read the real `vehicleGeneration` from Hyundai's enrollment details. Commands now confirm in ~20s. bluelinky's Canadian controller already reads the real value; only the US path guesses. |
| **Success was reported when Hyundai *accepted* a request**, not when the car acted on it. | Follow the transaction via `rmt/getRunningStatus` until the vehicle reports `SUCCESS` or `ERROR`. |
| **HomeKit always showed "No Response"** — it waits ~10s, far less than a car takes to act. | Acknowledge on acceptance and confirm in the background. |
| **Locks span "Unlocking…" forever** when a command didn't take. | Settle the target state onto what the vehicle actually reports. |
| **A leaked `setInterval`** on every lock/unlock polled the API once a minute forever (intended: hourly). | Use a single cleared timeout. |
| **Credentials were written to the log in plaintext**, including the PIN that authorizes remote commands. | Redacted. |
| **Crashes on current Homebridge/Node**: `BatteryService` was renamed, and property initializer order broke under newer TypeScript targets. | Updated for Homebridge v2 and Node 20. |
| **UTC offset hardcoded to `-5`.** | Computed from the local clock. |

Other regions (CA/EU) are unchanged and still use bluelinky's built-in methods.

## Known Issues

**Status refresh delay** — per Hyundai's [rate limits](https://github.com/Hacksore/bluelinky/wiki/API-Rate-Limits), status updates hourly. Changes made elsewhere (Bluelink app, key fob) may take up to an hour to appear.

**One request at a time** — Hyundai tracks a single outstanding remote request per vehicle; while one is queued the official app reports `[HT_533] a previous request is pending`. A forced status refresh is itself a remote request, so it can't be used to confirm a command that's still in flight.

**Auto-relock** — many Hyundais relock automatically if no door is opened within ~30s of a remote unlock. Every command this plugin sends is logged first, so the log shows whether a relock came from Homebridge.

**SSL key too small** — if you see `dh key too small`, edit `/etc/ssl/openssl.cnf` and change `CipherString = DEFAULT@SECLEVEL=2` to `SECLEVEL=1` ([source](https://github.com/FreshRSS/FreshRSS/issues/3029)).

---

Developed with [Claude Code](https://claude.com/claude-code).
