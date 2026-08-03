import { VehicleStatus } from 'bluelinky/dist/interfaces/common.interfaces';
import { Vehicle } from 'bluelinky/dist/vehicles/vehicle';
import { EventEmitter } from 'events';
import { PlatformAccessory } from 'homebridge';

import { HyundaiConfig } from './config';
import { HyundaiPlatform } from './platform';
import initServices from './services';

// Two very different reads share one endpoint:
//
//   REFRESH: false  reads Hyundai's server-side cache. It never contacts the
//                   vehicle, so it costs no 12V battery and is quick. The
//                   vehicle reports in on its own whenever something happens
//                   to it, so the cache is usually fresh well before we ask.
//
//   REFRESH: true   wakes the telematics unit over cellular. It drains the
//                   12V battery, takes 20-60s, and counts against Hyundai's
//                   daily remote-request limits.
//
// So poll the cache often enough for HomeKit to keep up, and force a real
// refresh rarely or never. Polling the cache hourly - as this used to - is
// what made HomeKit lag behind the Bluelink app: the data was already there,
// nobody was reading it.
const DEFAULT_STATUS_INTERVAL_MIN = 15;
const MIN_STATUS_INTERVAL_MIN = 5;
// Forced refreshes are off unless asked for, and are floored well above the
// cached interval so they cannot be turned into a battery drain by accident.
const DEFAULT_FORCE_REFRESH_INTERVAL_MIN = 0;
const MIN_FORCE_REFRESH_INTERVAL_MIN = 60;

// If Hyundai is erroring, back off rather than keeping to the schedule -
// doubling up to an hour, reset by the first success.
const INITIAL_BACKOFF_MS = 1000 * 60;
const MAX_BACKOFF_MS = 1000 * 60 * 60;

export class VehicleAccessory extends EventEmitter {
  private isFetching = false;
  private backoffUntil = 0;
  private backoffMs = 0;

  constructor(
    public readonly platform: HyundaiPlatform,
    public readonly accessory: PlatformAccessory,
    public readonly vehicle: Vehicle,
  ) {
    super();
    this.setInformation();
    initServices(this);
    this.fetchStatus();
    this.schedulePolling();
  }

  private schedulePolling(): void {
    const config = <HyundaiConfig>this.platform.config;

    const statusMinutes = Math.max(
      MIN_STATUS_INTERVAL_MIN,
      config.statusInterval ?? DEFAULT_STATUS_INTERVAL_MIN,
    );
    this.platform.log.debug(
      `Reading cached status every ${statusMinutes} minutes`,
    );
    const cachedTimer = setInterval(
      () => this.fetchStatus(false),
      statusMinutes * 60 * 1000,
    );

    const forceMinutes =
      config.forceRefreshInterval ?? DEFAULT_FORCE_REFRESH_INTERVAL_MIN;
    let forceTimer: NodeJS.Timeout | undefined;
    if (forceMinutes > 0) {
      const minutes = Math.max(MIN_FORCE_REFRESH_INTERVAL_MIN, forceMinutes);
      this.platform.log.info(
        `Forcing a live vehicle refresh every ${minutes} minutes. This wakes ` +
          'the car and uses its 12V battery - cached reads alone are enough ' +
          'for most setups.',
      );
      forceTimer = setInterval(
        () => this.fetchStatus(true),
        minutes * 60 * 1000,
      );
    }

    // Don't hold Homebridge open on these when it is shutting down.
    cachedTimer.unref?.();
    forceTimer?.unref?.();
  }

  fetchStatus(force = false): void {
    if (this.isFetching) {
      return;
    }
    if (Date.now() < this.backoffUntil) {
      this.platform.log.debug(
        'Skipping status fetch, backing off after errors',
      );
      return;
    }

    this.isFetching = true;
    this.vehicle
      .status({ refresh: force, parsed: true })
      .then(response => {
        this.platform.log.debug('Received status update', response);
        this.backoffMs = 0;
        this.backoffUntil = 0;
        this.emit('update', <VehicleStatus>response);
      })
      .catch(error => {
        this.backoffMs = this.backoffMs
          ? Math.min(this.backoffMs * 2, MAX_BACKOFF_MS)
          : INITIAL_BACKOFF_MS;
        this.backoffUntil = Date.now() + this.backoffMs;
        this.platform.log.error(
          `Status fetch error, retrying in ${Math.round(
            this.backoffMs / 1000,
          )}s`,
          error,
        );
      })
      .finally(() => {
        this.isFetching = false;
      });
  }

  setInformation(): void {
    this.accessory
      ?.getService(this.platform.Service.AccessoryInformation)
      ?.setCharacteristic(this.platform.Characteristic.Manufacturer, 'Hyundai')
      .setCharacteristic(
        this.platform.Characteristic.Model,
        this.accessory.context.device.name,
      )
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        this.accessory.context.device.vin,
      );
  }
}
